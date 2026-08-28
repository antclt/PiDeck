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
