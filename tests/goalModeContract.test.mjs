import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const agentTypes = readFileSync("src/shared/types/agent.ts", "utf8");
const composerComponents = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
const composerModeSelect = readFileSync("src/renderer/src/components/session/ComposerModeSelect.tsx", "utf8");
const controller = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");
const builtIns = readFileSync("src/main/extensions/builtInExtensions.ts", "utf8");
const extension = readFileSync("resources/extensions/pi-deck-goal-mode.ts", "utf8");
const sendHook = readFileSync("src/renderer/src/hooks/useSessionSend.ts", "utf8");
const timelineCss = readFileSync("src/renderer/src/styles/timeline.css", "utf8");

test("goal mode is a first-class ComposerAgentMode", () => {
	assert.match(agentTypes, /ComposerAgentMode = "normal" \| "plan" \| "imagegen" \| "goal"/);
	assert.equal(existsSync("resources/extensions/pi-deck-goal-mode.ts"), true);
	assert.match(builtIns, /"pi-deck-goal-mode.ts"/);
});

test("mode picker lists goal between plan and imagegen", () => {
	assert.match(composerModeSelect, /value: "goal"/);
	assert.match(composerModeSelect, /"app\.composerModeGoal"/);
	assert.match(composerModeSelect, /goalModeAvailable/);
	assert.match(composerModeSelect, /pi-deck-goal-mode\.ts/);
	assert.match(composerModeSelect, /<Select/);
	const optionOrder = composerModeSelect.indexOf('value: "plan"');
	const goalOrder = composerModeSelect.indexOf('value: "goal"');
	const imagegenOrder = composerModeSelect.indexOf('value: "imagegen"');
	assert.ok(optionOrder >= 0 && goalOrder > optionOrder && imagegenOrder > goalOrder);
});

test("DSH setMode pauses on normal and resumes paused goals", () => {
	assert.match(controller, /runDshGoalAction\(agentId, "pause"\)/);
	assert.match(controller, /runDshGoalAction\(agentId, "resume"\)/);
	assert.match(controller, /dshGoal\.pendingNotice/);
	assert.match(controller, /deriveComposerAgentMode/);
});

test("pi goal extension auto-continues until complete, blocked, or max rounds", () => {
	assert.match(extension, /__PI_DECK_GOAL_MODE__/);
	assert.match(extension, /GOAL_COMPLETE/);
	assert.match(extension, /GOAL_BLOCKED/);
	assert.match(extension, /triggerTurn: true, deliverAs: "followUp"/);
	assert.match(extension, /phase: "paused"/);
	assert.match(extension, /\["clear", "reset"\]/);
});

test("goal/plan composer chrome uses an inset accent rail and an in-chip exit", () => {
	// 身份条画在圆角盒内侧：贴外沿的 3px 实心条在默认近黑 accent 下会像一根粗棍。
	const rail = timelineCss.match(/\.composer-box::before \{[\s\S]*?\n\}/)?.[0] ?? "";
	assert.match(rail, /left:\s*8px/);
	assert.match(rail, /width:\s*2px/);
	assert.match(rail, /border-radius:\s*999px/);
	assert.doesNotMatch(rail, /left:\s*-1px/);
	assert.doesNotMatch(rail, /width:\s*3px/);
	assert.match(timelineCss, /\.composer-box\.goal-mode::before \{[\s\S]*?color-mix\(in srgb, var\(--color-accent\) 55%/);
	assert.match(composerComponents, /composer-mode-cluster/);
	assert.match(composerComponents, /composer-mode-exit/);
	assert.match(composerComponents, /<X size=\{12\}/);
	assert.doesNotMatch(composerComponents, /mode-cancel/);
});

test("send path keeps DSH off agentMessage and uses /goal transform", () => {
	assert.match(sendHook, /applyDshGoalSendTransform/);
	assert.match(sendHook, /isDshSend \? "normal" : sendMode/);
});
