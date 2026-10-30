import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 工厂接线（task-16）：WSL 目标的 toggle 必须写该发行版 HOME 的 settings.json，
 * 本机 settings 与另一个 WSL 档案零污染。
 */

const electron = { app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => tmpdir() } };
const { createPiResourceManagerFactories } = loadTsCommonJs("src/main/config/piResourceFactories.ts", { stubs: { electron } });

function createFactories() {
	return createPiResourceManagerFactories({
		translate: (key) => String(key),
		extension: { locator: {}, getSettings: () => ({}), getPiDeckSettings: () => ({}), patchPiDeckSettings: async () => ({}) },
		xuePrompts: { overlayDir: () => null },
	});
}

async function readJson(path) {
	if (!existsSync(path)) return null;
	return JSON.parse(await readFile(path, "utf8"));
}

async function withHomes(run) {
	const root = await mkdtemp(join(tmpdir(), "pideck-w1-factory-"));
	const localHome = join(root, "local-home");
	const homeA = join(root, "wsl-home-a");
	const homeB = join(root, "wsl-home-b");
	for (const home of [localHome, homeA, homeB]) await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(join(localHome, ".pi", "agent", "settings.json"), JSON.stringify({ skills: ["-local-only"] }), "utf8");
	try {
		await run({ root, localHome, homeA, homeB });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("WSL SkillManager toggle 写目标 settings，不写本机、不污染另一档案", async () => {
	await withHomes(async ({ localHome, homeA, homeB }) => {
		const factories = createFactories();
		const managerA = factories.skills({ home: homeA });
		const skillDir = join(homeA, ".pi", "agent", "skills", "alpha");
		await mkdir(skillDir, { recursive: true });
		await writeFile(join(skillDir, "SKILL.md"), "---\nname: alpha\ndescription: demo\n---\n", "utf8");

		const { skills } = await managerA.list();
		assert.deepEqual(JSON.parse(JSON.stringify(skills.map((skill) => skill.name))), ["alpha"]);
		const skillPath = skills[0].path;
		await managerA.toggle(skillPath, false);

		const settingsA = await readJson(join(homeA, ".pi", "agent", "settings.json"));
		assert.deepEqual(settingsA.skills, ["-" + skillPath]);
		assert.deepEqual(await readJson(join(localHome, ".pi", "agent", "settings.json")), { skills: ["-local-only"] });
		assert.equal(await readJson(join(homeB, ".pi", "agent", "settings.json")), null);
		// 读取器投影：列表按原生规则显示为停用。
		assert.equal((await managerA.list()).skills[0].enabled, false);
	});
});

test("WSL PromptManager create/toggle 只落目标 HOME", async () => {
	await withHomes(async ({ localHome, homeA }) => {
		const factories = createFactories();
		const manager = factories.prompts({ home: homeA });
		const created = await manager.create({ name: "demo", description: "demo" });
		// 边界会 realpath（Windows 临时目录可能是 8.3 短名），比较真实路径前缀而不是原始字符串。
		assert.ok((await realpath(created.path)).startsWith(await realpath(homeA)));
		await manager.toggle(created.path, false);
		const settings = await readJson(join(homeA, ".pi", "agent", "settings.json"));
		assert.deepEqual(settings.prompts, ["-" + created.path]);
		assert.deepEqual(await readJson(join(localHome, ".pi", "agent", "settings.json")), { skills: ["-local-only"] });
	});
});

test("WSL ExtensionManager toggle 写目标 extensions 规则，不写本机", async () => {
	await withHomes(async ({ localHome, homeA }) => {
		const factories = createFactories();
		const manager = factories.extensions({ home: homeA, environment: { distro: "Ubuntu-26.04", user: "dev", linuxHome: "/home/dev", windowsHome: homeA } });
		const extensionPath = join(homeA, ".pi", "agent", "extensions", "local-ext.ts");
		await manager.toggleFromUi("local-ext.ts", false, "user", extensionPath);
		const settings = await readJson(join(homeA, ".pi", "agent", "settings.json"));
		assert.deepEqual(settings.extensions, ["-" + extensionPath]);
		assert.deepEqual(await readJson(join(localHome, ".pi", "agent", "settings.json")), { skills: ["-local-only"] });
	});
});
