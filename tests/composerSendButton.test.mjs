import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveComposerSendButtonState } from "../src/renderer/src/utils/composerSendButton.ts";

/**
 * Composer 主发送圆钮显示决策：
 * - 空闲 → send；
 * - 忙碌且输入框为空 → stop（唯一停止入口）；
 * - 忙碌但有内容 → send（走 steer/followUp 投递，不吞掉用户输入）；
 * - 生图进行中 → spinner（不可停止，优先于其他状态）。
 */
test("空闲时显示发送按钮", () => {
	assert.equal(resolveComposerSendButtonState({ isAgentBusy: false, hasContent: false }), "send");
	assert.equal(resolveComposerSendButtonState({ isAgentBusy: false, hasContent: true }), "send");
});

test("忙碌且输入框为空时显示停止按钮", () => {
	assert.equal(resolveComposerSendButtonState({ isAgentBusy: true, hasContent: false }), "stop");
});

test("忙碌但输入框有内容时仍显示发送按钮", () => {
	assert.equal(resolveComposerSendButtonState({ isAgentBusy: true, hasContent: true }), "send");
});

test("接线契约：忙碌且有内容时另有独立停止钮（否则 ACP 回合中无停止入口）", () => {
	// 主钮在「忙碌 + 有内容」时保持发送（steer/followUp），停止入口会整体消失；
	// ACP 没有 steer 通道，用户只能清空输入框才停得下来——补一个并列停止钮。
	const source = readFileSync("src/renderer/src/components/session/ComposerPanels.tsx", "utf8");
	assert.match(source, /const showInlineStop = props\.isAgentBusy && !primaryStops;/, "停止钮只在主钮不是停止时出现（避免两个停止钮）");
	assert.match(source, /\{showInlineStop \? \(/, "停止钮必须在忙碌且有内容时渲染");
	assert.match(source, /onClick=\{props\.onStop\}/, "停止钮必须接 abort 入口");
	assert.match(source, /aria-label=\{t\("app\.stop"\)\}/, "停止钮要有可访问名");
});

test("生图进行中显示转圈，优先于忙碌与停止", () => {
	assert.equal(resolveComposerSendButtonState({ isAgentBusy: true, hasContent: false, isGeneratingImage: true }), "spinner");
	assert.equal(resolveComposerSendButtonState({ isAgentBusy: true, hasContent: true, isGeneratingImage: true }), "spinner");
});
