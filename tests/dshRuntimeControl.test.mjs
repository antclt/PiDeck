import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	applyDshControlEvent,
	beginDshCancel,
} = loadTsCommonJs("src/main/dsh/dshRuntimeControl.ts");

const idle = () => ({
	status: "idle",
	isStreaming: false,
	cancelGeneration: 0,
	cancelled: false,
});

test("turn/start 把 DSH 标成 running，turn/end 必须回到 idle", () => {
	let state = idle();
	state = applyDshControlEvent(state, "turn/start", 0).next;
	assert.equal(state.status, "running");
	assert.equal(state.isStreaming, true);
	state = applyDshControlEvent(state, "turn/end", 0).next;
	assert.equal(state.status, "idle");
	assert.equal(state.isStreaming, false);
});

test("abort 之后迟到的 chunk / turn/start 不能再点亮 streaming", () => {
	let state = applyDshControlEvent(idle(), "turn/start", 0).next;
	state = beginDshCancel(state);
	assert.equal(state.status, "idle");
	assert.equal(state.isStreaming, false);
	assert.equal(state.cancelGeneration, 1);

	const staleStart = applyDshControlEvent(state, "turn/start", 0);
	assert.equal(staleStart.ignoreStream, true);
	assert.equal(staleStart.next.isStreaming, false);
	assert.equal(staleStart.next.status, "idle");

	const staleChunk = applyDshControlEvent(state, "assistant/chunk", 0);
	assert.equal(staleChunk.ignoreStream, true);
	assert.equal(staleChunk.next.isStreaming, false);
});

test("abort 后的 turn/end（旧世代）只收口 cancelled，不重新 running", () => {
	let state = beginDshCancel(applyDshControlEvent(idle(), "turn/start", 0).next);
	const ended = applyDshControlEvent(state, "turn/end", 0);
	assert.equal(ended.next.cancelled, false);
	assert.equal(ended.next.status, "idle");
	assert.equal(ended.next.isStreaming, false);
	assert.equal(ended.ignoreStream, true);
});
