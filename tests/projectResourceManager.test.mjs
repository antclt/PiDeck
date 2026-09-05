import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ProjectResourceManager } = loadTsCommonJs("src/main/projects/ProjectResourceManager.ts");
const { mainProcessT } = loadTsCommonJs("src/shared/i18n/mainProcessCopy.ts");

const en = (key, params) => mainProcessT("en-US", key, params);

function managerFor(project) {
	return new ProjectResourceManager(
		(projectId) => (project && project.id === projectId ? project : undefined),
		en,
	);
}

const chatProject = {
	id: "builtin-chat",
	name: "Chat",
	path: join(tmpdir(), "pideck-chat-test-" + Date.now()),
	kind: "chat",
	pinned: true,
	sortOrder: -1,
};

test("list on a chat project returns empty resources instead of throwing", async () => {
	// 内置聊天项目没有 .pi/.agents 资源目录：list 是纯只读浏览，返回空列表。
	// 之前抛 chatUnsupported 会让前端技能面板（含全局技能）整体加载失败。
	const manager = managerFor(chatProject);
	const result = await manager.list("builtin-chat");
	assert.equal(result.skills.length, 0);
	assert.equal(result.extensions.length, 0);
	assert.deepEqual(JSON.parse(JSON.stringify(result.overrides)), {
		disabledGlobalExtensions: [],
		disabledGlobalSkills: [],
		disabledGlobalPrompts: [],
	});
});

test("list on an unknown project still throws notFound", async () => {
	const manager = managerFor(chatProject);
	await assert.rejects(manager.list("missing"), /no longer exists/i);
});

test("write operations on a chat project keep throwing chatUnsupported", async () => {
	// 只读浏览放行，写入仍须拒绝：chat 项目不存在可创建/删除/改写的资源目录。
	const manager = managerFor(chatProject);
	const chatUnsupported = /do not support project-level resources/i;
	await assert.rejects(manager.ensureResourceDirectory("builtin-chat", "prompts"), chatUnsupported);
	await assert.rejects(
		manager.createSkill({ projectId: "builtin-chat", name: "hello", description: "desc", locationId: "project-pi" }),
		chatUnsupported,
	);
	await assert.rejects(manager.deleteSkill("builtin-chat", "C:/x/SKILL.md"), chatUnsupported);
	await assert.rejects(manager.renameSkill("builtin-chat", "C:/x/SKILL.md", "hello"), chatUnsupported);
	await assert.rejects(manager.toggleSkill("builtin-chat", "C:/x/SKILL.md", false), chatUnsupported);
	await assert.rejects(manager.deleteExtension("builtin-chat", "C:/x/ext.ts"), chatUnsupported);
	await assert.rejects(manager.toggleExtension("builtin-chat", "C:/x/ext.ts", false), chatUnsupported);
});

