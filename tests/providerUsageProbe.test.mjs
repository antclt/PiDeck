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

test("getByPath 支持点号/下标混合路径", () => {
  const body = { data: { balance: 12.5 }, balance_infos: [{ currency: "CNY", total_balance: "110.00" }] };
  assert.equal(probe.getByPath(body, "data.balance"), 12.5);
  assert.equal(probe.getByPath(body, "balance_infos[0].total_balance"), "110.00");
  assert.equal(probe.getByPath(body, "balance_infos[0].currency"), "CNY");
  assert.equal(probe.getByPath(body, "data.missing"), undefined);
  assert.equal(probe.getByPath(body, "balance_infos[5].x"), undefined);
  assert.equal(probe.getByPath(null, "a.b"), undefined);
  assert.equal(probe.getByPath(body, ""), undefined);
});

test("toNumber 兼容数字与数字字符串", () => {
  assert.equal(probe.toNumber(110), 110);
  assert.equal(probe.toNumber("110.00"), 110);
  assert.equal(probe.toNumber(" 12.5 "), 12.5);
  assert.equal(probe.toNumber("abc"), undefined);
  assert.equal(probe.toNumber(""), undefined);
  assert.equal(probe.toNumber(null), undefined);
  assert.equal(probe.toNumber(Number.NaN), undefined);
});

test("buildProbeHeaders 缺省补 Bearer，自定义 Authorization 覆盖，{{apiKey}} 替换", () => {
  const j = (v) => JSON.stringify(v);
  assert.equal(j(probe.buildProbeHeaders(undefined, "sk-1")), j({ Authorization: "Bearer sk-1" }));
  assert.equal(j(probe.buildProbeHeaders({}, "sk-1")), j({ Authorization: "Bearer sk-1" }));
  assert.equal(j(probe.buildProbeHeaders({ Authorization: "Bearer {{apiKey}}" }, "sk-2")), j({ Authorization: "Bearer sk-2" }));
  assert.equal(j(probe.buildProbeHeaders({ "X-API-Key": "{{apiKey}}" }, "sk-3")), j({ Authorization: "Bearer sk-3", "X-API-Key": "sk-3" }));
  // 空 key 时缺省 Bearer 不生成（上层会快速失败），但显式占位仍替换成空串
  assert.equal(j(probe.buildProbeHeaders(undefined, "")), j({}));
});

test("parseUsageResponseBody 解析 balance 形态", () => {
  const res = probe.parseUsageResponseBody(
    { balance_infos: [{ currency: "CNY", total_balance: "110.00" }] },
    "{}",
    { kind: "balance", valuePath: "balance_infos[0].total_balance", currencyPath: "balance_infos[0].currency" },
  );
  assert.equal(res.matched, true);
  assert.equal(res.kind, "balance");
  assert.equal(res.balance.value, 110);
  assert.equal(res.balance.currency, "CNY");
});

test("parseUsageResponseBody balance 取不到数值时退化 raw", () => {
  const res = probe.parseUsageResponseBody(
    { balance_infos: [] },
    "RAW",
    { kind: "balance", valuePath: "balance_infos[0].total_balance" },
  );
  assert.equal(res.matched, false);
  assert.equal(res.raw, "RAW");
});

test("parseUsageResponseBody 解析 credits 形态，remaining 自动 total-used 反推", () => {
  const res = probe.parseUsageResponseBody(
    { data: { total_credits: 100, total_usage: 42.5 } },
    "{}",
    { kind: "credits", totalPath: "data.total_credits", usedPath: "data.total_usage" },
  );
  assert.equal(res.matched, true);
  assert.equal(res.kind, "credits");
  assert.equal(res.credits.total, 100);
  assert.equal(res.credits.used, 42.5);
  assert.equal(res.credits.remaining, 57.5);
});

test("parseUsageResponseBody credits 显式 remainingPath 优先", () => {
  const res = probe.parseUsageResponseBody(
    { data: { total: 100, used: 42.5, remaining: 60 } },
    "{}",
    { kind: "credits", totalPath: "data.total", usedPath: "data.used", remainingPath: "data.remaining" },
  );
  assert.equal(res.credits.remaining, 60);
});

test("内置候选包含 DeepSeek balance 与 opencode periods", () => {
  const opencode = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("opencode.ai/zen"));
  const deepseek = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.deepseek.com"));
  assert.ok(opencode);
  assert.ok(deepseek);
  assert.equal(deepseek.parse.kind, "balance");
});

