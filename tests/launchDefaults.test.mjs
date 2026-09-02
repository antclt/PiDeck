import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// resolveLaunchDefaultOptions：会话「默认启动偏好」解析器。
// createDraft 缺省填充与引导页底栏预选共用同一解析，保证「展示的默认」与
// 「首次发送真实套用的默认」一致——这里锁住降级规则，防止两边再次分叉。

function loadResolver() {
	const source = readFileSync("src/main/sessions/launchDefaults.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: "launchDefaults.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: () => ({}),
	}, { filename: "launchDefaults.ts" });
	return module.exports.resolveLaunchDefaultOptions;
}

const resolve = loadResolver();

// vm 独立 realm 里创建的对象原型不同，deepEqual 会误报；JSON 往返归一到宿主 realm。
const plain = (value) => (value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value);

test("pi backend prefers strict provider+model pair from settings", () => {
	const result = resolve({
		settings: { defaultProvider: "anthropic", defaultModel: "claude-opus-4-6" },
		models: {
			providers: {
				openai: { models: [{ id: "gpt-5.2" }] },
				anthropic: { models: [{ id: "claude-opus-4-6" }] },
			},
		},
	});
	assert.deepEqual(plain(result.model), { provider: "anthropic", modelId: "claude-opus-4-6" });
	assert.equal(result.thinkingLevel, undefined);
});

test("settings 显式默认指向已删除供应商/模型时回退第一个可用（删除后不再默认幽灵）", () => {
	const result = resolve({
		settings: { defaultProvider: "deleted-provider", defaultModel: "deleted-model" },
		models: {
			providers: {
				openai: { models: [{ id: "gpt-5.2" }] },
			},
		},
	});
	assert.deepEqual(plain(result.model), { provider: "openai", modelId: "gpt-5.2" });
});

test("lastUsed（最后一次使用）优先于 settings 显式默认", () => {
	const result = resolve({
		settings: { defaultProvider: "openai", defaultModel: "gpt-5.2" },
		models: {
			providers: {
				openai: { models: [{ id: "gpt-5.2" }] },
				zhipu: { models: [{ id: "glm-5" }] },
			},
		},
		lastUsedModel: { provider: "zhipu", modelId: "glm-5" },
	});
	assert.deepEqual(plain(result.model), { provider: "zhipu", modelId: "glm-5" });
});

test("lastUsed 指向已删除模型时回退 settings 显式默认", () => {
	const result = resolve({
		settings: { defaultProvider: "openai", defaultModel: "gpt-5.2" },
		models: {
			providers: {
				openai: { models: [{ id: "gpt-5.2" }] },
			},
		},
		// 用户删除了 zhipu：lastUsed 校验存在性失败，应回退仍有效的显式默认
		lastUsedModel: { provider: "zhipu", modelId: "glm-5" },
	});
	assert.deepEqual(plain(result.model), { provider: "openai", modelId: "gpt-5.2" });
});

test("lastUsed 与 settings 默认都被删除时回退第一个可用", () => {
	const result = resolve({
		settings: { defaultProvider: "openai", defaultModel: "gpt-5.2" },
		models: {
			providers: {
				deepseek: { models: [{ id: "deepseek-chat" }] },
			},
		},
		lastUsedModel: { provider: "openai", modelId: "gpt-5.2" },
	});
	assert.deepEqual(plain(result.model), { provider: "deepseek", modelId: "deepseek-chat" });
});

test("lastUsed 非法形状（非对象/半结构）被忽略并回退", () => {
	const models = {
		providers: { openai: { models: [{ id: "gpt-5.2" }] } },
	};
	for (const bad of [null, "zhipu/glm-5", { provider: "zhipu" }, { modelId: "glm-5" }, { provider: 42, modelId: "x" }]) {
		const result = resolve({ settings: {}, models, lastUsedModel: bad });
		assert.deepEqual(plain(result.model), { provider: "openai", modelId: "gpt-5.2" });
	}
});

test("dsh 后端忽略 lastUsed（模型归属 host settings）", () => {
	const result = resolve({
		backend: "dsh",
		settings: { defaultThinkingLevel: "high" },
		models: { providers: { openai: { models: [{ id: "gpt-5.2" }] } } },
		lastUsedModel: { provider: "openai", modelId: "gpt-5.2" },
	});
	assert.equal(result.model, undefined);
	assert.equal(result.thinkingLevel, "high");
});

test("half-configured settings fall back to first provider/model of models.json", () => {
	const result = resolve({
		// 只有 defaultProvider 没有 defaultModel：半配置不许进回退歧义
		settings: { defaultProvider: "anthropic" },
		models: {
			providers: {
				openai: { models: [{ id: "gpt-5.2" }, { id: "gpt-5.2-mini" }] },
				zhipu: { models: [{ id: "glm-5" }] },
			},
		},
	});
	// Object.keys 顺序即 JSON 书写顺序，取第一个 provider 的第一个模型
	assert.deepEqual(plain(result.model), { provider: "openai", modelId: "gpt-5.2" });
});

test("models.json fallback skips malformed providers until a usable model is found", () => {
	const result = resolve({
		settings: {},
		models: {
			providers: {
				broken: null,
				empty: { models: [] },
				noModelsField: {},
				good: { models: [{ id: "kimi-k7" }] },
			},
		},
	});
	assert.deepEqual(plain(result.model), { provider: "good", modelId: "kimi-k7" });
});

test("thinking level resolves for dsh backend while model stays unset", () => {
	const result = resolve({
		backend: "dsh",
		settings: { defaultThinkingLevel: "high", defaultModel: "should-be-ignored" },
		models: { providers: { openai: { models: [{ id: "x" }] } } },
	});
	// pi 的模型配置对 DSH 无意义（模型路由由 host settings 决定），model 必须为空
	assert.equal(result.model, undefined);
	assert.equal(result.thinkingLevel, "high");
});

test("dirty inputs degrade to empty defaults instead of throwing", () => {
	const cases = [
		{ settings: null, models: undefined },
		{ settings: ["not", "an", "object"], models: 42 },
		{ settings: { defaultThinkingLevel: 3 }, models: { providers: {} } },
	];
	for (const input of cases) {
		assert.deepEqual(plain(resolve({ ...input })), {});
	}
});
