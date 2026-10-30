import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * WSL 资源开关 settings 写入器（task-16）：写入必须落在该目标的 .pi/agent/settings.json，
 * 绝不触碰本机 settings；带 state 时扩展包开关可恢复，缺 state 时明确失败。
 */

const { createWslResourceSettings } = loadTsCommonJs("src/main/config/WslResourceSettings.ts");
const { PiResourceStateStore } = loadTsCommonJs("src/main/config/PiResourceStateStore.ts");

async function withHomes(run) {
	const root = await mkdtemp(join(tmpdir(), "pideck-wsl-settings-"));
	const homeA = join(root, "home-a");
	const homeB = join(root, "home-b");
	await mkdir(join(homeA, ".pi", "agent"), { recursive: true });
	await mkdir(join(homeB, ".pi", "agent"), { recursive: true });
	try {
		await run({ root, homeA, homeB });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function readSettings(home) {
	const path = join(home, ".pi", "agent", "settings.json");
	if (!existsSync(path)) return null;
	return JSON.parse(await readFile(path, "utf8"));
}

test("skills/prompts 文件开关只写目标 HOME，两档案互不可见", async () => {
	await withHomes(async ({ homeA, homeB }) => {
		const a = createWslResourceSettings({ home: homeA });
		const b = createWslResourceSettings({ home: homeB });
		const skillPath = join(homeA, ".pi", "agent", "skills", "alpha");
		assert.equal((await a.setFileEnabled("skills", skillPath, false)).ok, true);
		const settingsA = await readSettings(homeA);
		assert.deepEqual(settingsA.skills, ["-" + skillPath]);
		assert.equal(a.fileEnabled("skills", skillPath), false);
		assert.equal(await readSettings(homeB), null, "B 的 settings 不得被 A 的写入创建");
		assert.equal(b.fileEnabled("skills", skillPath), undefined);

		const promptPath = join(homeA, ".pi", "agent", "prompts", "p.md");
		assert.equal((await a.setFileEnabled("prompts", promptPath, false)).ok, true);
		assert.deepEqual((await readSettings(homeA)).prompts, ["-" + promptPath]);
		// 再启用：精确规则翻回 +，不清除其它类别。
		assert.equal((await a.setFileEnabled("skills", skillPath, true)).ok, true);
		assert.deepEqual((await readSettings(homeA)).skills, ["+" + skillPath]);
	});
});

test("扩展本地文件开关写目标 extensions 规则；读取器投影 enabled", async () => {
	await withHomes(async ({ homeA }) => {
		const settings = createWslResourceSettings({ home: homeA });
		const extensionPath = join(homeA, ".pi", "agent", "extensions", "local-ext.ts");
		assert.equal((await settings.setExtensionEnabled({ source: "local-ext.ts", path: extensionPath, enabled: false })).ok, true);
		assert.deepEqual((await readSettings(homeA)).extensions, ["-" + extensionPath]);
		assert.deepEqual(JSON.parse(JSON.stringify(settings.extensionState({ source: "local-ext.ts", path: extensionPath }))), { enabled: false });
	});
});

test("扩展包开关：缺 state 明确失败且不写文件；有 state 时可写 packages 并留恢复快照", async () => {
	await withHomes(async ({ root, homeA }) => {
		await writeFile(join(homeA, ".pi", "agent", "settings.json"), JSON.stringify({ packages: ["npm:foo"] }, null, 2), "utf8");
		const withoutState = createWslResourceSettings({ home: homeA });
		const refused = await withoutState.setExtensionEnabled({ source: "npm:foo", enabled: false });
		assert.equal(refused.ok, false);
		assert.match(refused.error, /resource state/);
		assert.deepEqual((await readSettings(homeA)).packages, ["npm:foo"], "失败时不得改写 packages");

		const state = new PiResourceStateStore(join(root, "pi-native-resources.json"));
		const withState = createWslResourceSettings({ home: homeA, state });
		assert.equal((await withState.setExtensionEnabled({ source: "npm:foo", enabled: false })).ok, true);
		const packages = (await readSettings(homeA)).packages;
		assert.equal(typeof packages[0], "object");
		assert.ok(JSON.stringify(packages[0]).includes("extensions"));
	});
});
