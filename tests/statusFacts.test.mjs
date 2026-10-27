import assert from "node:assert/strict";
import test from "node:test";
import { CONTEXT_PRESSURE_PERCENT, retryCountdownSeconds } from "../src/renderer/src/components/session/timeline/statusFacts.ts";

/**
 * 状态条尾部后缀只放「可测量的量」：上下文压力、重试倒计时。
 * 这里只测纯函数（不做 UI 断言），保证状态条不会为了好看编造数字。
 * 本轮工具调用次数已从状态条移除（用户反馈是噪音），对应函数与用例一并删除。
 */

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
