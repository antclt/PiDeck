import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const agentTypes = readFileSync("src/shared/types/agent.ts", "utf8");
const composerComponents = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
const pickerHost = readFileSync("src/renderer/src/components/session/ComposerPickerHost.tsx", "utf8");
const controller = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");
const builtIns = readFileSync("src/main/extensions/builtInExtensions.ts", "utf8");
const extension = readFileSync("resources/extensions/pi-deck-goal-mode.ts", "utf8");
const sendHook = readFileSync("src/renderer/src/hooks/useSessionSend.ts", "utf8");

test("goal mode is a first-class ComposerAgentMode", () => {
	assert.match(agentTypes, /ComposerAgentMode = "normal" \| "plan" \| "imagegen" \| "goal"/);
	assert.equal(existsSync("resources/extensions/pi-deck-goal-mode.ts"), true);
	assert.match(builtIns, /"pi-deck-goal-mode.ts"/);
});

test("mode picker lists goal between plan and imagegen", () => {
	assert.match(composerComponents, /value: "goal" as const/);
	assert.match(composerComponents, /"app\.composerModeGoal"/);
	assert.match(composerComponents, /goalModeAvailable/);
	assert.match(pickerHost, /pi-deck-goal-mode\.ts/);
	assert.match(pickerHost, /goalModeAvailable=\{isDshSession \|\| goalModeAvailable\}/);
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

test("send path keeps DSH off agentMessage and uses /goal transform", () => {
	assert.match(sendHook, /applyDshGoalSendTransform/);
	assert.match(sendHook, /isDshSend \? "normal" : sendMode/);
});
