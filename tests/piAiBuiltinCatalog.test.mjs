/**
 * pi-ai 内置目录匹配 + listing 解析（替代 sqlite model-specs）。
 *
 * 覆盖：精确 id / 大小写 / 路径尾段命中；contains 不误匹配；
 * listing 容量优先、catalog 只补空字段；真实 catalog 能读到 gpt-4o。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const catalog = loadTsCommonJs("src/main/pi/piAiBuiltinCatalog.ts");
const { parseProviderModelsResponse } = loadTsCommonJs("src/main/config/parseProviderModels.ts");
const {
	buildPiAiCatalogIndex,
	lookupPiAiCatalogEntry,
	getPiAiCatalogIndex,
	positiveInt,
} = catalog;

function sampleIndex() {
	return buildPiAiCatalogIndex([
		{
			id: "gpt-4o",
			name: "GPT-4o",
			provider: "openai",
			contextWindow: 128000,
			maxTokens: 16384,
			reasoning: false,
			input: ["text", "image"],
		},
		{
			id: "gpt-4o",
			name: "GPT-4o (gateway)",
			provider: "opencode",
			contextWindow: 128000,
			maxTokens: 16384,
		},
		{
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			provider: "deepseek",
			contextWindow: 1000000,
			maxTokens: 384000,
			reasoning: true,
			thinkingLevelMap: { off: null, low: "low", high: "high", xhigh: "xhigh", max: "max" },
			input: ["text"],
		},
		{
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			provider: "anthropic",
			contextWindow: 1000000,
			maxTokens: 64000,
			reasoning: true,
			input: ["text", "image"],
		},
	]);
}

test("positiveInt: 只接受正整数", () => {
	assert.equal(positiveInt(128000), 128000);
	assert.equal(positiveInt(0), undefined);
	assert.equal(positiveInt(-1), undefined);
	assert.equal(positiveInt(1.5), undefined);
	assert.equal(positiveInt("128000"), undefined);
});

test("lookup: 精确 id / 本 provider 优先 / 跨 provider 中转站命中", () => {
	const index = sampleIndex();
	const openai = lookupPiAiCatalogEntry(index, "openai", "gpt-4o");
	assert.equal(openai?.provider, "openai");
	const relay = lookupPiAiCatalogEntry(index, "myrelay", "gpt-4o");
	assert.equal(relay?.id, "gpt-4o");
	assert.equal(relay?.contextWindow, 128000);
	const named = lookupPiAiCatalogEntry(index, "opencode", "gpt-4o");
	assert.equal(named?.provider, "opencode");
});

test("lookup: 大小写与路径尾段命中，contains 不误匹配", () => {
	const index = sampleIndex();
	assert.equal(lookupPiAiCatalogEntry(index, "relay", "GPT-4O")?.id, "gpt-4o");
	assert.equal(lookupPiAiCatalogEntry(index, "relay", "openai/gpt-4o")?.id, "gpt-4o");
	assert.equal(lookupPiAiCatalogEntry(index, "relay", "gpt-4"), undefined);
	assert.equal(lookupPiAiCatalogEntry(index, "relay", "claude"), undefined);
	assert.equal(lookupPiAiCatalogEntry(index, "relay", ""), undefined);
});

test("parseProviderModelsResponse: 读 listing 容量字段，缺则省略", () => {
	const models = parseProviderModelsResponse({
		data: [
			{
				id: "foo",
				name: "Foo Display",
				context_window: 64000,
				max_output_tokens: 4096,
			},
			{ id: "bar", context_length: 128000, max_tokens: 8192 },
			{ id: "bare" },
			{ display_name: "no-id" },
			{ id: "", name: "empty" },
		],
	});
	assert.deepEqual(JSON.parse(JSON.stringify(models)), [
		{ id: "foo", name: "Foo Display", contextWindow: 64000, maxTokens: 4096 },
		{ id: "bar", contextWindow: 128000, maxTokens: 8192 },
		{ id: "bare" },
	]);
});

test("parseProviderModelsResponse: Gemini models/ 前缀与 inputTokenLimit", () => {
	const models = parseProviderModelsResponse(
		{
			models: [
				{
					name: "models/gemini-2.5-pro",
					displayName: "Gemini 2.5 Pro",
					inputTokenLimit: 1048576,
					outputTokenLimit: 65536,
				},
			],
		},
		"google-generative-ai",
	);
	assert.deepEqual(JSON.parse(JSON.stringify(models)), [
		{
			id: "gemini-2.5-pro",
			name: "Gemini 2.5 Pro",
			contextWindow: 1048576,
			maxTokens: 65536,
		},
	]);
});

test("真实 pi-ai catalog：gpt-4o 有 contextWindow", () => {
	const entry = lookupPiAiCatalogEntry(getPiAiCatalogIndex(), "openai", "gpt-4o");
	assert.ok(entry, "gpt-4o 应命中 pi-ai 目录");
	assert.ok(entry.contextWindow != null && entry.contextWindow > 0, "gpt-4o 应有 contextWindow");
	assert.equal(
		lookupPiAiCatalogEntry(getPiAiCatalogIndex(), "myrelay", "definitely-not-a-model-xyz"),
		undefined,
	);
});