test("list on a regular project scans .pi/skills SKILL.md files", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-prm-"));
	try {
		const skillDir = join(root, ".pi", "skills");
		mkdirSync(join(skillDir, "mykit"), { recursive: true });
		writeFileSync(join(skillDir, "mykit", "SKILL.md"), "---\nname: mykit\ndescription: Test kit\n---\n\n# mykit\n");
		const project = { id: "p1", name: "P1", path: root, lastOpenedAt: 1 };
		const manager = managerFor(project);
		const result = await manager.list("p1");
		assert.equal(result.skills.length, 1);
		assert.equal(result.skills[0].name, "mykit");
		assert.equal(result.skills[0].sourceId, "project-pi");
		assert.equal(result.extensions.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("createSkill writes to the selected project resource location", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-prm-location-"));
	try {
		const manager = managerFor({ id: "p1", name: "P1", path: root, lastOpenedAt: 1 });
		const created = await manager.createSkill({
			projectId: "p1",
			name: "agents-skill",
			description: "created in the agents directory",
			locationId: "project-agents",
		});
		assert.equal(created.sourceId, "project-agents");
		assert.equal(
			created.path.toLowerCase().endsWith(join(".agents", "skills", "agents-skill", "SKILL.md").toLowerCase()),
			true,
		);
		const listed = await manager.list("p1");
		assert.equal(listed.skills.some((skill) => skill.path === created.path), true);
		assert.equal(listed.skillLocations.length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("toggleSkill 写入项目 .pi/settings.json 的 disabledSkills 并反映到列表", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-prm-toggle-"));
	try {
		const skillDir = join(root, ".pi", "skills");
		mkdirSync(join(skillDir, "mykit"), { recursive: true });
		writeFileSync(join(skillDir, "mykit", "SKILL.md"), "---\nname: MyKit\ndescription: Test kit\n---\n\n# MyKit\n");
		const project = { id: "p1", name: "P1", path: root, lastOpenedAt: 1 };
		const manager = managerFor(project);
		const skillPath = join(skillDir, "mykit", "SKILL.md");

		// 禁用：项目 settings 写入（名称保留原始大小写，比较不敏感）
		const disabled = await manager.toggleSkill("p1", skillPath, false);
		assert.equal(disabled.enabled, false);
		const settings = JSON.parse(readFileSync(join(root, ".pi", "settings.json"), "utf8"));
		assert.deepEqual(settings.disabledSkills, ["MyKit"]);

		// 列表显示禁用
		const listed = await manager.list("p1");
		assert.equal(listed.skills[0].enabled, false);

		// 启用：从 settings 移除
		const enabled = await manager.toggleSkill("p1", skillPath, true);
		assert.equal(enabled.enabled, true);
		const after = JSON.parse(readFileSync(join(root, ".pi", "settings.json"), "utf8"));
		assert.deepEqual(after.disabledSkills, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目继承覆盖保留无关 settings，且启用时只移除对应稳定键", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-prm-overrides-"));
	try {
		mkdirSync(join(root, ".pi"), { recursive: true });
		const settingsPath = join(root, ".pi", "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark", disabledSkills: ["local"] }));
		const manager = managerFor({ id: "p1", name: "P1", path: root, lastOpenedAt: 1 });

		await manager.toggleInheritedResource({ projectId: "p1", kind: "extension", key: "shared.ts", enabled: false });
		await manager.toggleInheritedResource({ projectId: "p1", kind: "skill", key: "pi-global:shared", enabled: false });
		await manager.toggleInheritedResource({ projectId: "p1", kind: "prompt", key: "SHARED", enabled: false });
		let settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(settings.theme, "dark");
		assert.deepEqual(settings.disabledSkills, ["local"]);
		assert.deepEqual(settings.pideckDisabledGlobalExtensions, ["shared.ts"]);
		assert.deepEqual(settings.pideckDisabledGlobalSkills, ["pi-global:shared"]);
		assert.deepEqual(settings.pideckDisabledGlobalPrompts, ["shared"]);

		const overrides = await manager.toggleInheritedResource({ projectId: "p1", kind: "extension", key: "shared.ts", enabled: true });
		assert.deepEqual([...overrides.disabledGlobalExtensions], []);
		settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.deepEqual(settings.pideckDisabledGlobalSkills, ["pi-global:shared"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("损坏的项目 settings 会拒绝覆盖写入且不先修改 skill", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-prm-invalid-"));
	try {
		const skillDir = join(root, ".pi", "skills", "mykit");
		mkdirSync(skillDir, { recursive: true });
		const skillPath = join(skillDir, "SKILL.md");
		const originalSkill = "---\nname: MyKit\ndescription: Test kit\n---\n\n# MyKit\n";
		writeFileSync(skillPath, originalSkill);
		const settingsPath = join(root, ".pi", "settings.json");
		writeFileSync(settingsPath, "{broken");
		const manager = managerFor({ id: "p1", name: "P1", path: root, lastOpenedAt: 1 });

		await assert.rejects(
			manager.toggleInheritedResource({ projectId: "p1", kind: "prompt", key: "shared", enabled: false }),
			/JSON is invalid/i,
		);
		await assert.rejects(manager.toggleSkill("p1", skillPath, false), /JSON is invalid/i);
		assert.equal(readFileSync(settingsPath, "utf8"), "{broken");
		assert.equal(readFileSync(skillPath, "utf8"), originalSkill);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("项目扩展开关用含后缀 source，并在 settings 损坏时拒绝写入", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-prm-extension-"));
	try {
		const extensionDir = join(root, ".pi", "extensions");
		mkdirSync(extensionDir, { recursive: true });
		const extensionPath = join(extensionDir, "shared.ts");
		writeFileSync(extensionPath, "export default () => {};\n");
		const settingsPath = join(root, ".pi", "settings.json");
		writeFileSync(settingsPath, "{broken");
		const manager = managerFor({ id: "p1", name: "P1", path: root, lastOpenedAt: 1 });

		await assert.rejects(manager.toggleExtension("p1", extensionPath, false), /JSON is invalid/i);
		assert.equal(readFileSync(settingsPath, "utf8"), "{broken");
		writeFileSync(settingsPath, "{}");
		await manager.toggleExtension("p1", extensionPath, false);
		const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.deepEqual(settings.disabledExtensions, ["shared.ts"]);
		const listed = await manager.list("p1");
		assert.equal(listed.extensions[0].source, "shared.ts");
		assert.equal(listed.extensions[0].enabled, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("嵌套 SKILL.md symlink 不能让项目列表读取外部文件", async (t) => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-prm-skill-link-"));
	const root = join(fixture, "project");
	const skillDir = join(root, ".pi", "skills", "linked");
	const outsideSkill = join(fixture, "outside-SKILL.md");
	try {
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(outsideSkill, "---\nname: outside\ndescription: secret\n---\n");
		try {
			symlinkSync(outsideSkill, join(skillDir, "SKILL.md"), "file");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EPERM") {
				t.skip("The current filesystem does not permit file symlink creation");
				return;
			}
			throw error;
		}
		const manager = managerFor({ id: "p1", name: "P1", path: root, lastOpenedAt: 1 });
		const listed = await manager.list("p1");
		assert.equal(listed.skills.length, 0);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("项目资源目录 junction 指向项目外时列表与写操作都拒绝越界", async (t) => {
	const fixture = mkdtempSync(join(tmpdir(), "pideck-prm-junction-"));
	const root = join(fixture, "project");
	const outsideSkills = join(fixture, "outside-skills");
	try {
		mkdirSync(join(root, ".pi"), { recursive: true });
		mkdirSync(join(outsideSkills, "secret"), { recursive: true });
		writeFileSync(
			join(outsideSkills, "secret", "SKILL.md"),
			"---\nname: secret\ndescription: outside\n---\n",
		);
		try {
			symlinkSync(
				outsideSkills,
				join(root, ".pi", "skills"),
				process.platform === "win32" ? "junction" : "dir",
			);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EPERM") {
				t.skip("The current filesystem does not permit junction creation");
				return;
			}
			throw error;
		}
		const manager = managerFor({ id: "p1", name: "P1", path: root, lastOpenedAt: 1 });
		const listed = await manager.list("p1");
		assert.equal(listed.skills.length, 0);
		await assert.rejects(
			manager.createSkill({ projectId: "p1", name: "new", description: "new skill", locationId: "project-pi" }),
			/outside the project/i,
		);
		assert.equal(readFileSync(join(outsideSkills, "secret", "SKILL.md"), "utf8").includes("outside"), true);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});