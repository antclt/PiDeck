import assert from "node:assert/strict";
import test from "node:test";
import { CONTEXT_PRESSURE_PERCENT, countTurnToolSteps, retryCountdownSeconds } from "../src/renderer/src/components/session/timeline/statusFacts.ts";

/**
 * 状态条尾部后缀只放「可测量的量」：本轮工具步数、上下文压力、重试倒计时。
 * 这里只测纯函数（不做 UI 断言），保证状态条不会为了好看编造数字。
 */

function message(role, timestamp) {
	return { id: `${role}-${timestamp}`, agentId: "agent-1", role, text: "", timestamp };
}

test("步数只数本轮的工具调用，遇到本轮用户消息就收口", () => {
	assert.equal(countTurnToolSteps([message("user", 100), message("assistant", 110), message("tool", 120), message("tool", 130), message("user", 200), message("tool", 210), message("tool", 220), message("tool", 230)]), 3);
});

test("上一轮的工具不能计入本轮步数", () => {
	assert.equal(countTurnToolSteps([message("user", 100), message("tool", 110), message("user", 200)]), 0);
});

test("没有用户消息时（续跑 / 历史被截到工具段）尾部工具全部计入", () => {
	assert.equal(countTurnToolSteps([message("tool", 10), message("tool", 20)]), 2);
	assert.equal(countTurnToolSteps([]), 0);
	assert.equal(countTurnToolSteps(undefined), 0);
});

test("thinking / assistant 不计入步数：步数是工具调用次数，不是消息条数", () => {
	assert.equal(countTurnToolSteps([message("user", 100), message("thinking", 105), message("assistant", 110), message("tool", 120)]), 1);
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
