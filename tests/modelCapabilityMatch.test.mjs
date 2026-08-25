import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
  findModelCapabilityMatch,
  modelCapabilityMatchToSpec,
  normalizeModelIdentity,
  parseThinkingLevelMap,
} = loadTsCommonJs("src/main/pi/modelCapabilityMatch.ts");

function candidate(overrides = {}) {
  return {
    source: "pi-ai",
    provider: "openai",
    id: "gpt-5.6",
    contextWindow: 400000,
    maxTokens: 128000,
    reasoning: true,
    input: ["text", "image"],
    thinkingLevelMap: {
      off: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    ...overrides,
  };
}

test("normalizeModelIdentity keeps model-family boundaries across proxy spelling", () => {
  assert.equal(normalizeModelIdentity("GPT-5.6 Luna"), "gpt-5-6-luna");
  assert.equal(normalizeModelIdentity("openai/gpt_5_6"), "openai-gpt-5-6");
});

test("parseThinkingLevelMap accepts only Pi's finite map and preserves explicit null", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(parseThinkingLevelMap({ off: null, high: "high", bogus: "x", max: "" }))),
    { off: null, high: "high" },
  );
  assert.equal(parseThinkingLevelMap({ bogus: "x" }), undefined);
});

test("exact model id resolves across a third-party provider", () => {
  const match = findModelCapabilityMatch(
    { providerName: "luna-relay", modelId: "gpt-5.6" },
    [candidate()],
  );
  assert.equal(match?.matchKind, "model-id");
  assert.equal(match?.candidate.id, "gpt-5.6");
});

test("unique proxy alias adopts the longest canonical model family", () => {
  const match = findModelCapabilityMatch(
    {
      providerName: "luna-relay",
      modelId: "GPT-5.6 Luna",
      modelName: "GPT-5.6 Luna (relay)",
    },
    [
      candidate({ id: "gpt-5", contextWindow: 272000 }),
      candidate(),
    ],
  );
  assert.equal(match?.matchKind, "name-alias");
  assert.equal(match?.candidate.id, "gpt-5.6");
  const spec = modelCapabilityMatchToSpec(match);
  assert.equal(spec.source, "pi-ai");
  assert.equal(spec.matchedId, "gpt-5.6");
  assert.equal(spec.contextWindow, 400000);
  assert.deepEqual(JSON.parse(JSON.stringify(spec.input)), ["text", "image"]);
  assert.equal(spec.thinkingLevelMap?.max, "max");
});

test("name matching rejects embedded, ambiguous, and lower-version candidates", () => {
	assert.equal(
		findModelCapabilityMatch(
			{ providerName: "relay", modelId: "mygpt56luna" },
			[candidate()],
		),
		undefined,
	);
	assert.equal(
		findModelCapabilityMatch(
			{ providerName: "relay", modelId: "GPT-5.6 Luna" },
			[candidate({ id: "gpt-5" })],
		),
		undefined,
	);
	assert.equal(
		findModelCapabilityMatch(
			{ providerName: "relay", modelId: "alpha-1 beta-22 relay" },
			[candidate({ id: "alpha-1" }), candidate({ id: "beta-22" })],
		),
		undefined,
	);
});
