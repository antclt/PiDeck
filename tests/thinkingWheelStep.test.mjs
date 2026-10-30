import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { THINKING_WHEEL_STEP_THRESHOLD, THINKING_WHEEL_IDLE_RESET_MS, accumulateWheelStep, normalizeWheelDelta } = loadTsCommonJs("src/renderer/src/components/session/thinkingWheelStep.ts");

const T0 = 10_000;

const feed = (deltas, { t0 = T0, dt = 16, deltaMode = 0 } = {}) => {
	let state = { accumulated: 0, at: 0 };
	const steps = [];
	let t = t0;
	for (const delta of deltas) {
		const result = accumulateWheelStep(state, delta, t, deltaMode);
		state = result.next;
		steps.push(result.step);
		t += dt;
	}
	return { steps, state };
};

test("阈值与空闲窗口的标定值（改了要同步调手感）", () => {
	assert.equal(THINKING_WHEEL_STEP_THRESHOLD, 50);
	assert.equal(THINKING_WHEEL_IDLE_RESET_MS, 150);
});

test("deltaMode 归一化：像素原样、行 40px/行、页 800px/页", () => {
	assert.equal(normalizeWheelDelta(100), 100);
	assert.equal(normalizeWheelDelta(3, 1), 120);
	assert.equal(normalizeWheelDelta(1, 2), 800);
});

test("鼠标一格（±100）正好一档，方向：上滚增大、下滚减小", () => {
	assert.deepEqual(feed([-100]).steps, [1], "上滚 deltaY<0 = 增大");
	assert.deepEqual(feed([100]).steps, [-1], "下滚 deltaY>0 = 减小");
});

test("一次大位移最多走一档，余量丢弃（甩一下不许连跳五级）", () => {
	const { steps, state } = feed([-500]);
	assert.deepEqual(steps, [1], "向上猛甩 500px 也只走一档");
	assert.equal(state.accumulated, 0, "走档后余量清零，保持每阈值一档的线性手感");
});

test("触控板小增量靠累加：单次不过阈值不跳，累计过阈值跳一档", () => {
	const { steps } = feed([-10, -10, -10, -10, -10, -10]);
	assert.deepEqual(steps, [0, 0, 0, 0, 1, 0]);
});

test("方向翻转立即反向计，不在旧方向记满", () => {
	assert.deepEqual(feed([40, -40]).steps, [0, 0]);
	assert.deepEqual(feed([40, -60]).steps, [0, 1]);
});

test("超过空闲窗口视为新手势，累加器清零（惯性尾巴不许凑档）", () => {
	assert.deepEqual(feed([-30, -30], { dt: 200 }).steps, [0, 0]);
	assert.deepEqual(feed([-30, -30], { dt: 16 }).steps, [0, 1]);
});

test("非有限值 / 零增量不跳档，也不污染累加器、不续空闲窗口", () => {
	const start = { accumulated: 40, at: T0 };
	for (const delta of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0]) {
		const { step, next } = accumulateWheelStep(start, delta, T0 + 16);
		assert.equal(step, 0, `delta=${delta} 不应跳档`);
		assert.deepEqual(next, start, `delta=${delta} 不应改动累加器`);
	}
});

test("行模式（Firefox 的滚轮口径）：鼠标一格三行也正好一档", () => {
	assert.deepEqual(feed([-3], { deltaMode: 1 }).steps, [1], "一格三行 = 120px，跨过阈值走一档");
	assert.deepEqual(feed([3], { deltaMode: 1 }).steps, [-1], "反向同理");
	assert.deepEqual(feed([-3, -3], { deltaMode: 1 }).steps, [1, 1], "连续两格走两档，不因余量清零而丢档");
});
