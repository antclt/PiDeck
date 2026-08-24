import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	summarizeSettingsUnsavedChanges,
	formatSettingsUnsavedMessage,
} = loadTsCommonJs("src/renderer/src/components/app/settings/unsavedChangesSummary.ts");
const i18n = loadTsCommonJs("src/renderer/src/i18n.ts");
const settingsModal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");

test("关闭确认按设置页顺序点名第一条，Git 模型相关字段合成一项", () => {
	const summary = summarizeSettingsUnsavedChanges({
		dirtyFields: ["gitCommitMessageModel", "theme", "gitCommitMessageProvider"],
	});
	// Git 区块已拆为独立 tab（开发者簇），按目录顺序「外观 → Git」第一条是主题
	assert.equal(summary.tabKey, "settings.tabs.appearance");
	assert.equal(summary.itemKey, "settings.theme");
	assert.equal(summary.totalCount, 2);
});

test("Git 模型相关字段合成一项并挂到 Git tab", () => {
	const summary = summarizeSettingsUnsavedChanges({
		dirtyFields: ["gitCommitMessageModel", "gitCommitMessageProvider"],
	});
	assert.equal(summary.tabKey, "settings.tabs.git");
	assert.equal(summary.itemKey, "settings.gitCommitMessageModel");
	assert.equal(summary.totalCount, 1);
});

test("视觉桥脏标记挂到视觉桥 tab，而不是当成未知 AppSettings 字段", () => {
	const summary = summarizeSettingsUnsavedChanges({
		dirtyFields: [],
		visionDirty: true,
	});
	assert.equal(summary.tabKey, "settings.tabs.vision");
	assert.equal(summary.itemKey, "settings.vision.section");
	assert.equal(summary.totalCount, 1);
});

test("未建目录的内部字段合成「其他选项」，不按 Set 插入顺序抢第一条", () => {
	const summary = summarizeSettingsUnsavedChanges({
		dirtyFields: ["sidebarExpandedProjectIds", "language"],
	});
	assert.equal(summary.tabKey, "settings.tabs.common");
	assert.equal(summary.itemKey, "settings.language");
	assert.equal(summary.totalCount, 2);
});

test("中文关闭文案带 tab 和项名；多项只展开第一条并带总数", () => {
	i18n.setI18nLocale("zh-CN");
	const one = formatSettingsUnsavedMessage(
		summarizeSettingsUnsavedChanges({ dirtyFields: ["theme"] }),
		i18n.t,
	);
	assert.equal(one, "「外观设置」的「主题」尚未保存，是否在关闭前保存？");

	const more = formatSettingsUnsavedMessage(
		summarizeSettingsUnsavedChanges({ dirtyFields: ["theme", "language"] }),
		i18n.t,
	);
	assert.equal(
		more,
		"「常用设置」的「语言」等共 2 项尚未保存，是否在关闭前保存？",
	);
});

test("SettingsModal 关闭确认使用摘要文案，而不是固定的 generic 句子", () => {
	assert.match(settingsModal, /formatSettingsUnsavedMessage/);
	assert.match(settingsModal, /summarizeSettingsUnsavedChanges/);
	assert.match(settingsModal, /unsavedCloseMessage/);
	assert.doesNotMatch(
		settingsModal,
		/AlertDialogDescription>\{t\("settings\.unsavedMessage"\)\}/,
	);
});
