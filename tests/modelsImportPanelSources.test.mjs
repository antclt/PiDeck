import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 契约测试：导入面板双源共存（ADR 0024）。
// 「导入」按钮必须同时保留两条入口：modelsTransfer 粘贴/文件导入（默认）与本机工具发现导入。
// 正则空白容忍（AGENTS.md：改格式不得整组断言失败）。

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const panel = read("src/renderer/src/config/ModelsImportPanel.tsx");
const pasteStep = read("src/renderer/src/config/ModelsImportPasteStep.tsx");
const discoverStep = read("src/renderer/src/config/ModelsImportDiscoverStep.tsx");
const modelsTab = read("src/renderer/src/config/ModelsTab.tsx");
const zhCn = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const enUs = read("src/renderer/src/i18n/rendererCopy.en-US.ts");
const zhTw = read("src/renderer/src/i18n/rendererCopy.zh-TW.ts");

test("导入面板外壳挂载两个入口组件并在入口步切换", () => {
	// 双源挂载：两个步骤组件都出现在面板里（hidden 切换、常驻保留状态）
	assert.match(panel, /<ModelsImportPasteStep\b/);
	assert.match(panel, /<ModelsImportDiscoverStep\b/);
	// 粘贴/文件入口是默认源
	assert.match(panel, /useState<[^>]+>\s*\(\s*"paste"\s*\)/);
	// 选项卡只在入口步渲染（进入勾选/冲突流程后隐藏）
	assert.match(panel, /step\s*===\s*"entry"[^;]*&&[\s\S]*?tabPaste/);
	// 两源汇入同一条勾选→冲突→应用流程
	assert.match(panel, /handleImported/);
});

test("粘贴/文件入口保留旧解析链路（Base64+可选密码+文件）", () => {
	assert.match(pasteStep, /decodeModelsTransfer/);
	assert.match(pasteStep, /encrypted-no-password/);
	assert.match(pasteStep, /wrong-password|unsupported-version|wrong-kind/);
	// 4MiB 文件上限
	assert.match(pasteStep, /4\s*\*\s*1024\s*\*\s*1024/);
});

test("本机工具发现入口懒扫描且仅激活时首扫", () => {
	assert.match(discoverStep, /discoverExternalAgents/);
	assert.match(discoverStep, /resolveExternalAgentKey/);
	// 懒扫描：非激活或已扫过直接跳过，激活首扫才调 handleScan
	assert.match(discoverStep, /!\s*props\.active\s*\|\|\s*scannedOnce\.current[\s\S]*?handleScan\(\)/);
});

test("ModelsTab 按钮使用统一导入入口键 importButton", () => {
	assert.match(modelsTab, /config\.models\.transfer\.importButton/);
	assert.doesNotMatch(modelsTab, /config\.models\.transfer\.discoverButton/);
});

const pasteKeys = ["importButton", "pasteLabel", "pastePlaceholder", "pickFile", "parse", "needPassword", "wrongPassword", "unsupportedVersion", "wrongKind", "tabPaste", "tabDiscover"];

test("三词典都包含双源导入所需文案键", () => {
	for (const dict of [zhCn, enUs, zhTw]) {
		for (const key of pasteKeys) {
			assert.match(dict, new RegExp(`config\\.models\\.transfer\\.${key}\"\s*:`), `missing key ${key}`);
		}
	}
});

test("已废弃的 discoverButton/discoverTitle 不再残留于词典", () => {
	for (const dict of [zhCn, enUs, zhTw]) {
		assert.doesNotMatch(dict, /config\.models\.transfer\.discover(Button|Title)\"/);
	}
});
