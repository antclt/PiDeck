import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const sidebar = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");
const projectMenu = readFileSync("src/renderer/src/components/sidebar/SidebarComponents.tsx", "utf8");
const workspace = readFileSync("src/renderer/src/components/automation/AutomationWorkspace.tsx", "utf8");
const taskList = readFileSync("src/renderer/src/components/automation/AutomationTaskList.tsx", "utf8");
const history = readFileSync("src/renderer/src/components/automation/AutomationHistoryList.tsx", "utf8");
const editor = readFileSync("src/renderer/src/components/automation/AutomationTaskEditor.tsx", "utf8");

test("a project menu opens its own automation task table", () => {
	assert.match(sidebar, /manageAutomations: \(projectId: string\) => void/);
	assert.match(sidebar, /onManageAutomations=\{\(\) => \{?\s*actions\.projects\.manageAutomations\(menuProject\.id\)/);
	assert.match(projectMenu, /onManageAutomations: \(\) => void/);
	assert.match(projectMenu, /<Clock className="size-3\.5"/);
	assert.match(app, /manageAutomations: \(projectId\) => openAutomationPage\(projectId\)/);
});

test("project scope filters tasks and runs and locks new task ownership", () => {
	assert.match(workspace, /projectId=\{props\.projectId\}/);
	assert.match(workspace, /lockProject=\{Boolean\(props\.projectId\)\}/);
	assert.match(taskList, /task\.projectId === projectId/);
	assert.match(history, /run\.projectId === projectId/);
	assert.match(editor, /defaultProjectId\?: string/);
	assert.match(editor, /lockProject\?: boolean/);
});
