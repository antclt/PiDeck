import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveModelSpecFromPiCatalogs } = loadTsCommonJs(
  "src/main/pi/modelCapabilityResolver.ts",
);
const { buildPiAiCatalogIndex } = loadTsCommonJs("src/main/pi/piAiBuiltinCatalog.ts");

test("bundled pi-ai catalog fills a renamed third-party GPT model without changing its provider", () => {
  const index = buildPiAiCatalogIndex([
    // Marks openai as a built-in provider and carries the gpt-5.6 template.
    { provider: "openai", id: "gpt-5.6", name: "GPT-5.6", contextWindow: 400000, maxTokens: 128000, reasoning: true, input: ["text", "image"], thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } },
  ]);

  const spec = resolveModelSpecFromPiCatalogs(
    {
      providerName: "luna-relay",
      modelId: "GPT-5.6 Luna",
      modelName: "GPT-5.6 Luna",
    },
    index,
  );

  assert.equal(spec?.source, "pi-ai");
  assert.equal(spec?.matchKind, "name-alias");
  assert.equal(spec?.matchedId, "gpt-5.6");
  assert.equal(spec?.contextWindow, 400000);
  assert.equal(spec?.maxTokens, 128000);
  assert.equal(spec?.reasoning, true);
  assert.deepEqual(JSON.parse(JSON.stringify(spec?.input)), ["text", "image"]);
  assert.equal(spec?.thinkingLevelMap?.max, "max");
});

test("exact model id resolves across a third-party provider from bundled catalog", () => {
  const index = buildPiAiCatalogIndex([
    { provider: "openai", id: "gpt-5.6", contextWindow: 400000 },
  ]);

  const spec = resolveModelSpecFromPiCatalogs(
    { providerName: "luna-relay", modelId: "gpt-5.6" },
    index,
  );

  assert.equal(spec?.source, "pi-ai");
  assert.equal(spec?.matchKind, "model-id");
  assert.equal(spec?.matchedId, "gpt-5.6");
  assert.equal(spec?.contextWindow, 400000);
});

test("unknown model resolves to null instead of guessing", () => {
  const index = buildPiAiCatalogIndex([
    { provider: "openai", id: "gpt-4o", contextWindow: 128000 },
  ]);

  const spec = resolveModelSpecFromPiCatalogs(
    { providerName: "luna-relay", modelId: "luna-pro-2026-beta" },
    index,
  );

  assert.equal(spec, null);
});
