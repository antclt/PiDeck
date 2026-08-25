import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const probe = loadTsCommonJs("src/main/config/providerUsageProbe.ts");

const ensureVersion = (url) => {
  // 与 baseUrlPath.ensureOpenAiVersionPath 相同的语义：根路径补 /v1、已含 /v1 不动。
  if (url.includes("/v1")) return url;
  return `${url.replace(/\/+$/, "")}/v1`;
};

test("candidateApplies 命中 opencode zen 网关", () => {
  const cand = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains && c.baseUrlContains.some((n) => n.includes("opencode")));
  assert.ok(cand, "候选表应包含 opencode 适配器");
  assert.equal(probe.candidateApplies(cand, "https://opencode.ai/zen/go/v1/", "openai-completions"), true);
  assert.equal(probe.candidateApplies(cand, "https://api.openai.com/v1", "openai-completions"), false);
});

test("usageProbeUrls 生成版本化与原样两条去重路径", () => {
  const cand = probe.USAGE_PROBE_CANDIDATES[0];
  const urls = probe.usageProbeUrls(cand, "https://opencode.ai/zen/go/v1/", ensureVersion);
  // 两条尝试：版本化后 /usage，原样 /usage。版本化已是 /v1 → 两者一致去重。
  assert.ok(urls.length >= 1 && urls.length <= 2);
  assert.ok(urls.some((u) => u.endsWith("/usage")));
  // 含 /v1 版本化前缀
  assert.ok(urls.some((u) => u.includes("/v1/usage")));
});

test("parseUsageResponseBody 解析 rolling/weekly/monthly 三档百分比", () => {
  const body = {
    usage: {
      rolling: { status: "ok", percent: 0, resetsAt: "2026-01-01T00:00:00Z" },
      weekly: { percent: 18 },
      monthly: { percent: 68 },
      ignored: { foo: 1 },
    },
  };
  const res = probe.parseUsageResponseBody(body, "{}");
  assert.equal(res.matched, true);
  assert.equal(res.periods.rolling.percent, 0);
  assert.equal(res.periods.rolling.status, "ok");
  assert.equal(res.periods.weekly.percent, 18);
  assert.equal(res.periods.monthly.percent, 68);
  assert.equal(res.periods.ignored, undefined);
});

test("parseUsageResponseBody 无 usage 字段时不匹配并保留 raw", () => {
  const res = probe.parseUsageResponseBody({ foo: 1 }, "RAW_TEXT");
  assert.equal(res.matched, false);
  assert.equal(res.raw, "RAW_TEXT");
});

test("parseUsageResponseBody 非对象/空体不命中", () => {
  assert.equal(probe.parseUsageResponseBody(null, "x").matched, false);
  assert.equal(probe.parseUsageResponseBody("str", "x").matched, false);
  assert.equal(probe.parseUsageResponseBody([], "x").matched, false);
});

test("parseUsageResponseBody percent 非数字时退化 raw", () => {
  const res = probe.parseUsageResponseBody(
    { usage: { monthly: { percent: "68%" } } },
    "RAW",
  );
  assert.equal(res.matched, false);
  assert.equal(res.raw, "RAW");
});
test("真实 opencode-go /v1/usage 响应形状可解析出三档", () => {
  const real = {
    usage: {
      rolling: { status: "ok", percent: 0, resetsAt: "2025-06-01T00:00:00.000Z" },
      weekly: { percent: 18, status: "ok" },
      monthly: { percent: 68, resetsAt: "2025-07-01T00:00:00.000Z" },
    },
  };
  const parsed = probe.parseUsageResponseBody(real, JSON.stringify(real));
  assert.equal(parsed.matched, true);
  assert.equal(parsed.periods.rolling.percent, 0);
  assert.equal(parsed.periods.rolling.status, "ok");
  assert.equal(parsed.periods.weekly.percent, 18);
  assert.equal(parsed.periods.monthly.percent, 68);
  assert.equal(parsed.periods.monthly.resetsAt, "2025-07-01T00:00:00.000Z");
});

test("候选表首个条目的 URL 生成命中 /usage", () => {
  const cand = probe.USAGE_PROBE_CANDIDATES[0];
  const urls = probe.usageProbeUrls(cand, "https://opencode.ai/zen/go/v1/", ensureVersion);
  assert.ok(urls.some((u) => u.endsWith("/usage")));
});
