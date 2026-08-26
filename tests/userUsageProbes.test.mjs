import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { loadUserUsageProbes } = loadTsCommonJs("src/main/config/userUsageProbes.ts");

// loadTsCommonJs 用 vm 加载模块，产物是跨 realm 对象；deepStrictEqual 会按原型判等。
// 统一走 JSON 序列化比较，避免跨 realm 的数组/对象误判。
const json = (value) => JSON.stringify(value);

async function withProbesFile(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), "usage-probes-"));
  try {
    if (content != null) {
      await writeFile(join(dir, "usage-probes.json"), content, "utf8");
    }
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("文件不存在时返回空列表且无错误", async () => {
  await withProbesFile(null, async (dir) => {
    const result = await loadUserUsageProbes(dir);
    assert.equal(json(result), json({ candidates: [], errors: [] }));
  });
});

test("合法 balance 探针被转换成内部候选", async () => {
  const content = JSON.stringify({
    probes: [
      {
        name: "我的网关",
        match: { baseUrlContains: ["gateway.example.com"] },
        request: { path: "/v1/balance" },
        parse: { kind: "balance", valuePath: "data.balance", currencyPath: "data.currency" },
      },
    ],
  });
  await withProbesFile(content, async (dir) => {
    const result = await loadUserUsageProbes(dir);
    assert.equal(result.errors.length, 0);
    assert.equal(result.candidates.length, 1);
    const c = result.candidates[0];
    assert.equal(c.path, "/v1/balance");
    assert.equal(c.method, "GET");
    assert.equal(json(c.baseUrlContains), json(["gateway.example.com"]));
    assert.equal(json(c.parse), json({ kind: "balance", valuePath: "data.balance", currencyPath: "data.currency" }));
  });
});

test("credits 探针保留 remainingPath，POST + body + headers 保留", async () => {
  const content = JSON.stringify({
    probes: [
      {
        match: { baseUrlContains: ["openrouter.ai"] },
        request: {
          path: "/credits",
          method: "POST",
          body: { q: 1 },
          headers: { "X-API-Key": "{{apiKey}}" },
        },
        parse: { kind: "credits", remainingPath: "data.total_credits", usedPath: "data.total_usage" },
      },
    ],
  });
  await withProbesFile(content, async (dir) => {
    const result = await loadUserUsageProbes(dir);
    assert.equal(result.errors.length, 0);
    const c = result.candidates[0];
    assert.equal(c.method, "POST");
    assert.equal(json(c.body), json({ q: 1 }));
    assert.equal(json(c.headers), json({ "X-API-Key": "{{apiKey}}" }));
    assert.equal(c.parse.kind, "credits");
  });
});

test("非法条目被跳过并给出人话错误，不拖垮合法条目", async () => {
  const content = JSON.stringify({
    probes: [
      { match: { baseUrlContains: [] } }, // 缺 baseUrlContains
      { match: { baseUrlContains: ["x.com"] }, request: {} }, // 缺 path
      { match: { baseUrlContains: ["y.com"] }, request: { path: "/balance" }, parse: { kind: "balance" } }, // balance 缺 valuePath
      { match: { baseUrlContains: ["ok.com"] }, request: { path: "/balance" }, parse: { kind: "balance", valuePath: "data.balance" } },
    ],
  });
  await withProbesFile(content, async (dir) => {
    const result = await loadUserUsageProbes(dir);
    assert.equal(result.errors.length, 3);
    assert.equal(result.candidates.length, 1);
    assert.equal(json(result.candidates[0].baseUrlContains), json(["ok.com"]));
  });
});

test("损坏 JSON / 缺 probes 数组返回错误而非抛异常", async () => {
  await withProbesFile("{ not json", async (dir) => {
    const result = await loadUserUsageProbes(dir);
    assert.equal(result.candidates.length, 0);
    assert.equal(result.errors.length, 1);
  });
  await withProbesFile(JSON.stringify({ foo: 1 }), async (dir) => {
    const result = await loadUserUsageProbes(dir);
    assert.equal(result.candidates.length, 0);
    assert.equal(result.errors.length, 1);
  });
});

test("method 非法值回退 GET，非字符串 headers 值被过滤", async () => {
  const content = JSON.stringify({
    probes: [
      {
        match: { baseUrlContains: ["x.com"] },
        request: { path: "/b", method: "DELETE", headers: { good: "v", bad: 123 } },
        parse: { kind: "balance", valuePath: "data.balance" },
      },
    ],
  });
  await withProbesFile(content, async (dir) => {
    const result = await loadUserUsageProbes(dir);
    assert.equal(result.errors.length, 0);
    assert.equal(result.candidates[0].method, "GET");
    assert.equal(json(result.candidates[0].headers), json({ good: "v" }));
  });
});
