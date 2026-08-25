/**
 * 模型规格自动补全纯函数测试（utils/modelSpecAutoFill.ts）。
 *
 * 与 dsh-web 对齐：只填空字段；listing/pi-ai 没给的容量留空，不写 128k/8k。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
void join;

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
const { computeModelSpecPatches, collectModelSpecPatches } = mod;

function assertUpdates(updates, expected) {
	assert.equal(updates.length, expected.length);
	for (let i = 0; i < expected.length; i++) {
		assert.equal(updates[i][0], expected[i][0], `字段 ${expected[i][0]}`);
		const value = updates[i][1];
		const want = expected[i][1];
		if (Array.isArray(want)) {
			assert.ok(Array.isArray(value), `${expected[i][0]} 应为数组`);
			assert.equal(value.length, want.length);
			for (let j = 0; j < want.length; j++) assert.equal(value[j], want[j]);
		} else if (want && typeof want === "object") {
			assert.deepEqual(JSON.parse(JSON.stringify(value)), want);
		} else {
			assert.equal(value, want);
		}
	}
}

function fullSpec(overrides = {}) {
	return {
		contextWindow: 128000,
		maxTokens: 16384,
		reasoning: true,
		images: true,
		source: "pi-ai",
		matchedId: "gpt-4o",
		...overrides,
	};
}

test("computeModelSpecPatches: 全空字段填满", () => {
	const updates = computeModelSpecPatches({ id: "gpt-4o" }, fullSpec());
	assertUpdates(updates, [
		["contextWindow", 128000],
		["maxTokens", 16384],
		["reasoning", true],
		["input", ["text", "image"]],
	]);
});

test("computeModelSpecPatches: 手填值不覆盖", () => {
	const updates = computeModelSpecPatches(
		{ id: "gpt-4o", contextWindow: 999, maxTokens: 111, input: ["text"] },
		fullSpec(),
	);
	assertUpdates(updates, [["reasoning", true]]);
});

test("computeModelSpecPatches: 用户明确关掉的 reasoning=false 不覆盖", () => {
	const updates = computeModelSpecPatches({ id: "gpt-4o", reasoning: false }, fullSpec());
	assertUpdates(updates, [
		["contextWindow", 128000],
		["maxTokens", 16384],
		["input", ["text", "image"]],
	]);
});

test("computeModelSpecPatches: 规格缺 context/maxTokens → 留空，不填默认值", () => {
	const updates = computeModelSpecPatches(
		{ id: "sensenova-6.7-flash-lite" },
		fullSpec({ contextWindow: undefined, maxTokens: undefined }),
	);
	assertUpdates(updates, [
		["reasoning", true],
		["input", ["text", "image"]],
	]);
});

test("computeModelSpecPatches: 规格完全未命中 → 不填任何字段", () => {
	assert.equal(computeModelSpecPatches({ id: "my-custom-model" }, null).length, 0);
	assert.equal(
		computeModelSpecPatches({ id: "my-custom-model" }, { source: "pi-ai", matchedId: "my-custom-model" }).length,
		0,
	);
});

test("computeModelSpecPatches: 纯文本规格不填 input", () => {
	const updates = computeModelSpecPatches({ id: "deepseek-chat" }, fullSpec({ images: undefined }));
	assertUpdates(updates, [
		["contextWindow", 128000],
		["maxTokens", 16384],
		["reasoning", true],
	]);
});

test("computeModelSpecPatches: 非推理模型不下发 reasoning", () => {
	const updates = computeModelSpecPatches({ id: "x" }, fullSpec({ reasoning: undefined }));
	assert.equal(updates.some(([field]) => field === "reasoning"), false);
});

test("computeModelSpecPatches: 完整 thinkingLevelMap 与输入模态只补空字段", () => {
	const thinkingLevelMap = { off: null, high: "high", xhigh: "xhigh", max: "max" };
	const updates = computeModelSpecPatches(
		{ id: "gpt-5.6-luna" },
		fullSpec({ input: ["text", "image"], thinkingLevelMap }),
	);
	assertUpdates(updates, [
		["contextWindow", 128000],
		["maxTokens", 16384],
		["reasoning", true],
		["thinkingLevelMap", thinkingLevelMap],
		["input", ["text", "image"]],
	]);
	const protectedUpdates = computeModelSpecPatches(
		{ id: "gpt-5.6-luna", reasoning: false, thinkingLevelMap: { off: null }, input: ["text"] },
		fullSpec({ input: ["text", "image"], thinkingLevelMap }),
	);
	assert.equal(protectedUpdates.some(([field]) => field === "thinkingLevelMap" || field === "input"), false);
});

test("collectModelSpecPatches: 批量补全、计数、不修改入参、未命中留空", async () => {
	const models = {
		providers: {
			relay: {
				baseUrl: "https://relay.example",
				models: [
					{ id: "gpt-4o" },
					{ id: "filled", contextWindow: 999, reasoning: false },
					{ id: "" },
				],
			},
			other: {
				models: [{ id: "glm-5" }],
			},
		},
	};
	const lookedUp = [];
	const { providers, filledCount } = await collectModelSpecPatches(models, async (providerName, modelId) => {
		lookedUp.push(`${providerName}:${modelId}`);
		return modelId === "gpt-4o" ? fullSpec() : modelId === "glm-5" ? fullSpec({ contextWindow: undefined }) : null;
	});
	assert.equal(filledCount, 2);
	assert.deepEqual(lookedUp, ["relay:gpt-4o", "relay:filled", "other:glm-5"]);
	assert.equal(providers.relay.models[0].contextWindow, 128000);
	assert.equal(providers.relay.models[0].input[1], "image");
	assert.equal(providers.relay.models[1].contextWindow, 999);
	assert.equal(providers.relay.models[1].reasoning, false);
	assert.equal(providers.relay.models[1].maxTokens, undefined);
	assert.equal(providers.relay.models[2].id, "");
	assert.equal(providers.other.models[0].reasoning, true);
	assert.equal(providers.other.models[0].contextWindow, undefined);
	assert.equal(models.providers.relay.models[0].contextWindow, undefined);
	assert.equal(models.providers.other.models[0].reasoning, undefined);
	assert.equal(providers.relay.baseUrl, "https://relay.example");
});

test("collectModelSpecPatches: lookup 抛错按未命中处理，不阻断保存、不填默认值", async () => {
	const models = { providers: { a: { models: [{ id: "x" }, { id: "y" }] } } };
	const { providers, filledCount } = await collectModelSpecPatches(models, async (p, id) => {
		if (id === "x") throw new Error("boom");
		return fullSpec();
	});
	assert.equal(filledCount, 1);
	assert.equal(providers.a.models[0].contextWindow, undefined);
	assert.equal(providers.a.models[1].contextWindow, 128000);
});
