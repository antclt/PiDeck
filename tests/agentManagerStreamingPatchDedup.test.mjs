import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 流式状态补丁去重（discussion #446）。
 *
 * 正文通道每 100ms flush 一次都会补一条 agents:runtime-state，但 isStreaming / 工具
 * 状态在两个边沿之间不变。几百个并发流式会话时，这些同值补丁独占一档 IPC 流量；
 * 这里锁住「同值不发、状态变化照发、agent 清理时释放签名」。
 */
const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

function createManager() {
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{},
	);
	const runtime = {
		tab: {
			id: "agent-live",
			projectId: "project-1",
			cwd: "C:/project",
			title: "Session",
			status: "running",
			deckSessionId: "deck-session-1",
			sessionPath: "C:/project/.pi/sessions/xxx.jsonl",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		},
		process: { client: { request: async () => ({ success: true, data: {} }) } },
	};
	manager.agents.set("agent-live", runtime);
	const emitted = [];
	manager.onOutput((channel, payload) => emitted.push({ channel, payload }));
	return { manager, emitted };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function textDelta(text) {
	return {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: text },
		message: { role: "assistant", content: [{ type: "text", text }] },
	};
}

test("同值流式状态补丁只发一次，正文照样每次 flush 更新", async () => {
	const { manager, emitted } = createManager();
	manager.handlePiEvent("agent-live", {
		type: "message_start",
		message: { role: "assistant", content: [{ type: "text", text: "" }] },
	});
	manager.handlePiEvent("agent-live", textDelta("hello"));
	await sleep(150);
	const patchesAfterFirst = emitted.filter((event) => event.channel === "agents:runtime-state");
	assert.equal(patchesAfterFirst.length, 1, "第一次 flush 必须带出 isStreaming=true 的补丁");
	assert.equal(patchesAfterFirst[0].payload.state.isStreaming, true);

	// 同一个流式状态再 flush 一次：正文事件照发，补丁同值跳过。
	manager.handlePiEvent("agent-live", textDelta("hello world"));
	await sleep(150);
	assert.equal(emitted.filter((event) => event.channel === "agents:text-stream").length, 2);
	assert.equal(emitted.filter((event) => event.channel === "agents:runtime-state").length, 1, "同值补丁不得重复跨进程");
});

test("状态真变化时补丁照发（工具执行标志进入签名）", async () => {
	const { manager, emitted } = createManager();
	manager.handlePiEvent("agent-live", {
		type: "message_start",
		message: { role: "assistant", content: [{ type: "text", text: "" }] },
	});
	manager.handlePiEvent("agent-live", textDelta("hello"));
	await sleep(150);
	// 直接改工具状态并触发下一次 flush：签名必须变化，渲染层才能收到工具名。
	manager.toolExecutingByAgent.set("agent-live", "bash");
	manager.handlePiEvent("agent-live", textDelta("hello world"));
	await sleep(150);
	const patches = emitted.filter((event) => event.channel === "agents:runtime-state");
	assert.equal(patches.length, 2);
	assert.equal(patches[1].payload.state.executingToolName, "bash");
	assert.equal(patches[1].payload.state.isExecutingTool, true);
});

test("可见性补帧：emitLiveSnapshot 强制全量，后续增量以补帧为基准", async () => {
	const { manager, emitted } = createManager();
	manager.handlePiEvent("agent-live", {
		type: "message_start",
		message: { role: "assistant", content: [{ type: "text", text: "" }] },
	});
	manager.handlePiEvent("agent-live", textDelta("hello"));
	await sleep(150);
	// 后台期间渲染层收不到增量：切到前台时必须整段补发（text 字段），不能发 delta。
	const before = emitted.filter((event) => event.channel === "agents:text-stream").length;
	manager.emitLiveSnapshot("agent-live");
	const snapshotEvents = emitted.filter((event) => event.channel === "agents:text-stream").slice(before);
	assert.equal(snapshotEvents.length, 1);
	assert.equal(snapshotEvents[0].payload.text, "hello");
	assert.equal(snapshotEvents[0].payload.delta, undefined);

	// 补帧同时重置增量基准：下一次 flush 只发新增字符，不会重复整段。
	manager.handlePiEvent("agent-live", textDelta("hello world"));
	await sleep(150);
	const nextEvents = emitted.filter((event) => event.channel === "agents:text-stream").slice(before + 1);
	assert.equal(nextEvents.at(-1).payload.delta, " world");
});

test("同值补丁 5s 心跳：渲染层 reload 后状态指示能自愈", async () => {
	const { manager, emitted } = createManager();
	manager.handlePiEvent("agent-live", {
		type: "message_start",
		message: { role: "assistant", content: [{ type: "text", text: "" }] },
	});
	manager.handlePiEvent("agent-live", textDelta("hello"));
	await sleep(150);
	assert.equal(emitted.filter((event) => event.channel === "agents:runtime-state").length, 1);
	// 把上次发送时间推到心跳窗口之外：下一次同值 flush 必须重发，而不是永远省掉。
	manager.lastStreamingPatchByAgent.set("agent-live", { signature: JSON.stringify([true, null, 0]), at: 0 });
	manager.handlePiEvent("agent-live", textDelta("hello world"));
	await sleep(150);
	assert.equal(emitted.filter((event) => event.channel === "agents:runtime-state").length, 2);
});

test("agent 清理时释放补丁签名（防 Map 随会话数增长）", () => {
	const { manager } = createManager();
	manager.handlePiEvent("agent-live", {
		type: "message_start",
		message: { role: "assistant", content: [{ type: "text", text: "" }] },
	});
	manager.lastStreamingPatchByAgent.set("agent-live", { signature: "s", at: Date.now() });
	manager.clearAgentState("agent-live");
	assert.equal(manager.lastStreamingPatchByAgent.has("agent-live"), false);
});
