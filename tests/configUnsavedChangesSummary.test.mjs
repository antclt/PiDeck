import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	summarizeConfigUnsavedChanges,
	formatConfigUnsavedMessage,
} = loadTsCommonJs("src/renderer/src/config/configUnsavedChangesSummary.ts");
const i18n = loadTsCommonJs("src/renderer/src/i18n.ts");
const configModal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
const dshTab = readFileSync("src/renderer/src/config/DshConfigTab.tsx", "utf8");

test("dsh:<nav> 归并到 DSH 后端 + 对应导航名；config:* 归 Pi 侧", () => {
	const summary = summarizeConfigUnsavedChanges(["dsh:models:dsh:llm-pi-ai", "config:auth"]);
	assert.equal(summary.tabKey, "config.backend.dsh");
	assert.equal(summary.itemKey, "config.dsh.tab.models");
	assert.equal(summary.totalCount, 2);
});

test("聚合 dsh key（无导航段）回退到 DSH 标题而不是崩溃", () => {
	const summary = summarizeConfigUnsavedChanges(["dsh"]);
	assert.equal(summary.itemKey, "config.dsh.title");
});

test("无脏标记时回退到通用未保存文案", () => {
	assert.equal(summarizeConfigUnsavedChanges([]), null);
	assert.equal(
		formatConfigUnsavedMessage(null, (key) => `#${key}`),
		"#config.unsavedMessage",
	);
});

test("多条脏 tab 时文案带计数，插值用单花括号（t() 契约）", () => {
	const zh = String(i18n.exports?.rendererCopy ?? "");
	const summary = summarizeConfigUnsavedChanges(["config:models", "security"]);
	const text = formatConfigUnsavedMessage(summary, (key, params) =>
		params ? `${key}:${JSON.stringify(params)}` : key,
	);
	assert.match(text, /count/);
	assert.doesNotMatch(zh, /\{\{tab\}\}/);
});

test("装配契约：关闭确认用点名文案，DSH 导航与顶层分页有黄点来源", () => {
	assert.match(configModal, /formatConfigUnsavedMessage\(summarizeConfigUnsavedChanges\(dirtyTabs\), t\)/);
	assert.match(configModal, /dirtyNavIds=\{dshDirtyNavIds\}/);
	assert.match(configModal, /hasDshDirty \? <span className="size-1\.5 rounded-full bg-amber-500"/);
	assert.match(dshTab, /dirtyNavIds\?\.has\(`dsh:\$\{item\.id\}`\)/);
});

test("DSH 子分区使用稳定脏 key，侧栏黄点才能归并到导航", () => {
	// dsh:auth 分区已被重构移除（凭证并入 security），断言只保留现有稳定分区。
	for (const key of ['instanceKey="dsh:presets"', 'instanceKey="dsh:security"', 'instanceKey="dsh:raw"']) {
		assert.ok(dshTab.includes(key), `missing ${key}`);
	}
	assert.match(dshTab, /instanceKey=\{`dsh:models:\$\{ns\.ns\}`\}/);
	assert.match(dshTab, /instanceKey=\{`dsh:plugins:\$\{ns\.ns\}`\}/);
});
