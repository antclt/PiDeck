import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * issue #425：飞书卡片无视 hideThinkingBlock。
 * 卡片是「有第三方读者」的 IM 渠道，思考过程必须能被关掉；trail 的时间戳也不该带反引号
 *（飞书卡片 markdown 不渲染行内代码，反引号会原样显示）。
 */
const runState = loadTsCommonJs("src/main/feishu/CardRunState.ts");
const renderer = loadTsCommonJs("src/main/feishu/CardRenderer.ts");

const thinkingDelta = { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "内部推理：先说结论" } };

test("showThinking=false 时 reducer 不累积思考正文，也不留「开始思考」轨迹", () => {
	const hidden = runState.reduceFromPiEvent(runState.createInitialState({ showThinking: false }), thinkingDelta, "zh-CN");
	assert.equal(hidden.reasoning.content, "");
	assert.equal(hidden.trail.length, 0);

	const shown = runState.reduceFromPiEvent(runState.createInitialState({ showThinking: true }), thinkingDelta, "zh-CN");
	assert.equal(shown.reasoning.content, "内部推理：先说结论");
	assert.equal(shown.trail.length, 1);
});

test("createInitialState 不传参时默认展示（桌面端/老调用点行为不变）", () => {
	assert.equal(runState.createInitialState().showThinking, true);
});

test("renderRunCard 尊重 showThinking：关掉后卡片里没有思考过程段落", () => {
	const state = { ...runState.createInitialState({ showThinking: false }), reasoning: { content: "泄露的推理原文", active: false } };
	const card = JSON.stringify(renderer.renderRunCard(state, { locale: "zh-CN" }));
	assert.ok(!card.includes("泄露的推理原文"), "思考正文不应出现在卡片里");

	const visible = JSON.stringify(renderer.renderRunCard({ ...state, showThinking: true }, { locale: "zh-CN" }));
	assert.ok(visible.includes("泄露的推理原文"));
});

test("trail 时间戳不再用反引号（飞书卡片会原样显示）", () => {
	const card = renderer.renderRunCard({ ...runState.createInitialState(), trail: [{ id: "t1", timestamp: 1750000000000, type: "agent", text: "Agent 启动", status: "done" }] }, { locale: "zh-CN" });
	const trail = card.elements.find((e) => e.tag === "markdown" && String(e.content).includes("Agent 启动"));
	assert.ok(trail, "应渲染出轨迹行");
	assert.ok(!trail.content.includes("`"), `轨迹行不应含反引号：${trail.content}`);
});

test("trail 只展示最近 5 条，短对话不再把全量事件流推上卡片", () => {
	const trail = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, timestamp: 1750000000000 + i, type: "agent", text: `事件${i}`, status: "done" }));
	const card = renderer.renderRunCard({ ...runState.createInitialState(), trail }, { locale: "zh-CN" });
	const content = String(card.elements[0].content);
	assert.ok(content.includes("事件7") && content.includes("事件3"));
	assert.ok(!content.includes("事件2"), "超出上限的旧事件应被折叠");
});
