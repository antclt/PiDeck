/** ACP cancellation and process cleanup must settle the current runtime without reviving stale output. */
import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { setTimeout as sleep } from "node:timers/promises";
import { harness, sessionUpdate, waitFor } from "./helpers/acpAgentHarness.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function basicHandler(frame) {
	if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
	if (frame.method === "session/new") return { sessionId: "session-1" };
	return undefined;
}

/** 物化用例需要 agent 声明图片能力（sendPrompt 的图片块按 promptCapabilities.image 门控）。 */
function imageCapableHandler(frame) {
	if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } };
	return basicHandler(frame);
}

function imageGate() {
	let release;
	let started = false;
	const pending = new Promise((resolve) => {
		release = resolve;
	});
	return {
		imageStore: {
			put: async () => {
				started = true;
				return pending;
			},
		},
		release,
		started: () => started,
	};
}

test("abort during local image materialization does not dispatch a new prompt after cancel", async (t) => {
	const gate = imageGate();
	const { manager, createAgent, lastProc } = harness(t, { handler: imageCapableHandler }, { imageStore: gate.imageStore, promptTurnTimeoutMs: 40 });
	const tab = await createAgent();
	const sending = manager.sendPrompt({ agentId: tab.id, message: "Question", images: [{ type: "image", data: "picture", mimeType: "image/png" }] });
	await waitFor(gate.started, "image materialization");
	await manager.abort(tab.id);
	gate.release("image-ref");
	await sending;
	assert.equal(lastProc().methodFrames("session/prompt").length, 0, "cancel must not be followed by the prompt it was meant to stop");
	assert.equal(manager.readMessages(tab.id)[0].images[0].ref, "image-ref");
	assert.equal((await manager.getRuntimeState(tab.id)).isTurnActive, false);
});

test("prompt rejection cancels every pending permission without waiting for its timeout", async (t) => {
	const { manager, createAgent, events, lastProc } = harness(t, { handler: basicHandler });
	const tab = await createAgent();
	const sending = manager.sendPrompt({ agentId: tab.id, message: "Question" });
	await waitFor(() => lastProc().methodFrames("session/prompt").length === 1);
	lastProc().writeFromCli({ jsonrpc: "2.0", id: "approval", method: "session/request_permission", params: { sessionId: "session-1", toolCall: { toolCallId: "call" }, options: [{ optionId: "once", name: "Allow", kind: "allow_once" }] } });
	await waitFor(() => events.uiRequests.some((event) => event.method === "select"));
	const request = events.uiRequests.find((event) => event.method === "select");
	lastProc().writeFromCli({ jsonrpc: "2.0", id: lastProc().methodFrames("session/prompt")[0].id, error: { code: -32603, message: "turn failed" } });
	assert.equal((await sending).accepted, false);
	assert.deepEqual(lastProc().frames.find((frame) => frame.id === "approval")?.result, { outcome: { outcome: "cancelled" } });
	assert.equal(events.uiRequests.filter((event) => event.completed && event.requestId === request.requestId).length, 1);
	assert.equal((await manager.sendUIResponse(tab.id, request.requestId, { type: "select", value: "Allow" })).accepted, false);
});

test("stopping a runtime while materialization is pending suppresses late timeline flushes", async (t) => {
	const gate = imageGate();
	const { manager, createAgent, events, lastProc } = harness(t, { handler: imageCapableHandler }, { imageStore: gate.imageStore });
	const tab = await createAgent();
	const sending = manager.sendPrompt({ agentId: tab.id, message: "Question", images: [{ type: "image", data: "picture", mimeType: "image/png" }] });
	await waitFor(gate.started, "image materialization");
	await manager.stop(tab.id);
	const count = events.messages.length;
	gate.release("image-ref");
	assert.equal((await sending).accepted, false);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(events.messages.length, count, "the removed runtime must never republish its cached messages");
	assert.equal(lastProc().methodFrames("session/prompt").length, 0);
	assert.equal(manager.list().length, 0);
});

test("process exit waits for trailing stdout frames instead of rejecting a completed prompt", async (t) => {
	const { manager, createAgent, lastProc } = harness(t, { handler: basicHandler });
	const tab = await createAgent();
	const sending = manager.sendPrompt({ agentId: tab.id, message: "Question" });
	await waitFor(() => lastProc().methodFrames("session/prompt").length === 1);
	const cli = lastProc();
	sessionUpdate(cli.writeFromCli, "session-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(300_000) } });
	cli.proc.exitCode = 0;
	cli.proc.emit("exit", 0, null);
	cli.writeFromCli({ jsonrpc: "2.0", id: cli.methodFrames("session/prompt")[0].id, result: { stopReason: "end_turn" } });
	cli.proc.stdout.end();
	assert.equal((await sending).accepted, true, "Node exit precedes stdout drain, so its final response is still deliverable");
	assert.equal(manager.readMessages(tab.id).at(-1).text.length, 300_000);
	assert.equal(manager.readMessages(tab.id).at(-1).stopReason, "stop");
});

test("standard ACP state payload merges into the canonical session atoms without leaking to another session", async (t) => {
	const atoms = loadTsCommonJs("src/renderer/src/atoms/index.ts");
	const store = createStore();
	const { manager, createAgent, events, lastProc } = harness(t, { handler: basicHandler });
	const tab = await createAgent();
	const session = (id) => ({ id, projectId: "p1", title: id, environment: "native", source: "pi", backend: "acp", createdAt: 1, updatedAt: 1 });
	store.set(atoms.replaceProjectSessionsAtom, { projectId: "p1", sessions: [session("deck-1"), session("deck-2")] });
	store.set(atoms.replaceSessionRuntimesAtom, [{ sessionId: "deck-1", agentId: tab.id, runtimeGeneration: 1, projectId: "p1", cwd: "D:/proj-p1", status: "idle", createdAt: 1 }]);
	sessionUpdate(lastProc().writeFromCli, "session-1", { sessionUpdate: "plan", entries: [{ content: "Inspect", priority: "medium", status: "pending" }] });
	await waitFor(() => events.runtimeStates.at(-1)?.state?.todos?.length === 1);
	for (const payload of events.runtimeStates) store.set(atoms.applySessionRuntimeEventAtom, { kind: "event", sessionId: "deck-1", agentId: tab.id, runtimeGeneration: 1, sourceChannel: "agents:runtime-state", payload });
	const state = store.get(atoms.sessionRuntimeByIdAtom)["deck-1"].state;
	assert.equal(state.todos[0].content, "Inspect");
	assert.equal(state.modelName, "Gemini CLI");
	assert.equal(state.isTurnActive, false);
	assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["deck-2"], undefined);
});

