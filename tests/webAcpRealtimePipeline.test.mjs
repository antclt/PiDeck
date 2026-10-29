/**
 * 端到端：真 AcpAgentManager → onOutput 通道 → WebEventStreamRouter → SSE 帧。
 *
 * 为什么单开一层：`webAcpChannelStream.test.mjs` 手喂快照，只证明翻译器与路由器各自的契约；
 * 真实链路里还有 80ms 合流（AcpUpdatePipeline.flushMessages 节流）、`users`/`tool_call`
 * 投影时序、以及「先 flush 快照、后发 runtime-state」的结算顺序。Web 端「ACP 会话没有实时
 * 渲染和返回」正是这一整条链的问题，必须用真 manager + 真传输验证，否则接线漏一处也全绿。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { harness, sessionUpdate, waitFor } from "./helpers/acpAgentHarness.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { WebEventStreamRouter } = loadTsCommonJs("src/main/web/WebEventStream.ts");

const SESSION_ID = "session-1";
const ACP_SESSION = "sess-1";

/** 收集一条 SSE 连接写出的帧；`[DONE]` 归一成 `{type:"[DONE]"}` 便于断言顺序。 */
function collector() {
	const frames = [];
	const wire = [];
	const writeRaw = (chunk) => {
		wire.push(chunk);
		for (const line of chunk.split("\n")) {
			if (!line.startsWith("data: ")) continue;
			const data = line.slice(6).trim();
			if (!data) continue;
			frames.push(data === "[DONE]" ? { type: "[DONE]" } : JSON.parse(data));
		}
		return true;
	};
	return { frames, wire, writeRaw };
}

/** 与 src/main/index.ts 同形的订阅包装：只转发带 agentId 的通道事件（agentsState 是数组，天然被过滤）。 */
function wireRouter(manager, agentId) {
	const router = new WebEventStreamRouter((id) => (id === agentId ? SESSION_ID : undefined));
	router.bindAcpChannelSource((handler) =>
		manager.onOutput((channel, payload) => {
			const id = payload && typeof payload === "object" && "agentId" in payload ? payload.agentId : undefined;
			if (typeof id !== "string") return;
			handler(id, channel, payload);
		}),
	);
	return router;
}

/** 标准假 CLI：initialize / session/new 正常应答，session/prompt 挂起由用例手动推流与结算。 */
function pendingPromptHarness(t) {
	const seen = { promptRpcId: null };
	const rest = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: ACP_SESSION };
			if (frame.method === "session/prompt") {
				seen.promptRpcId = frame.id;
				return undefined;
			}
			return {};
		},
	});
	return { ...rest, seen };
}

