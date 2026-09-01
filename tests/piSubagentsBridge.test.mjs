/**
 * pi-deck-subagents 桥接扩展 —— 快照累积器纯函数测试。
 *
 * 覆盖：created/started/completed/failed/steered 状态迁移、
 * 幂等性、未知事件忽略、字段缺失降级。
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ts = require("typescript");

function loadBridgeModule() {
	const source = readFileSync(
		join(__dirname, "..", "resources", "extensions", "pi-deck-subagents.ts"),
		"utf8",
	);
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {} };
	const fn = new Function("exports", outputText);
	fn(sandbox.exports);
	return sandbox.exports;
}

test("reduceSnapshot: created adds queued agent", () => {
	const { reduceSnapshot } = loadBridgeModule();
	const { state, changed } = reduceSnapshot(
		new Map(),
		"subagents:created",
		{ id: "agent-1", type: "Explore", description: "Find auth files" },
	);
	assert.equal(changed, true);
	assert.equal(state.size, 1);
	const agent = state.get("agent-1");
	assert.equal(agent?.id, "agent-1");
	assert.equal(agent?.type, "Explore");
	assert.equal(agent?.status, "queued");
});

test("reduceSnapshot: started transitions queued → running", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "code", description: "d" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:started", { id: "a1" });
	assert.equal(r.changed, true);
	assert.equal(r.state.get("a1")?.status, "running");
});

test("reduceSnapshot: completed transitions running → completed + carries toolUses/tokens", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "c", description: "d" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:started", { id: "a1" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:completed", {
		id: "a1", type: "c", description: "d", toolUses: 5, tokens: 300,
	});
	assert.equal(r.changed, true);
	const agent = r.state.get("a1");
	assert.equal(agent?.status, "completed");
	assert.equal(agent?.toolUses, 5);
	assert.equal(agent?.tokens, 300);
});

test("reduceSnapshot: failed transitions running → error", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "x", description: "d" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:started", { id: "a1" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:failed", { id: "a1" });
	assert.equal(r.changed, true);
	assert.equal(r.state.get("a1")?.status, "error");
});

test("reduceSnapshot: created is idempotent", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "e", description: "d" });
	assert.equal(r.changed, true);
	r = reduceSnapshot(r.state, "subagents:created", { id: "a1", type: "e", description: "d" });
	assert.equal(r.changed, false);
});

test("reduceSnapshot: terminal is idempotent", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "t", description: "d" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:started", { id: "a1" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:completed", { id: "a1" });
	assert.equal(r.changed, true);
	r = reduceSnapshot(r.state, "subagents:completed", { id: "a1" });
	assert.equal(r.changed, false);
});

test("reduceSnapshot: unknown event ignored", () => {
	const { reduceSnapshot } = loadBridgeModule();
	const { state, changed } = reduceSnapshot(new Map(), "unknown:event", {});
	assert.equal(changed, false);
	assert.equal(state.size, 0);
});

test("reduceSnapshot: missing id returns unchanged", () => {
	const { reduceSnapshot } = loadBridgeModule();
	const { state, changed } = reduceSnapshot(new Map(), "subagents:created", {});
	assert.equal(changed, false);
});

test("reduceSnapshot: started without prior created ignored", () => {
	const { reduceSnapshot } = loadBridgeModule();
	const { state, changed } = reduceSnapshot(new Map(), "subagents:started", { id: "ghost" });
	assert.equal(changed, false);
});

test("reduceSnapshot: steered transitions to steered state", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "s", description: "d" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:started", { id: "a1" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:steered", { id: "a1" });
	assert.equal(r.changed, true);
	assert.equal(r.state.get("a1")?.status, "steered");
});

test("reduceSnapshot: field defaults when missing", () => {
	const { reduceSnapshot } = loadBridgeModule();
	const { state } = reduceSnapshot(new Map(), "subagents:created", { id: "minimal" });
	const agent = state.get("minimal");
	assert.equal(agent?.type, "");
	assert.equal(agent?.description, "");
	assert.equal(agent?.toolUses, 0);
	assert.equal(agent?.tokens, 0);
});

test("reduceSnapshot: failed event honors payload status stopped", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "x", description: "d" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:started", { id: "a1" });
	state = r.state;
	// 插件 external stop：事件名 failed，但 payload 携带真实 status=stopped
	r = reduceSnapshot(state, "subagents:failed", { id: "a1", status: "stopped" });
	assert.equal(r.changed, true);
	assert.equal(r.state.get("a1")?.status, "stopped");
});

test("reduceSnapshot: completed event honors payload status steered", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "s", description: "d" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:started", { id: "a1" });
	state = r.state;
	// 插件 steered 完成：事件名 completed，但 payload 携带真实 status=steered，
	// 不得被折叠成 completed（绿勾）。
	r = reduceSnapshot(state, "subagents:completed", { id: "a1", status: "steered" });
	assert.equal(r.changed, true);
	assert.equal(r.state.get("a1")?.status, "steered");
});

test("reduceSnapshot: terminal event upserts when created/started were missed", () => {
	const { reduceSnapshot } = loadBridgeModule();
	// 桥接晚加载：created/started 事件已错过，只有终态事件携带完整字段
	const { state, changed } = reduceSnapshot(
		new Map(),
		"subagents:completed",
		{ id: "ghost", type: "Explore", description: "late", status: "completed", toolUses: 4, tokens: 200 },
	);
	assert.equal(changed, true);
	const agent = state.get("ghost");
	assert.equal(agent?.status, "completed");
	assert.equal(agent?.type, "Explore");
	assert.equal(agent?.toolUses, 4);
	assert.equal(agent?.tokens, 200);
});
test("reduceSnapshot: completed derives completedAt from durationMs payload", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "c", description: "d" });
	state = r.state;
	const startedAt = state.get("a1")?.startedAt;
	r = reduceSnapshot(state, "subagents:completed", {
		id: "a1", type: "c", description: "d", status: "completed", durationMs: 42000,
	});
	const agent = r.state.get("a1");
	assert.equal(agent?.status, "completed");
	// completedAt = startedAt + 插件真实时长 durationMs（消除 created 事件传播延迟误差）
	assert.equal(agent?.completedAt, startedAt + 42000);
});

test("reduceSnapshot: completed without durationMs falls back to event arrival time", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "c", description: "d" });
	state = r.state;
	const before = Date.now();
	r = reduceSnapshot(state, "subagents:completed", { id: "a1" });
	const after = Date.now();
	const agent = r.state.get("a1");
	assert.ok(agent?.completedAt !== undefined);
	assert.ok(agent.completedAt >= before && agent.completedAt <= after);
});

test("reduceSnapshot: terminal upsert without durationMs sets arrival-time completedAt", () => {
	const { reduceSnapshot } = loadBridgeModule();
	const before = Date.now();
	const { state } = reduceSnapshot(new Map(), "subagents:completed", {
		id: "ghost", type: "Explore", description: "late", status: "completed",
	});
	const after = Date.now();
	const agent = state.get("ghost");
	assert.ok(agent?.completedAt >= before && agent.completedAt <= after);
});

test("reduceSnapshot: completed carries truncated result/error preview", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "c", description: "d" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:started", { id: "a1" });
	state = r.state;
	const longText = "x".repeat(5000);
	r = reduceSnapshot(state, "subagents:completed", { id: "a1", status: "completed", result: longText });
	const agent = r.state.get("a1");
	assert.equal(agent?.status, "completed");
	// 面板预览截断 2000 字符，完整文本由 record 承载
	assert.equal(agent?.result?.length, 2000);
});

test("reduceSnapshot: failed carries error text to snapshot", () => {
	const { reduceSnapshot } = loadBridgeModule();
	let state = new Map();
	let r = reduceSnapshot(state, "subagents:created", { id: "a1", type: "x", description: "d" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:started", { id: "a1" });
	state = r.state;
	r = reduceSnapshot(state, "subagents:failed", { id: "a1", error: "boom: tool timeout" });
	const agent = r.state.get("a1");
	assert.equal(agent?.status, "error");
	assert.equal(agent?.error, "boom: tool timeout");
});

/** mock pi API：捕获事件订阅与 appendEntry 调用，驱动扩展默认导出的完整链路。 */
function createMockPi() {
	const handlers = new Map();
	// pi.on 生命周期事件（session_start / tool_execution_* / message_end 等）
	const lifecycle = new Map();
	const appendedEntries = [];
	return {
		pi: {
			events: { on: (name, cb) => { handlers.set(name, cb); } },
			on: (name, cb) => { lifecycle.set(name, cb); },
			appendEntry: (type, data) => { appendedEntries.push({ type, data }); },
		},
		handlers,
		lifecycle,
		appendedEntries,
	};
}

