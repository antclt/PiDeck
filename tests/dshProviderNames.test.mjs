import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDshDeepseekProvider } from "../src/shared/dshProviderNames.ts";

/**
 * DSH 官方 DeepSeek 的 provider 名归一化契约。
 *
 * 回归背景：DSH 配置面（settings.yaml llm-deepseek / 探针配置 key / 卡片行头）用
 * 规范名 "deepseek"，而 host 级 llm.models / session.models 的组 id 是
 * "deepseek-official"（模型选择器分组行与 runtime state 的 provider 都取组 id）。
 * 不归一化时「DSH 配置页能显示用量、模型选择器/圆球面板查不到」——组 id 命中不了
 * loadDshUsageProviderProfile 的 llm-deepseek 特判，掉进 pi/catalog 兜底判「暂不支持」。
 */
test("官方 DeepSeek 别名归一为规范名 deepseek", () => {
	assert.equal(normalizeDshDeepseekProvider("deepseek-official"), "deepseek");
	assert.equal(normalizeDshDeepseekProvider("llm-deepseek"), "deepseek");
});

test("规范名与其它 provider 名原样返回（含首尾空格 trim）", () => {
	assert.equal(normalizeDshDeepseekProvider("deepseek"), "deepseek");
	assert.equal(normalizeDshDeepseekProvider("  deepseek-official  "), "deepseek");
	assert.equal(normalizeDshDeepseekProvider("opencode-go"), "opencode-go");
	assert.equal(normalizeDshDeepseekProvider("wbx"), "wbx");
	assert.equal(normalizeDshDeepseekProvider("  opencode-go  "), "opencode-go");
});

test("空名/纯空格返回空串（调用方按未配置处理）", () => {
	assert.equal(normalizeDshDeepseekProvider(""), "");
	assert.equal(normalizeDshDeepseekProvider("   "), "");
});
