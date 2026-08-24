import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
});

test("list on an unknown project still throws notFound", async () => {
	const manager = managerFor(chatProject);
	await assert.rejects(manager.list("missing"), /no longer exists/i);
});

test("write operations on a chat project keep throwing chatUnsupported", async () => {
	// 只读浏览放行，写入仍须拒绝：chat 项目不存在可创建/删除/改写的资源目录。
	const manager = managerFor(chatProject);
	const chatUnsupported = /do not support project-level resources/i;
	await assert.rejects(
		manager.createSkill({ projectId: "builtin-chat", name: "hello", description: "desc" }),
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