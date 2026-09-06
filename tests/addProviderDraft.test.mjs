import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildProviderConfigFromDraft } = loadTsCommonJs(
  "src/renderer/src/config/addProviderDraft.ts",
);

// loadTsCommonJs 在独立 VM realm 执行，对象原型不同导致 deepStrictEqual 报
// “same structure but not reference-equal”，统一用 JSON 比较跨 realm 结果。
const json = (value) => JSON.stringify(value);

function emptyDraft() {
  return {
    name: "deepseek",
    baseUrl: "",
    api: "",
    apiKey: "",
    userAgent: "",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  };
}

test("空草稿：只写 models: []，不写入任何空字段（与手写 models.json 一致）", () => {
  const provider = buildProviderConfigFromDraft(emptyDraft());
  assert.equal(json(provider), json({ models: [] }));
});

test("完整草稿：baseUrl/api/apiKey 原样写入并 trim", () => {
  const provider = buildProviderConfigFromDraft({
    ...emptyDraft(),
    baseUrl: "  https://api.deepseek.com/v1  ",
    api: "openai-completions",
    apiKey: "  sk-test  ",
  });
  assert.equal(provider.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(provider.api, "openai-completions");
  assert.equal(provider.apiKey, "sk-test");
  assert.equal(json(provider.models), json([]));
});

test("User-Agent 草稿：写入 headers（与卡片手填同一存储位置）", () => {
  const provider = buildProviderConfigFromDraft({
    ...emptyDraft(),
    userAgent: "pi-coding-agent",
  });
  assert.equal(json(provider.headers), json({ "User-Agent": "pi-coding-agent" }));
});

test("compat 全 false 不写入（与 pi 默认一致）", () => {
  const provider = buildProviderConfigFromDraft(emptyDraft());
  assert.equal(provider.compat, undefined);
});

test("compat 勾选任一项即写入两个布尔字段", () => {
  const devRole = buildProviderConfigFromDraft({
    ...emptyDraft(),
    compat: { supportsDeveloperRole: true, supportsReasoningEffort: false },
  });
  assert.equal(
    json(devRole.compat),
    json({ supportsDeveloperRole: true, supportsReasoningEffort: false }),
  );

  const reasoning = buildProviderConfigFromDraft({
    ...emptyDraft(),
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
  });
  assert.equal(
    json(reasoning.compat),
    json({ supportsDeveloperRole: false, supportsReasoningEffort: true }),
  );
});