test("bridge extension: subagents:created persists pi-deck-subagent-start anchor", () => {
	const { default: bridge } = loadBridgeModule();
	const { pi, handlers, appendedEntries } = createMockPi();
	bridge(pi);

	// created 事件 → 快照入库 + start 锚点落盘（审计痕迹，防运行中被重启终止后消失）
	handlers.get("subagents:created")({ id: "agent-anchor1", type: "Explore", description: "find files" });

	assert.equal(appendedEntries.length, 1);
	assert.equal(appendedEntries[0].type, "pi-deck-subagent-start");
	assert.equal(appendedEntries[0].data.id, "agent-anchor1");
	assert.equal(appendedEntries[0].data.type, "Explore");
	assert.equal(appendedEntries[0].data.description, "find files");
	assert.equal(typeof appendedEntries[0].data.startedAt, "number");

	// 幂等 created（重复事件）不重复落盘
	handlers.get("subagents:created")({ id: "agent-anchor1", type: "Explore", description: "find files" });
	assert.equal(appendedEntries.length, 1);

	// 无 id 的 created 事件不落盘
	handlers.get("subagents:created")({ type: "code", description: "no id" });
	assert.equal(appendedEntries.length, 1);

	// 终态事件不写锚点（record 由插件侧负责）
	handlers.get("subagents:completed")({ id: "agent-anchor1", status: "completed", result: "ok" });
	assert.equal(appendedEntries.length, 1);
});

