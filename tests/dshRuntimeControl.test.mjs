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

test("assistant/message 带 tool-call 块不是回合终点：保持 running，只收流式标记", () => {
	// DSH 事件顺序：LLM 流结束先落 assistant/message（内容含 tool-call），
	// 之后才是 tool/call → 工具执行 → tool/result → 下一轮 LLM 流。
	// 若此时回 idle，工具执行期间 UI 提前显示空闲（发送按钮/无动画），用户误以为已停止。
	let state = applyDshControlEvent(idle(), "turn/start", 0).next;
	state = applyDshControlEvent(state, "assistant/message", 0, {
		message: {
			content: [
				{ type: "text", text: "我先看一下。" },
				{ type: "tool-call", id: "call-1", name: "pwsh", arguments: {} },
			],
		},
	}).next;
	assert.equal(state.status, "running");
	assert.equal(state.isStreaming, false);
	assert.equal(state.cancelled, false);
});

test("assistant/message 无 tool-call（终态答复）回 idle", () => {
	let state = applyDshControlEvent(idle(), "turn/start", 0).next;
	state = applyDshControlEvent(state, "assistant/message", 0, {
		message: { content: [{ type: "text", text: "完成了。" }] },
	}).next;
	assert.equal(state.status, "idle");
	assert.equal(state.isStreaming, false);
});

test("assistant/message 无 message/content 结构时保守按终态处理（回 idle）", () => {
	let state = applyDshControlEvent(idle(), "turn/start", 0).next;
	state = applyDshControlEvent(state, "assistant/message", 0, {}).next;
	assert.equal(state.status, "idle");
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