// 挂起审批是 agent 在等用户，不是卡死：回合兑底截止在审批期间必须持续顺延
// （否则用户离开键盘超过兑底时长，回到页面时回合已因「超时」被掐，而这与实测报告的体验完全背离）。
test("a pending approval keeps the turn alive past the turn timeout", async (t) => {
	const { manager, createAgent, events, lastProc } = harness(t, { handler: basicHandler }, { promptTurnTimeoutMs: 1_200, promptStallTimeoutMs: 600 });
	const tab = await createAgent();
	const sending = manager.sendPrompt({ agentId: tab.id, message: "Question" });
	await waitFor(() => lastProc().methodFrames("session/prompt").length === 1);
	const cli = lastProc();
	cli.writeFromCli({ jsonrpc: "2.0", id: "approval", method: "session/request_permission", params: { sessionId: "session-1", toolCall: { toolCallId: "call" }, options: [{ optionId: "once", name: "Allow", kind: "allow_once" }] } });
	await waitFor(() => events.uiRequests.some((event) => event.method === "select"));
	await sleep(1_500);
	assert.equal((await manager.getRuntimeState(tab.id)).isTurnActive, true, "waiting on the user must not be mistaken for a wedged turn");
	const request = events.uiRequests.find((event) => event.method === "select");
	assert.equal((await manager.sendUIResponse(tab.id, request.requestId, { type: "select", value: "Allow" })).accepted, true);
	// 作答后继续产出：静默基准必须在审批期间被刷新，否则超过 stall 阈值才作答时
	// 下一 tick 会立刻判 stall 并取消回合（存量隐患，与本次放宽同属「审批是合法等待」）。
	sessionUpdate(cli.writeFromCli, "session-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "running the approved tool" } });
	cli.writeFromCli({ jsonrpc: "2.0", id: cli.methodFrames("session/prompt")[0].id, result: { stopReason: "end_turn" } });
	const result = await sending;
	assert.equal(result.accepted, true, `approval wait must not fail the turn: ${JSON.stringify(result)}`);
});

// 实测故障的直接回归：#414 的回合兑底超时旧口径是「单回合总时长硬上限」，把连续产出 10 分钟的
// 健康长回合在墙钟到点时砍断（归档里该回合有 283 条 session/update，一直流到最后）。
// 新口径是「无进展静默上限」：回合内有产出就顺延截止。
test("a turn that keeps streaming updates outlives the configured turn timeout", async (t) => {
	const { manager, createAgent, lastProc } = harness(t, { handler: basicHandler }, { promptTurnTimeoutMs: 80, promptStallTimeoutMs: 5_000 });
	const tab = await createAgent();
	const sending = manager.sendPrompt({ agentId: tab.id, message: "Long task" });
	await waitFor(() => lastProc().methodFrames("session/prompt").length === 1);
	const cli = lastProc();
	// 80ms 上限下持续产出 6 × 30ms = 180ms，仍在原截止之后才收口。
	for (let i = 0; i < 6; i += 1) {
		await sleep(30);
		sessionUpdate(cli.writeFromCli, "session-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `chunk ${i} ` } });
	}
	cli.writeFromCli({ jsonrpc: "2.0", id: cli.methodFrames("session/prompt")[0].id, result: { stopReason: "end_turn" } });
	const result = await sending;
	assert.equal(result.accepted, true, `a streaming turn must not be killed by the deadline: ${JSON.stringify(result)}`);
	assert.match(manager.readMessages(tab.id).at(-1).text, /chunk 5/);
});

test("a turn that goes silent after progress still hits the turn timeout", async (t) => {
	const { manager, createAgent, lastProc } = harness(t, { handler: basicHandler }, { promptTurnTimeoutMs: 90, promptStallTimeoutMs: 5_000 });
	const tab = await createAgent();
	const sending = manager.sendPrompt({ agentId: tab.id, message: "Question" });
	await waitFor(() => lastProc().methodFrames("session/prompt").length === 1);
	const cli = lastProc();
	sessionUpdate(cli.writeFromCli, "session-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } });
	const result = await sending;
	assert.equal(result.accepted, false, "a wedged CLI must still be collected by the turn deadline");
	assert.equal(result.i18nKey, "acp.turnTimeout");
	assert.equal(result.delivery, "unknown");
	// 超时后补发 session/cancel 收口，且旧回合的滚动句柄已清空（不会被下一个回合复用）。
	assert.equal(cli.methodFrames("session/cancel").length, 1);
	assert.equal((await manager.getRuntimeState(tab.id)).isTurnActive, false);
});