test("bridge extension: appendEntry throw does not break snapshot flow", () => {
	const { default: bridge } = loadBridgeModule();
	const handlers = new Map();
	const pi = {
		events: { on: (name, cb) => { handlers.set(name, cb); } },
		on: () => {},
		appendEntry: () => { throw new Error("session closed"); },
	};
	bridge(pi);

	// 持久化失败仅损失审计锚点：事件处理不抛错，后续事件继续工作
	handlers.get("subagents:created")({ id: "agent-throw1", type: "code", description: "d" });
	let threw = false;
	try {
		handlers.get("subagents:started")({ id: "agent-throw1" });
	} catch {
		threw = true;
	}
	assert.equal(threw, false);
});

/* ------------------------------------------------------------------ */
/* acp_delegate（billion-context-pi）桥接                               */
/* ------------------------------------------------------------------ */

const ACP_DISPATCH = "acp_delegate_111";
const ACP_RUN_ID = "del_abc123";

function acpDispatchEndEvent() {
	return {
		type: "tool_execution_end",
		toolCallId: ACP_DISPATCH,
		toolName: "acp_delegate",
		result: { content: [{ type: "text", text: `Delegated to **worker** (runId \`${ACP_RUN_ID}\`).\nRunning in the background.` }] },
		isError: false,
	};
}

