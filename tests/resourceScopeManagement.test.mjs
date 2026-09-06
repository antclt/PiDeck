import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("configuration resources share one global/project scope owner", () => {
	const modal = read("src/renderer/src/ConfigModal.tsx");
	const selector = read("src/renderer/src/config/ResourceScopeSelector.tsx");
	assert.match(modal, /useState<ResourceScope>\("global"\)/);
	assert.equal((modal.match(/scopeSelector=\{resourceScopeSelector\}/g) ?? []).length, 4);
	assert.match(modal, /projectKind !== "chat"/);
	assert.doesNotMatch(modal, /getMcp\(projectPath\)/);
	assert.match(selector, /type ResourceScope = "global" \| "project"/);
	assert.match(selector, /\{hasProject \? \(/);
	assert.match(selector, /<SelectItem value="global">/);
	assert.match(selector, /<SelectItem value="project">/);
});

test("extension scope table keeps version/path columns and horizontal state toggles", () => {
	const extensions = read("src/renderer/src/config/ExtensionsTab.tsx");
	const rows = read("src/renderer/src/config/extensionsTableRows.tsx");
	// 合并远端后保留真实路径列（扩展/版本/路径/操作）
	assert.match(extensions, /config\.extensionVersion/);
	assert.match(extensions, /config\.extensionPath/);
	assert.match(extensions, /config\.actions/);
	// 启停开关用水平 ToggleLeft/ToggleRight，不使用 Power 图标
	assert.doesNotMatch(extensions + rows, /\bPower\b/);
	assert.match(rows, /<ToggleRight/);
	assert.match(rows, /<ToggleLeft/);
	// 内置扩展也使用同一启停开关；仅保留全局范围下的独立移除入口。
	assert.match(rows, /启停开关：内置扩展也复用 extensions:toggle/);
	assert.match(rows, /onClick=\{\(\) => props\.onToggle\(extension, !effectiveEnabled\)\}/);
	assert.match(rows, /extension\.builtIn && extension\.enabled !== false && !inherited/);
	assert.doesNotMatch(rows, /onRestoreBuiltIn|restoringBuiltIn/);
	// 继承的全局行只读：全局禁用项不可在项目视图重新启用，卸载/移除均隐藏
	assert.match(rows, /\(inherited && extension\.enabled === false\)/);
	assert.match(rows, /!extension\.builtIn && !inherited && \(\s*<Button[\s\S]*?onUninstall/);
});

test("project resource views group inherited globals and use project-only overrides", () => {
	const skills = read("src/renderer/src/config/SkillsTab.tsx");
	const prompts = read("src/renderer/src/config/PromptsTab.tsx");
	const extensions = read("src/renderer/src/config/ExtensionsTab.tsx");
	const mcp = read("src/renderer/src/config/McpResourceViews.tsx");
	for (const source of [skills, prompts, extensions, mcp]) {
		assert.match(source, /config\.resourceGroup\.project/);
		assert.match(source, /config\.resourceGroup\.global/);
	}
	assert.match(skills, /disabledGlobalSkills/);
	assert.match(prompts, /disabledGlobalPrompts/);
	assert.match(extensions, /disabledGlobalExtensions/);
});

test("project resource file operations retain the registered project scope", () => {
	const modal = read("src/renderer/src/ConfigModal.tsx");
	const extensions = read("src/renderer/src/config/ExtensionsTab.tsx");
	assert.match(modal, /isProjectSkill\(skill\) && projectId \? \{ projectId \} : undefined/);
	assert.match(modal, /isProjectSkill\(editingGlobalSkill\) && projectId \? \{ projectId \} : undefined/);
	assert.match(modal, /api\.projectResources\.openDirectory\(projectId, "project-pi"\)/);
	assert.match(modal, /extension\.scope === "project" && projectId \? \{ projectId \} : undefined/);
	assert.match(extensions, /onShowInFolder/);
});

test("inherited override IPC is exposed through shared, main, and preload layers", () => {
	const channels = read("src/shared/ipc.ts");
	const main = read("src/main/ipc/projectResourceIpc.ts");
	const preload = read("src/preload/index.ts");
	assert.match(channels, /projectResourcesOpenDirectory: "project-resources:open-directory"/);
	assert.match(channels, /projectResourcesToggleInherited: "project-resources:toggle-inherited"/);
	assert.match(main, /ipcChannels\.projectResourcesToggleInherited/);
	assert.match(main, /isInheritedToggleInput/);
	assert.match(preload, /openDirectory: \(projectId: string, kind: ProjectResourceDirectoryKind\)/);
	assert.match(preload, /toggleInherited: \(input: ProjectInheritedResourceToggleInput\)/);
});
