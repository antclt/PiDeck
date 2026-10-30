import assert from "node:assert/strict";
import test from "node:test";
import { CONTEXT_PRESSURE_PERCENT, elapsedRunMs, formatElapsed, retryCountdownSeconds } from "../src/renderer/src/components/session/timeline/statusFacts.ts";

/**
 * 状态条尾部后缀只放「可测量的量」：已运行时长、上下文压力、重试倒计时。
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

test("已运行时长：整秒读数、无起点不编造、ask 阻塞期间冻结", () => {
	// 秒表与轮末固定耗时同口径，但只到整秒（状态条每秒跳两次会很吵）
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(999), "0s");
	assert.equal(formatElapsed(12_400), "12s");
	assert.equal(formatElapsed(64_000), "1m4s");
	assert.equal(formatElapsed(3_600_000), "1h");
	assert.equal(formatElapsed(3_723_000), "1h2m3s");
	// 负值（时钟回拨）不显示成负数
	assert.equal(formatElapsed(-5_000), "0s");

	assert.equal(elapsedRunMs(1_000, 13_000), 12_000);
	// 无起点（未开始/历史轮）不返回读数，避免状态条出现「已运行 0s」
	assert.equal(elapsedRunMs(undefined, 13_000), undefined);
	assert.equal(elapsedRunMs(0, 13_000), undefined);
	assert.equal(elapsedRunMs(Number.NaN, 13_000), undefined);
	// ask_question 弹起后冻结：用户思考的 95 秒不能算进 agent 耗时
	assert.equal(elapsedRunMs(1_000, 99_999, 5_000), 4_000);
});