test("reduceAcpToolEvent: start(acp_delegate) → running 条目（via 标记、幂等）", () => {
	const { reduceAcpToolEvent } = loadBridgeModule();
	const start = { type: "tool_execution_start", toolCallId: ACP_DISPATCH, toolName: "acp_delegate", args: { agent: "worker", task: "Generate md" } };
	const first = reduceAcpToolEvent(new Map(), new Map(), "tool_execution_start", start, 1000);
	assert.equal(first.changed, true);
	assert.equal(first.state.get(ACP_DISPATCH).status, "running");
	assert.equal(first.state.get(ACP_DISPATCH).via, "acp-delegate");
	assert.equal(first.state.get(ACP_DISPATCH).description, "Generate md");

	// 同 toolCallId 幂等
	const again = reduceAcpToolEvent(first.state, first.runIds, "tool_execution_start", start, 2000);
	assert.equal(again.changed, false);
	assert.equal(again.state.get(ACP_DISPATCH).startedAt, 1000);
});

test("reduceAcpToolEvent: end 从结果文本提取 runId（派发 ≠ 终态）", () => {
	const { reduceAcpToolEvent } = loadBridgeModule();
	const started = reduceAcpToolEvent(new Map(), new Map(), "tool_execution_start",
		{ type: "tool_execution_start", toolCallId: ACP_DISPATCH, toolName: "acp_delegate", args: { agent: "worker" } }, 1000);
	const ended = reduceAcpToolEvent(started.state, started.runIds, "tool_execution_end", acpDispatchEndEvent(), 1100);
	assert.equal(ended.changed, false); // 状态不变，widget 不重推
	assert.equal(ended.runIds.get(ACP_RUN_ID), ACP_DISPATCH);
	assert.equal(ended.state.get(ACP_DISPATCH).status, "running");
});

test("reduceAcpToolEvent: 取消按 runId 反查 → stopped", () => {
	const { reduceAcpToolEvent } = loadBridgeModule();
	const started = reduceAcpToolEvent(new Map(), new Map(), "tool_execution_start",
		{ type: "tool_execution_start", toolCallId: ACP_DISPATCH, toolName: "acp_delegate", args: { agent: "worker" } }, 1000);
	const dispatched = reduceAcpToolEvent(started.state, started.runIds, "tool_execution_end", acpDispatchEndEvent(), 1100);
	const cancelled = reduceAcpToolEvent(dispatched.state, dispatched.runIds, "tool_execution_start",
		{ type: "tool_execution_start", toolCallId: "acp_delegate_cancel_x", toolName: "acp_delegate_cancel", args: { runId: ACP_RUN_ID } }, 1200);
	assert.equal(cancelled.changed, true);
	assert.equal(cancelled.state.get(ACP_DISPATCH).status, "stopped");
	assert.equal(cancelled.state.get(ACP_DISPATCH).completedAt, 1200);
});

test("reduceAcpToolEvent: 非 acp 工具事件被忽略", () => {
	const { reduceAcpToolEvent } = loadBridgeModule();
	const result = reduceAcpToolEvent(new Map(), new Map(), "tool_execution_start",
		{ type: "tool_execution_start", toolCallId: "bash_1", toolName: "bash", args: { command: "ls" } }, 1000);
	assert.equal(result.changed, false);
	assert.equal(result.state.size, 0);
});