test("内置候选包含 OpenRouter credits 与 Moonshot balance", () => {
  const openrouter = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("openrouter.ai"));
  const moonshot = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.moonshot.ai"));
  assert.ok(openrouter);
  assert.ok(moonshot);
  assert.equal(openrouter.parse.kind, "credits");
  assert.equal(moonshot.parse.kind, "balance");
});

test("OpenRouter 候选解析真实 /credits 响应，remaining 由 total-used 反推", () => {
  const cand = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("openrouter.ai"));
  assert.equal(probe.candidateApplies(cand, "https://openrouter.ai/api/v1", "openai-completions"), true);
  assert.equal(probe.candidateApplies(cand, "https://api.deepseek.com", "openai-completions"), false);
  const res = probe.parseUsageResponseBody(
    { data: { total_credits: 100.5, total_usage: 25.75 } },
    "{}",
    cand.parse,
  );
  assert.equal(res.matched, true);
  assert.equal(res.kind, "credits");
  assert.equal(res.credits.total, 100.5);
  assert.equal(res.credits.used, 25.75);
  assert.equal(res.credits.remaining, 74.75);
});

test("Moonshot 候选国内/国际 baseUrl 都命中，解析真实 balance 响应（无币种）", () => {
  const cand = probe.USAGE_PROBE_CANDIDATES.find((c) => c.baseUrlContains?.includes("api.moonshot.ai"));
  assert.equal(probe.candidateApplies(cand, "https://api.moonshot.ai/v1", "openai-completions"), true);
  assert.equal(probe.candidateApplies(cand, "https://api.moonshot.cn/v1", "openai-completions"), true);
  assert.equal(probe.candidateApplies(cand, "https://api.openai.com/v1", "openai-completions"), false);
  const res = probe.parseUsageResponseBody(
    { code: 0, data: { available_balance: 12.34, voucher_balance: 2.0, cash_balance: 10.34 } },
    "{}",
    cand.parse,
  );
  assert.equal(res.matched, true);
  assert.equal(res.kind, "balance");
  assert.equal(res.balance.value, 12.34);
  assert.equal(res.balance.currency, undefined);
});

test("内置候选包含通用 OpenAI /usage 兑底候选（不限 baseUrl，仅限 OpenAI 协议）", () => {
  const generic = probe.USAGE_PROBE_CANDIDATES.find((c) => c.path === "/usage" && c.apiTypes);
  assert.ok(generic, "候选表应包含通用 OpenAI /usage 候选");
  assert.equal(generic.baseUrlContains, undefined);
  assert.ok(generic.apiTypes.includes("openai-completions"));
  assert.ok(generic.apiTypes.includes("openai-responses"));
  assert.ok(generic.apiTypes.includes("openai-codex-responses"));
  assert.equal(generic.parse.kind, "balance");
  assert.equal(generic.parse.valuePath, "balance");
  assert.equal(generic.parse.currencyPath, "unit");
});

test("通用 OpenAI /usage 候选：任意 OpenAI 协议 baseUrl 命中，非 OpenAI 协议不命中", () => {
  const generic = probe.USAGE_PROBE_CANDIDATES.find((c) => c.path === "/usage" && c.apiTypes);
  assert.equal(probe.candidateApplies(generic, "https://open.mwy.asia/v1", "openai-responses"), true);
  assert.equal(probe.candidateApplies(generic, "https://any-gateway.example.com/v1", "openai-completions"), true);
  assert.equal(probe.candidateApplies(generic, "https://api.anthropic.com", "anthropic-messages"), false);
  assert.equal(probe.candidateApplies(generic, "https://generativelanguage.googleapis.com", "google-generative-ai"), false);
});

test("通用 OpenAI /usage 候选解析真实 /usage 响应（balance+unit）", () => {
  const generic = probe.USAGE_PROBE_CANDIDATES.find((c) => c.path === "/usage" && c.apiTypes);
  const res = probe.parseUsageResponseBody(
    { balance: 1.69525969, unit: "USD", planName: "钱包余额", remaining: 1.69525969 },
    "{}",
    generic.parse,
  );
  assert.equal(res.matched, true);
  assert.equal(res.kind, "balance");
  assert.equal(res.balance.value, 1.69525969);
  assert.equal(res.balance.currency, "USD");
});
