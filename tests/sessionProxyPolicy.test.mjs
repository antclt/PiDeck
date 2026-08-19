import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
  applyPiProxyMode,
  aggregateDshProxyMode,
  buildHostProxyEnvPatch,
  applyProxyEnvPatch,
  PROXY_ENV_KEYS,
} = loadTsCommonJs("src/main/sessions/sessionProxyPolicy.ts");

// 注：loadTsCommonJs 跨 vm realm 加载，对象原型与本地不同，deepEqual 会因 prototype
// 不等而失败；统一用逐字段断言。

test("applyPiProxyMode: follow/undefined 原样返回（同一引用）", () => {
  const settings = { piProxyEnabled: true, piProxyUrl: "http://127.0.0.1:7890" };
  assert.equal(applyPiProxyMode(settings, undefined), settings);
  assert.equal(applyPiProxyMode(settings, "follow"), settings);
  assert.equal(applyPiProxyMode(undefined, "on"), undefined);
});

test("applyPiProxyMode: on 强制开启、保留全局 URL，off 强制关闭", () => {
  const on = applyPiProxyMode({ piProxyEnabled: false, piProxyUrl: "http://127.0.0.1:7890" }, "on");
  assert.equal(on.piProxyEnabled, true);
  assert.equal(on.piProxyUrl, "http://127.0.0.1:7890");
  // 全局开着时 off 仍强制关闭（“不想开代理的会话”核心诉求）
  const off = applyPiProxyMode({ piProxyEnabled: true, piProxyUrl: "http://127.0.0.1:7890" }, "off");
  assert.equal(off.piProxyEnabled, false);
  assert.equal(off.piProxyUrl, "http://127.0.0.1:7890");
});

test("aggregateDshProxyMode: 空/全 follow → follow；任一 off 一票否决；无 off 有 on → on", () => {
  assert.equal(aggregateDshProxyMode([]), "follow");
  assert.equal(aggregateDshProxyMode([undefined, { mode: "follow" }]), "follow");
  // off 优先于 on（直连是安全默认，显式直连表达最强意图）
  assert.equal(aggregateDshProxyMode([{ mode: "on" }, { mode: "off" }]), "off");
  assert.equal(aggregateDshProxyMode([{ mode: "off" }, { mode: "follow" }]), "off");
  assert.equal(aggregateDshProxyMode([{ mode: "on" }, undefined, { mode: "follow" }]), "on");
});

test("buildHostProxyEnvPatch: off → 剥离全部标准代理 env（含 NO_PROXY）", () => {
  const patch = buildHostProxyEnvPatch("off", { url: "http://127.0.0.1:7890", bypass: "localhost" });
  assert.ok(patch);
  assert.equal(Object.keys(patch.set).length, 0);
  assert.deepEqual(
    [...patch.unset].sort(),
    [
      "ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
      "all_proxy", "http_proxy", "https_proxy", "no_proxy",
    ].sort(),
  );
});

test("buildHostProxyEnvPatch: on → 注入大小写双份 + bypass；URL 为空返回 undefined", () => {
  const patch = buildHostProxyEnvPatch("on", { url: "  http://127.0.0.1:7890  ", bypass: "localhost,127.0.0.1" });
  assert.ok(patch);
  for (const key of PROXY_ENV_KEYS) assert.equal(patch.set[key], "http://127.0.0.1:7890");
  assert.equal(patch.set.NO_PROXY, "localhost,127.0.0.1");
  assert.equal(patch.set.no_proxy, "localhost,127.0.0.1");
  // 全局 URL 空：无法代理，返回 undefined 表示不动（等用户先配 URL）
  assert.equal(buildHostProxyEnvPatch("on", { url: "  ", bypass: "" }), undefined);
});

test("buildHostProxyEnvPatch: follow → undefined（保持 host 现有行为）", () => {
  assert.equal(buildHostProxyEnvPatch("follow", { url: "http://x", bypass: "" }), undefined);
});

test("applyProxyEnvPatch: 先剥离后注入，顺序固定", () => {
  const env = { HTTP_PROXY: "http://system", PATH: "/usr/bin", NO_PROXY: "old" };
  applyProxyEnvPatch(env, {
    set: { HTTP_PROXY: "http://127.0.0.1:7890" },
    unset: ["NO_PROXY"],
  });
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.NO_PROXY, undefined);
  assert.equal(env.PATH, "/usr/bin");
  // off 场景：无 set，只剥离
  const env2 = { HTTP_PROXY: "http://system", http_proxy: "http://system" };
  const off = buildHostProxyEnvPatch("off", { url: "x", bypass: "" });
  applyProxyEnvPatch(env2, off);
  assert.deepEqual(Object.keys(env2), []);
});