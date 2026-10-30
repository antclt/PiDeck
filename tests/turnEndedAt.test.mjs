import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 轮末固定「回复耗时」的时间基准。
 *
 * 回归背景（2026-10）：状态条实时秒表迁走后，轮末本应显示固定耗时，但 assistant
 * 消息的 timestamp 是「请求开始」，流式结束后 run.endedAt 与 startedAt 相等（或
 * 只差最后一次请求的排队时间），耗时恒为 0 / 偏小。终态消息由主进程写入
 * meta.endedAt（请求开始 + 实测耗时），分组层必须优先用它。
 */
const { groupToolMessages, messageEndedAt } = loadTsCommonJs("src/renderer/src/components/app/AppUtils.ts");

function userMessage(timestamp) {
	return { id: "u-1", agentId: "agent", role: "user", text: "写一版", timestamp };
}

function assistantMessage(timestamp, meta, overrides = {}) {
	return {
		id: "a-1",
		agentId: "agent",
		role: "assistant",
		text: "好了",
		timestamp,
		stopReason: "stop",
		...(meta ? { meta } : {}),
		...overrides,
	};
}

test("run.endedAt uses the terminal message's endedAt, not its request-start timestamp", () => {
	const runs = groupToolMessages([userMessage(1_000), assistantMessage(2_000, { endedAt: 3_450 })]);
	const run = runs.find((item) => item.kind === "agent-run");
	assert.ok(run, "assistant reply must form an agent-run");
	assert.equal(run.startedAt, 1_000);
	assert.equal(run.endedAt, 3_450);
	// 与状态条同一口径：真实回合耗时 = 结束点 - 用户提问时刻
	assert.equal(run.endedAt - run.startedAt, 2_450);
});

test("legacy messages without endedAt keep the previous timestamp fallback", () => {
	const runs = groupToolMessages([userMessage(1_000), assistantMessage(2_000)]);
	assert.equal(runs.find((item) => item.kind === "agent-run")?.endedAt, 2_000);
});

test("messageEndedAt ignores malformed endedAt values", () => {
	assert.equal(messageEndedAt(assistantMessage(2_000, { endedAt: Number.NaN })), 2_000);
	assert.equal(messageEndedAt(assistantMessage(2_000, { endedAt: 0 })), 2_000);
	assert.equal(messageEndedAt(assistantMessage(2_000, { endedAt: "3450" })), 2_000);
	assert.equal(messageEndedAt(assistantMessage(2_000, { endedAt: 3_450 })), 3_450);
});
