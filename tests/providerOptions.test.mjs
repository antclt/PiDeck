import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}) });
	return module.exports;
}

const { collectProviderOptions } = compile("src/renderer/src/config/providerOptions.ts");

test("默认供应商候选聚合 providers + auth + discovered 三处来源", () => {
	const options = collectProviderOptions(
		{ providers: { tr: {}, opencode: {} } },
		{ bailu: {} },
		{ shangtang: [{ id: "sensenova-6.7-flash-lite" }] },
	);
	assert.deepEqual(
		Array.from(options).map((option) => option.value),
		["tr", "opencode", "bailu", "shangtang"],
	);
});

test("复现：仅 discovered 存在的供应商必须在候选里（漏掉即「无匹配选项」）", () => {
	const options = collectProviderOptions(
		{ providers: { tr: {} } },
		undefined,
		{ shangtang: [{ id: "m1" }] },
	);
	assert.ok(
		options.some((option) => option.value === "shangtang"),
		"discovered-only 供应商必须出现在默认供应商候选里",
	);
});

test("三处来源为空/未加载时返回空数组", () => {
	assert.equal(collectProviderOptions(undefined, undefined, undefined).length, 0);
	assert.equal(collectProviderOptions({ providers: {} }, {}, {}).length, 0);
});

test("同名供应商去重（三处来源都出现只保留一个候选）", () => {
	const options = collectProviderOptions(
		{ providers: { tr: {} } },
		{ tr: {} },
		{ tr: [{ id: "m1" }] },
	);
	assert.equal(options.filter((option) => option.value === "tr").length, 1);
});
