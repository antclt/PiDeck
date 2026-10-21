/**
 * 输入预测开关的持久化语义：默认开启，只有字面 false 能关掉。
 *
 * 与 enhanceIncludeContext（默认关闭，只有字面 true 能开）相反——预测是**默认体验**，
 * 旧设置文件里没有这个字段时必须仍然开启；写坏的类型（字符串/数字/null）一律按默认值。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function makeStore(t) {
	const root = mkdtempSync(join(tmpdir(), "pideck-prompt-suggestion-settings-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "settings.json");
	const { SettingsStore } = loadTsCommonJs("src/main/settings/SettingsStore.ts", {
		stubs: {
			electron: { app: { getPath: () => root }, BrowserWindow: class {}, Menu: { setApplicationMenu: () => undefined } },
			"../logging/sharedLogger": { getAppLogger: () => undefined },
			"../git/gitExecutable": { setConfiguredGitPath: () => undefined },
		},
	});
	return {
		load: async (extra) => {
			if (extra !== undefined) writeFileSync(path, JSON.stringify({ installationType: "installed", chatContentWidthPct: 80, ...extra }));
			const store = new SettingsStore();
			await store.load();
			return store;
		},
		persisted: () => JSON.parse(readFileSync(path, "utf8")),
	};
}

test("新安装与旧设置默认开启，只有字面 false 能关闭", async (t) => {
	const h = makeStore(t);
	assert.equal((await h.load()).get().promptSuggestionEnabled, true);
	assert.equal((await h.load({})).get().promptSuggestionEnabled, true);
	for (const value of ["false", 0, {}, [], null, true]) {
		assert.equal((await h.load({ promptSuggestionEnabled: value })).get().promptSuggestionEnabled, true, JSON.stringify(value));
	}
	assert.equal((await h.load({ promptSuggestionEnabled: false })).get().promptSuggestionEnabled, false);
});

test("开关单独落盘：update 只接受布尔值，重载后保持", async (t) => {
	const h = makeStore(t);
	const store = await h.load({});
	assert.equal((await store.update({ promptSuggestionEnabled: false })).promptSuggestionEnabled, false);
	assert.equal(h.persisted().promptSuggestionEnabled, false);
	assert.equal((await h.load()).get().promptSuggestionEnabled, false);
	assert.equal((await store.update({ promptSuggestionEnabled: "false" })).promptSuggestionEnabled, false);
	assert.equal(h.persisted().promptSuggestionEnabled, false);
	assert.equal((await store.update({ promptSuggestionEnabled: true })).promptSuggestionEnabled, true);
	assert.equal(h.persisted().promptSuggestionEnabled, true);
});
