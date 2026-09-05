import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

/** 加载 PromptManager.ts（transpile + vm 沙箱，mock electron/trash/WslPaths）。 */
function loadPromptManagerModule() {
	const source = readFileSync("src/main/prompts/PromptManager.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = {
		exports: {},
		require: (id) => {
			if (id === "electron") return { shell: { openPath: async () => "" } };
			if (id === "../fs/trash") return { trashPath: async () => {} };
			if (id === "../wsl/WslPaths") {
				return { parseWslUncPath: () => null, toWindowsHostPath: (path) => path };
			}
			return require(id);
		},
	};
	sandbox.global = sandbox;
	vm.runInNewContext(outputText, sandbox, { filename: "PromptManager.ts" });
	return sandbox.exports;
}

async function withTemporaryHome(run) {
	const home = await mkdtemp(join(tmpdir(), "pideck-prompt-manager-"));
	try {
		await run(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test("toggle 同步持久化 PiDeck settings 禁用列表（模板白名单模式依据）", async () => {
	await withTemporaryHome(async (home) => {
		const { PromptManager } = loadPromptManagerModule();
		const manager = new PromptManager(home);
		const target = join(home, ".pi", "agent", "prompts", "review.md");
		await mkdir(join(home, ".pi", "agent", "prompts"), { recursive: true });
		await writeFile(target, "---\ndescription: review prompt\n---\n\nReview the code.\n", "utf8");

		// 内存 settings 替身：模拟 SettingsStore 的 get/update 语义
		const settings = { disabledPrompts: [] };
		manager.configureSettings(
			() => settings,
			(patch) => {
				Object.assign(settings, patch);
				return Promise.resolve(settings);
			},
		);

		// 禁用：settings 列表写入
		const disabled = await manager.toggle(target, false);
		assert.equal(disabled.enabled, false);
		assert.deepEqual(settings.disabledPrompts, ["review"]);
		const afterDisable = await manager.list();
		assert.equal(afterDisable.templates.find((t) => t.path === target).enabled, false);

		// 启用：从 settings 列表移除（名称大小写不敏感去重）
		const enabled = await manager.toggle(target, true);
		assert.equal(enabled.enabled, true);
		assert.deepEqual(settings.disabledPrompts, []);
		const afterEnable = await manager.list();
		assert.equal(afterEnable.templates.find((t) => t.path === target).enabled, true);
	});
});

test("内置推荐模板（builtin://）不可禁用；list 中始终为启用态", async () => {
	await withTemporaryHome(async (home) => {
		const { PromptManager } = loadPromptManagerModule();
		const manager = new PromptManager(home);
		const settings = { disabledPrompts: [] };
		manager.configureSettings(
			() => settings,
			(patch) => {
				Object.assign(settings, patch);
				return Promise.resolve(settings);
			},
		);

		const { templates } = await manager.list();
		const builtin = templates.find((t) => t.path.startsWith("builtin://"));
		assert.ok(builtin, "内置模板应存在");
		assert.equal(builtin.enabled, true);
		await assert.rejects(manager.toggle(builtin.path, false));
		assert.deepEqual(settings.disabledPrompts, [], "内置模板不应写入禁用列表");
	});
});
