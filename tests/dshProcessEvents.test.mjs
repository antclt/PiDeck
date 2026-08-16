import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * DSH 轨迹过程事件收集器单测：mux 事件流 → SessionProcessEvent
 * （modelChange/permission/plan/goal/compaction），与 pi 会话文件过程事件同语义。
 */

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadModule() {
	const sandbox = { exports: {} };
	vm.runInNewContext(
		transpile("src/main/dsh/dshProcessEvents.ts"),
		sandbox,
		{ filename: "dshProcessEvents.ts" },
	);
	return sandbox.exports;
}

const {
	collectDshProcessEvent,
	pushDshProcessEvent,
	estimateContextTokens,
	parseContextPressureProjection,
	parseContextBreakdownProjection,
	DSH_PROCESS_EVENTS_LIMIT,
} = loadModule();

function event(type, data = {}, seq = 1, time = 1_000_000) {
	return { type, data, seq, time };
}

test("request/context yields a modelChange process record", () => {
	const record = collectDshProcessEvent([], event("request/context", { provider: "deepseek", model: "deepseek-chat" }, 5, 1234));
	assert.ok(record);
	assert.equal(record.kind, "modelChange");
	assert.equal(record.provider, "deepseek");
	assert.equal(record.modelId, "deepseek-chat");
	assert.equal(record.timestamp, 1234);
});

test("repeated request/context with the same model is idempotent", () => {
	const first = collectDshProcessEvent([], event("request/context", { provider: "deepseek", model: "deepseek-chat" }, 5, 1000));
	assert.ok(first);
	const second = collectDshProcessEvent([first], event("request/context", { provider: "deepseek", model: "deepseek-chat" }, 9, 2000));
	assert.equal(second, undefined);
});

test("model switch after the same model does record a new event", () => {
	const first = collectDshProcessEvent([], event("request/context", { provider: "deepseek", model: "deepseek-chat" }, 5, 1000));
	const second = collectDshProcessEvent([first], event("request/context", { provider: "deepseek", model: "deepseek-reasoner" }, 9, 2000));
	assert.ok(second);
	assert.equal(second.kind, "modelChange");
	assert.equal(second.modelId, "deepseek-reasoner");
});

test("permission/preset maps to a custom(permission) record", () => {
	const record = collectDshProcessEvent([], event("permission/preset", { preset: "workspace-write" }, 3, 1500));
	assert.ok(record);
	assert.equal(record.kind, "custom");
	assert.equal(record.customType, "permission");
	assert.equal(record.summary, "permission workspace-write");
});

test("plan/mode maps to a custom(plan) record with on/off summary", () => {
	const on = collectDshProcessEvent([], event("plan/mode", { active: true }, 4, 1600));
	assert.equal(on?.customType, "plan");
	assert.equal(on?.summary, "plan on");
	const off = collectDshProcessEvent([], event("plan/mode", { active: false }, 5, 1700));
	assert.equal(off?.summary, "plan off");
});

test("goal/change maps to a custom(goal) record; clear gets a dedicated summary", () => {
	const created = collectDshProcessEvent([], event("goal/change", { operation: "create", goal: { id: "g1", revision: 1, objective: "fix the build" } }, 6, 1800));
	assert.equal(created?.customType, "goal");
	assert.match(created?.summary ?? "", /fix the build/);
	const cleared = collectDshProcessEvent([], event("goal/change", { operation: "clear" }, 7, 1900));
	assert.equal(cleared?.summary, "goal cleared");
});

test("user/message starting with /compact yields a compaction record", () => {
	const record = collectDshProcessEvent([], event("user/message", { content: [{ type: "text", text: "/compact 保留架构" }] }, 8, 2000));
	assert.ok(record);
	assert.equal(record.kind, "compaction");
	assert.equal(record.summary, "compact: 保留架构");
});

test("plain user messages are not process events", () => {
	const record = collectDshProcessEvent([], event("user/message", { content: [{ type: "text", text: "hello" }] }, 8, 2000));
	assert.equal(record, undefined);
});

test("unknown event types are ignored", () => {
	const record = collectDshProcessEvent([], event("something/else", {}, 9, 2100));
	assert.equal(record, undefined);
});

test("pushDshProcessEvent appends and caps at the limit", () => {
	let events = [];
	for (let i = 0; i < DSH_PROCESS_EVENTS_LIMIT + 5; i += 1) {
		events = pushDshProcessEvent(events, {
			id: `e${i}`,
			kind: "custom",
			timestamp: i,
			summary: `s${i}`,
			customType: "plan",
		});
	}
	assert.equal(events.length, DSH_PROCESS_EVENTS_LIMIT);
	assert.equal(events[0].id, "e5");
	assert.equal(events[events.length - 1].id, `e${DSH_PROCESS_EVENTS_LIMIT + 4}`);
});

test("pushDshProcessEvent ignores undefined records", () => {
	const events = pushDshProcessEvent([{ id: "a", kind: "custom", timestamp: 1, summary: "a" }], undefined);
	assert.equal(events.length, 1);
});

test("parseContextPressureProjection reads host projection values", () => {
	const parsed = parseContextPressureProjection({
		contextPressure: { pressureTokens: 1200, projectedTokens: 1500, contextWindow: 64_000 },
	});
	// vm 沙箱对象与 node assert 的深比较原型不同：按字段断言
	assert.equal(parsed.pressureTokens, 1200);
	assert.equal(parsed.projectedTokens, 1500);
	assert.equal(parsed.contextWindow, 64_000);
});

test("parseContextPressureProjection returns undefined for empty or foreign values", () => {
	assert.equal(parseContextPressureProjection({}), undefined);
	assert.equal(parseContextPressureProjection({ contextPressure: {} }), undefined);
	assert.equal(parseContextPressureProjection({ contextPressure: { pressureTokens: "nope" } }), undefined);
	assert.equal(parseContextPressureProjection(undefined), undefined);
});

test("parseContextBreakdownProjection reads heuristic composition", () => {
	const parsed = parseContextBreakdownProjection({
		contextBreakdown: { systemTokens: 900, toolsTokens: 300, messageTokens: 4200 },
	});
	assert.equal(parsed.systemTokens, 900);
	assert.equal(parsed.toolsTokens, 300);
	assert.equal(parsed.messageTokens, 4200);
});

test("parseContextBreakdownProjection tolerates partial fields", () => {
	const parsed = parseContextBreakdownProjection({ contextBreakdown: { messageTokens: 10 } });
	assert.equal(parsed.systemTokens, 0);
	assert.equal(parsed.toolsTokens, 0);
	assert.equal(parsed.messageTokens, 10);
});

test("estimateContextTokens counts text chars / 4 across messages", () => {
	// 与 pi 的 contextMessageTokens 同规则（字符数 ÷ 4）
	assert.equal(estimateContextTokens([
		{ role: "user", text: "abcd" },
		{ role: "assistant", text: "efgh" },
	]), 2);
	assert.equal(estimateContextTokens([
		{ role: "user", text: "你好世界" },
		{ role: "tool", text: "abcd" },
	]), 2);
});

test("estimateContextTokens skips empty and missing text", () => {
	assert.equal(estimateContextTokens([
		{ role: "user", text: "" },
		{ role: "assistant" },
		{ role: "user", text: "abcdefgh" },
	]), 2);
	assert.equal(estimateContextTokens([]), 0);
	// 不足 4 字符按 0 处理（floor）
	assert.equal(estimateContextTokens([{ role: "user", text: "abc" }]), 0);
});
