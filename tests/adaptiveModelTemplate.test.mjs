/**
 * 自适应模板纯函数测试（utils/modelSpecAutoFill.ts 的 merge/apply 部分）。
 *
 * 规则：
 * - mergeAdaptiveModelTemplate：endpoint /models 实报字段优先，bundled catalog 模板补空；
 * - applyAdaptiveTemplateReset：先清空五个能力字段，再只写模板有值的字段（落盘即空）。
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
void __dirname;

function compileModule(filePath) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, require: nodeRequire, console }, { filename: filePath });
	return module.exports;
}

const mod = compileModule("src/renderer/src/utils/modelSpecAutoFill.ts");
const { mergeAdaptiveModelTemplate, applyAdaptiveTemplateReset } = mod;

function catalogSpec(overrides = {}) {
	return {
		contextWindow: 400000,
		maxTokens: 128000,
		reasoning: true,
		input: ["text", "image"],
		thinkingLevelMap: { off: null, high: "high", xhigh: "xhigh", max: "max" },
		source: "pi-ai",
		matchedId: "gpt-5.6",
		...overrides,
	};
}

function listing(overrides = {}) {
	return { id: "gpt-5.6", ...overrides };
}

function plainModel(model) {
	return JSON.parse(JSON.stringify(model));
}

test("merge: endpoint 实报字段优先于 catalog 模板", () => {
	const template = mergeAdaptiveModelTemplate(
		listing({ contextWindow: 200000, maxTokens: 65536 }),
		catalogSpec(),
	);
	assert.equal(template.contextWindow, 200000);
	assert.equal(template.maxTokens, 65536);
	// catalog 独有的字段照常补上
	assert.equal(template.reasoning, true);
	assert.deepEqual(JSON.parse(JSON.stringify(template.input)), ["text", "image"]);
	assert.equal(template.thinkingLevelMap?.max, "max");
	assert.equal(template.matchedId, "gpt-5.6");
});

test("merge: 无 endpoint listing 时全部来自 catalog", () => {
	const template = mergeAdaptiveModelTemplate(undefined, catalogSpec());
	assert.equal(template.contextWindow, 400000);
	assert.equal(template.maxTokens, 128000);
	assert.equal(template.reasoning, true);
});

test("merge: 无 catalog 模板时只用 endpoint 实报字段", () => {
	const template = mergeAdaptiveModelTemplate(listing({ contextWindow: 64000 }), null);
	assert.equal(template.contextWindow, 64000);
	assert.equal(template.maxTokens, undefined);
	assert.equal(template.reasoning, undefined);
	assert.equal(template.matchedId, undefined);
});

test("merge: 都无数据时空模板，不猜默认值", () => {
	const template = mergeAdaptiveModelTemplate(undefined, null);
	assert.deepEqual(JSON.parse(JSON.stringify(template)), {});
});

test("reset: 清空五个能力字段后写模板有值字段", () => {
	const next = applyAdaptiveTemplateReset(
		{
			id: "gpt-5.6",
			contextWindow: 999,
			maxTokens: 111,
			input: ["text"],
			reasoning: false,
			thinkingLevelMap: { off: null },
		},
		mergeAdaptiveModelTemplate(listing({ contextWindow: 200000 }), catalogSpec()),
	);
	assert.equal(next.contextWindow, 200000);
	assert.equal(next.maxTokens, 128000);
	assert.equal(next.reasoning, true);
	assert.deepEqual(JSON.parse(JSON.stringify(next.input)), ["text", "image"]);
	assert.equal(next.thinkingLevelMap?.max, "max");
	// 用户字段被模板覆盖（重置是显式动作）
	assert.equal(next.contextWindow, 200000);
});

test("reset: 模板缺失的字段不写入（落盘即空）", () => {
	const next = applyAdaptiveTemplateReset(
		{ id: "unknown-model", contextWindow: 100, maxTokens: 200, reasoning: true, input: ["text"] },
		{},
	);
	assert.deepEqual(plainModel(next), { id: "unknown-model" });
});

test("reset: 纯文本模板显式清掉图片输入与 reasoning", () => {
	const next = applyAdaptiveTemplateReset(
		{ id: "deepseek-chat", input: ["text", "image"], reasoning: true, thinkingLevelMap: { max: "max" } },
		mergeAdaptiveModelTemplate(undefined, catalogSpec({ input: ["text"], reasoning: false, thinkingLevelMap: undefined })),
	);
	assert.deepEqual(JSON.parse(JSON.stringify(next.input)), ["text"]);
	assert.equal(next.reasoning, false);
	assert.equal(next.thinkingLevelMap, undefined);
});
