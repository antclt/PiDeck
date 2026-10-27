import assert from "node:assert/strict";
import test from "node:test";
import { CONTEXT_PRESSURE_PERCENT, deriveTurnStatusFacts, elapsedClockText, retryCountdownSeconds } from "../src/renderer/src/components/session/timeline/statusFacts.ts";

/**
 * 状态条尾部后缀只放「可测量的量」：本轮起点、本轮工具步数、上下文压力、重试倒计时。
 * 这里只测纯函数（不做 UI 断言），保证状态条不会为了好看编造数字。
 */

function message(role, timestamp, extra = {}) {
	return { id: `${role}-${timestamp}`, agentId: "agent-1", role, text: "", timestamp, ...extra };
}

test("本轮起点取最后一条用户消息，步数只数它之后的工具调用", () => {
	const facts = deriveTurnStatusFacts([message("user", 100), message("assistant", 110), message("tool", 120), message("tool", 130), message("user", 200), message("tool", 210), message("tool", 220), message("tool", 230)]);
	assert.deepEqual(facts, { turnStartedAt: 200, toolSteps: 3 });
});

test("上一轮的工具不能计入本轮步数", () => {
	assert.deepEqual(deriveTurnStatusFacts([message("user", 100), message("tool", 110), message("user", 200)]), { turnStartedAt: 200, toolSteps: 0 });
});

test("没有用户消息时给步数但不编造起点", () => {
	assert.deepEqual(deriveTurnStatusFacts([message("tool", 10), message("tool", 20)]), { toolSteps: 2 });
	assert.deepEqual(deriveTurnStatusFacts([]), { toolSteps: 0 });
	assert.deepEqual(deriveTurnStatusFacts(undefined), { toolSteps: 0 });
});

test("秒表：1 分钟内只给整秒，超过 1 分钟走共用时长档位", () => {
	assert.equal(elapsedClockText(0), "0s");
	assert.equal(elapsedClockText(999), "0s");
	assert.equal(elapsedClockText(12_400), "12s");
	assert.equal(elapsedClockText(59_900), "59s");
	assert.equal(elapsedClockText(60_000), "1m");
	assert.equal(elapsedClockText(80_000), "1m20s");
	assert.equal(elapsedClockText(3_723_000), "1h2m3s");
	// 时钟回拨/负数不能出现「-1s」
	assert.equal(elapsedClockText(-5000), "0s");
});

test("重试倒计时：向上取整、到点归零、无终点不读秒", () => {
	assert.equal(retryCountdownSeconds(10_000, 6_000), 4);
	assert.equal(retryCountdownSeconds(10_000, 9_001), 1);
	assert.equal(retryCountdownSeconds(10_000, 10_000), 0);
	assert.equal(retryCountdownSeconds(10_000, 12_000), 0);
	assert.equal(retryCountdownSeconds(undefined, 1_000), undefined);
	assert.equal(retryCountdownSeconds(Number.NaN, 1_000), undefined);
});

test("上下文压力阈值固定，避免了随实现漂移", () => {
	assert.equal(CONTEXT_PRESSURE_PERCENT, 80);
});
