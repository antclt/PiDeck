import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * 历史消息改写路径策略（编辑/删除/重发）纯函数测试。
 *
 * 决策矩阵（与 useSessionHistoryMutations 的运行时行为一一对应）：
 * | 场景 | 结果 |
 * | 有文件（persisted）+ agent 在跑 | catalog, live=true（先停再改文件） |
 * | 有文件 + agent 未跑 | catalog, live=false（直接改文件） |
 * | 匿名（无文件）+ 编辑/删除 | unsupported-anonymous（诚实告知不支持） |
 * | 匿名 + 重发 | runtime-anonymous-resend（重新提交原文本） |
 * | 生图 draft + 重发 | imagegen-resend（提示词放回输入框） |
 */
function loadPolicy() {
  const source = readFileSync("src/renderer/src/utils/sessionHistoryMutationPolicy.ts", "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "sessionHistoryMutationPolicy.ts",
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, console }, {
    filename: "sessionHistoryMutationPolicy.ts",
  });
  return module.exports;
}

const policy = loadPolicy();
const target = { sessionId: "s1", agentId: "a1", runtimeGeneration: 1 };

// vm realm 构造的对象原型与本 realm 不同，deepEqual 会误判 → 走 JSON 归一化比较
function resolve(kind, options) {
  return policy.resolveHistoryMutationPath({ kind, target, ...options });
}
function expectPath(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

test("persisted session with live runtime: catalog + stop-first", () => {
  expectPath(resolve("edit", { persisted: true }), { path: "catalog", live: true });
  expectPath(resolve("delete", { persisted: true }), { path: "catalog", live: true });
  expectPath(resolve("resend", { persisted: true }), { path: "catalog", live: true });
});

test("persisted session with no runtime: catalog without stop", () => {
  expectPath(resolve("edit", { target: undefined, persisted: true }), { path: "catalog", live: false });
  expectPath(resolve("delete", { target: undefined, persisted: true }), { path: "catalog", live: false });
  expectPath(resolve("resend", { target: undefined, persisted: true }), { path: "catalog", live: false });
});

test("anonymous session edit/delete: unsupported (no session file to rewrite)", () => {
  // pi 的 editMessage/deleteMessage 都要求 sessionPath（AgentManager 抛
  // "Session not persisted"），运行中也走不通——必须明确告知不支持，而不是
  // 调必然失败的 runtime 命令。
  expectPath(resolve("edit", { persisted: false }), { path: "unsupported-anonymous", reason: "edit" });
  expectPath(resolve("delete", { persisted: false }), { path: "unsupported-anonymous", reason: "delete" });
  // agent 未跑也一样不支持
  expectPath(resolve("delete", { target: undefined, persisted: false }), { path: "unsupported-anonymous", reason: "delete" });
});

test("anonymous session resend: resubmit original text (no truncation possible)", () => {
  expectPath(resolve("resend", { persisted: false }), { path: "runtime-anonymous-resend" });
  expectPath(resolve("resend", { target: undefined, persisted: false }), { path: "runtime-anonymous-resend" });
});

test("imagegen draft resend: restore prompt into composer instead of truncating a nonexistent pi file", () => {
  expectPath(resolve("resend", { target: undefined, persisted: false, isImageGenSession: true }), { path: "imagegen-resend" });
  // 生图 draft 优先级高于普通匿名重发
  expectPath(resolve("resend", { persisted: false, isImageGenSession: true }), { path: "imagegen-resend" });
  // 非重发操作不受 isImageGenSession 影响
  expectPath(resolve("delete", { target: undefined, persisted: false, isImageGenSession: true }), { path: "unsupported-anonymous", reason: "delete" });
});

test("persisted flag wins over everything: file-backed session never uses anonymous paths", () => {
  expectPath(resolve("edit", { persisted: true, isImageGenSession: true }), { path: "catalog", live: true });
});