test("reduceAcpNotification: completed/FAILED 通知迁到终态并携带错误摘录", () => {
	const { reduceAcpToolEvent, reduceAcpNotification } = loadBridgeModule();
	const started = reduceAcpToolEvent(new Map(), new Map(), "tool_execution_start",
		{ type: "tool_execution_start", toolCallId: ACP_DISPATCH, toolName: "acp_delegate", args: { agent: "worker" } }, 1000);
	const dispatched = reduceAcpToolEvent(started.state, started.runIds, "tool_execution_end", acpDispatchEndEvent(), 1100);

	const completed = reduceAcpNotification(
		dispatched.state, dispatched.runIds,
		`[acp_delegate completed] **worker** (runId \`${ACP_RUN_ID}\`, exit 0) No delegates are currently running.`,
		2000,
	);
	assert.equal(completed.changed, true);
	assert.equal(completed.state.get(ACP_DISPATCH).status, "completed");
	assert.equal(completed.state.get(ACP_DISPATCH).completedAt, 2000);

	// FAILED 通知：错误摘录从 Output ~~~ 块提取
	const failed = reduceAcpNotification(
		dispatched.state, dispatched.runIds,
		`[acp_delegate FAILED ⚠️] **worker** (runId \`${ACP_RUN_ID}\`, exit ?) failed.\n\nOutput:\n~~~\nspawn error: ENOENT\n~~~`,
		3000,
	);
	assert.equal(failed.changed, true);
	assert.equal(failed.state.get(ACP_DISPATCH).status, "error");
	assert.ok(failed.state.get(ACP_DISPATCH).error.includes("ENOENT"));
	// 终态后再收通知不再迁移（幂等）
	const repeated = reduceAcpNotification(failed.state, dispatched.runIds,
		`[acp_delegate completed] **worker** (runId \`${ACP_RUN_ID}\`, exit 0)`, 4000);
	assert.equal(repeated.changed, false);

	// 未知 runId 的通知被忽略
	const orphan = reduceAcpNotification(
		dispatched.state, dispatched.runIds,
		`[acp_delegate completed] **worker** (runId \`del_unknown\`, exit 0)`, 5000,
	);
	assert.equal(orphan.changed, false);
});

test("bridge extension: acp 委托派发落 start 锚点、终态通知落 subagents:record", () => {
	const { default: bridge } = loadBridgeModule();
	const { lifecycle, appendedEntries } = createMockPi();
	bridge(pi4acp(lifecycle, appendedEntries));

	// 派发 start → 快照 + start 锚点
	lifecycle.get("tool_execution_start")({
		type: "tool_execution_start", toolCallId: ACP_DISPATCH, toolName: "acp_delegate",
		args: { agent: "worker", task: "Generate md", cwd: "/tmp" },
	});
	const anchor = appendedEntries.find((e) => e.type === "pi-deck-subagent-start");
	assert.ok(anchor, "start 锚点应落盘");
	assert.equal(anchor.data.id, ACP_DISPATCH);
	assert.equal(anchor.data.type, "worker");

	// 派发确认（end）→ 只登记 runId，不落盘
	lifecycle.get("tool_execution_end")(acpDispatchEndEvent());
	assert.equal(appendedEntries.filter((e) => e.type === "pi-deck-subagent-start").length, 1);

	// 终态通知 → subagents:record 落盘（历史重建权威数据，via 标记）
	lifecycle.get("message_end")({
		type: "message_end",
		message: { role: "user", content: [{ type: "text", text: `[acp_delegate completed] **worker** (runId \`${ACP_RUN_ID}\`, exit 0) No delegates are currently running.` }] },
	});
	const record = appendedEntries.find((e) => e.type === "subagents:record");
	assert.ok(record, "终态 record 应落盘");
	assert.equal(record.data.id, ACP_DISPATCH);
	assert.equal(record.data.status, "completed");
	assert.equal(record.data.via, "acp-delegate");
	assert.equal(typeof record.data.completedAt, "number");
});

test("bridge extension: 非 user 消息/非 acp 通知不触发落盘", () => {
	const { default: bridge } = loadBridgeModule();
	const { lifecycle, appendedEntries } = createMockPi();
	bridge(pi4acp(lifecycle, appendedEntries));

	lifecycle.get("message_end")({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "[acp_delegate completed] fake" }] } });
	lifecycle.get("message_end")({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "普通用户消息 [acp_delegate completed] 字样但非通知" }] } });
	assert.equal(appendedEntries.length, 0);
});

/** acp 测试用 mock pi：lifecycle/appendedEntries 与 createMockPi 产物共享同一实例。 */
function pi4acp(lifecycle, appendedEntries) {
	return {
		events: { on: () => {} },
		on: (name, cb) => { lifecycle.set(name, cb); },
		appendEntry: (type, data) => { appendedEntries.push({ type, data }); },
	};
}
