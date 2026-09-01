import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

/**
 * ask_question 工具耗时排除用户等待时长（exclude_wait）的回归测试。
 *
 * 背景：ask_question 从 tool_execution_start 到用户回答之间的整段时间都被算进
 * durationMs（旧行为 = 等待秒表一直累加）。用户反馈「时间不应该一直累加」。
 * 修复：settleAskWait 在回答/超时/abort 时结算「提问弹起 → 回答」的等待时长，
 * 累计到 askWaitMsByAgent；ask_question 工具结束时从 durationMs 中扣除并清零。
 * 本测试从公开行为断言：等待时长被扣、非 ask 工具不受影响、清空逻辑不泄漏。
 */

function createManager() {
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{},
	);
	const runtime = {
		tab: {
			id: "agent-1",
			projectId: "project-1",
			cwd: "C:/project",
			title: "Session",
			status: "running",
			sessionPath: "C:/project/.pi/sessions/xxx.jsonl",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		process: { client: { request: async () => ({ success: true, data: {} }) } },
	};
	manager.agents.set("agent-1", runtime);
	return manager;
}

/** 种子一条 10s 前开始的 ask_question 工具消息（startedAt 固定，便于断言）。 */
function seedAskToolMessage(manager, toolCallId = "ask-1", startedAtAgoMs = 10_000) {
	const startedAt = Date.now() - startedAtAgoMs;
	const msg = {
		id: "msg-ask-1",
		agentId: "agent-1",
		role: "tool",
		text: "",
		timestamp: startedAt,
		meta: { toolCallId, toolName: "ask_question", startedAt, status: "running" },
	};
	manager.messages.set("agent-1", [msg]);
	manager.toolMessageIds.set("agent-1", new Map([[toolCallId, msg.id]]));
	return startedAt;
}

test("settleAskWait 结算用户等待时长并累计到 askWaitMsByAgent", () => {
	const manager = createManager();
	const raisedAt = Date.now() - 3_000;
	manager.pendingUIRequests.set(
		"agent-1",
		new Map([["req-1", { method: "select", title: "继续？", raisedAt }]]),
	);

	manager.settleAskWait("agent-1", "req-1");

	const waitMs = manager.askWaitMsByAgent.get("agent-1") ?? 0;
	assert.ok(
		waitMs >= 3_000 && waitMs <= 3_100,
		`等待时长应约等于 raisedAt 距今（3s），实际 ${waitMs}ms`,
	);
});

test("ask_question 工具结束：durationMs 扣除等待时长且清零累计", () => {
	const manager = createManager();
	const startedAt = seedAskToolMessage(manager, "ask-1");
	// 用户等待了 6s（raisedAt → 回答）
	manager.askWaitMsByAgent.set("agent-1", 6_000);

	manager.upsertToolMessage(
		"agent-1",
		{
			toolName: "ask_question",
			toolCallId: "ask-1",
			result: { question: "继续？", answer: "yes" },
		},
		"done",
	);

	const list = manager.messages.get("agent-1") ?? [];
	const toolMsg = list[0];
	const elapsed = Date.now() - startedAt;
	assert.equal(toolMsg.meta.status, "done");
	assert.ok(
		// 总耗时（≈10s）扣 6s 等待 ≈ 4s
		toolMsg.meta.durationMs >= elapsed - 6_000 - 200 &&
			toolMsg.meta.durationMs <= elapsed - 6_000,
		`durationMs 应约等于 (now-startedAt)-wait=4s，实际 ${toolMsg.meta.durationMs}ms`,
	);
	assert.equal(
		manager.askWaitMsByAgent.has("agent-1"),
		false,
		"扣除后累计值应清零，防止泄漏到下一个工具",
	);
});

test("非 ask 工具不受等待累计影响，也不清空累计", () => {
	const manager = createManager();
	const startedAt = Date.now() - 10_000;
	manager.messages.set("agent-1", [
		{
			id: "msg-write-1",
			agentId: "agent-1",
			role: "tool",
			text: "",
			timestamp: startedAt,
			meta: { toolCallId: "write-1", toolName: "write", startedAt, status: "running" },
		},
	]);
	manager.toolMessageIds.set("agent-1", new Map([["write-1", "msg-write-1"]]));
	// 残留的等待累计（例如 abort 后未被 ask 工具 end 消耗）不应扣进 write 工具耗时
	manager.askWaitMsByAgent.set("agent-1", 6_000);

	manager.upsertToolMessage(
		"agent-1",
		{ toolName: "write", toolCallId: "write-1", result: "ok" },
		"done",
	);

	const toolMsg = manager.messages.get("agent-1")[0];
	const elapsed = Date.now() - startedAt;
	assert.ok(
		toolMsg.meta.durationMs >= elapsed - 200 && toolMsg.meta.durationMs <= elapsed,
		`非 ask 工具 durationMs 应保留全量耗时（≈10s），实际 ${toolMsg.meta.durationMs}ms`,
	);
	// 等待累计不被非 ask 工具消费，留待下一次 ask 工具或工具 start 时清空
	assert.equal(manager.askWaitMsByAgent.get("agent-1"), 6_000);
});