test("端到端：ACP 回合进行中正文就上屏（不必等回合结束才见字）", async (t) => {
	const { manager, createAgent, lastProc, seen } = pendingPromptHarness(t);
	const tab = await createAgent();
	const router = wireRouter(manager, tab.id);
	const stream = collector();
	const close = router.add(SESSION_ID, stream.writeRaw, () => {}, undefined, { keepAlive: true });
	t.after(() => close());

	const sendPromise = manager.sendPrompt({ agentId: tab.id, message: "看看这个仓库" });
	await waitFor(() => seen.promptRpcId !== null, "session/prompt dispatched");
	const cli = lastProc();
	sessionUpdate(cli.writeFromCli, ACP_SESSION, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "我先看" } });
	sessionUpdate(cli.writeFromCli, ACP_SESSION, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "一下目录。" } });

	// 关键断言：回合还没结算（没有 finish），正文已经到了浏览器侧。
	await waitFor(() => stream.frames.some((frame) => frame.type === "text-delta" && String(frame.delta ?? "").includes("我先看")), "text-delta 实时上屏");
	const textSoFar = stream.frames
		.filter((frame) => frame.type === "text-delta")
		.map((frame) => String(frame.delta ?? ""))
		.join("");
	assert.equal(textSoFar.includes("我先看"), true);
	assert.equal(
		stream.frames.some((frame) => frame.type === "finish"),
		false,
		"回合未结束前不能收口，否则前端会把进行中的回复当最终答案",
	);

	// 工具卡同样要实时：ACP 的工具调用是快照差分，卡在 running 时也要能看到输入。
	sessionUpdate(cli.writeFromCli, ACP_SESSION, { sessionUpdate: "tool_call", toolCallId: "call_1", title: "读取 a.ts", kind: "read", status: "in_progress", rawInput: { path: "a.ts" } });
	await waitFor(() => stream.frames.some((frame) => frame.type === "tool-input-available" && frame.toolCallId === "call_1"), "工具输入实时上屏");

	sessionUpdate(cli.writeFromCli, ACP_SESSION, { sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed", rawOutput: "file body" });
	await waitFor(() => stream.frames.some((frame) => frame.type === "tool-output-available" && frame.toolCallId === "call_1"), "工具结果实时上屏");

	// 结算：先 flush 快照（含 stopReason），再发 runtime-state（isStreaming 翻 false）→ 只有后者收口。
	cli.writeFromCli({ jsonrpc: "2.0", id: seen.promptRpcId, result: { stopReason: "end_turn" } });
	const result = await sendPromise;
	assert.equal(result.accepted, true);
	await waitFor(() => stream.frames.some((frame) => frame.type === "finish"), "结算后有 finish");

	const finishIndex = stream.frames.findIndex((frame) => frame.type === "finish");
	const doneIndex = stream.frames.findIndex((frame) => frame.type === "[DONE]");
	assert.ok(doneIndex > finishIndex, "finish 帧后必须跟 [DONE]，前端据此关闭本轮");
	assert.equal(await manager.getRuntimeState(tab.id).then((state) => state.isTurnActive), false);
});

test("端到端：第二轮回复不会被上一轮的游标吞掉（翻译器跨回合保留）", async (t) => {
	const { manager, createAgent, lastProc, seen } = pendingPromptHarness(t);
	const tab = await createAgent();
	const router = wireRouter(manager, tab.id);
	const stream = collector();
	const close = router.add(SESSION_ID, stream.writeRaw, () => {}, undefined, { keepAlive: true });
	t.after(() => close());

	const first = manager.sendPrompt({ agentId: tab.id, message: "第一问" });
	await waitFor(() => seen.promptRpcId !== null, "第一轮 dispatched");
	const cli = lastProc();
	sessionUpdate(cli.writeFromCli, ACP_SESSION, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第一答" } });
	await waitFor(() => stream.frames.some((frame) => frame.type === "text-delta"), "第一轮流式");
	cli.writeFromCli({ jsonrpc: "2.0", id: seen.promptRpcId, result: { stopReason: "end_turn" } });
	await first;
	await waitFor(() => stream.frames.some((frame) => frame.type === "finish"), "第一轮收口");

	seen.promptRpcId = null;
	const second = manager.sendPrompt({ agentId: tab.id, message: "第二问" });
	await waitFor(() => seen.promptRpcId !== null, "第二轮 dispatched");
	sessionUpdate(cli.writeFromCli, ACP_SESSION, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第二答" } });
	await waitFor(() => stream.frames.filter((frame) => frame.type === "text-delta").some((frame) => String(frame.delta ?? "").includes("第二答")), "第二轮也要有增量");
	cli.writeFromCli({ jsonrpc: "2.0", id: seen.promptRpcId, result: { stopReason: "end_turn" } });
	await second;
	await waitFor(() => stream.frames.filter((frame) => frame.type === "finish").length >= 2, "第二轮收口");

	// 每轮一条 UI 消息：第二轮必须重新 start（而不是接在上一轮的 text 块里）。
	const startCount = stream.frames.filter((frame) => frame.type === "start").length;
	assert.equal(startCount, 2, "每个回合一条 UI 消息");
});
