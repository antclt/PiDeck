import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// findTurnPageStart：轮次分页起点（2026-08 激活分页）。
// 核心契约：页边界永远对齐完整轮次（user 消息为轮次起点），
// 字节预算只从旧侧整轮丢弃，最新一轮永不拆分。

function loadFindTurnPageStart() {
  const source = readFileSync("src/main/pi/SessionHistoryReader.ts", "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: "SessionHistoryReader.ts",
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: () => ({}),
  }, { filename: "SessionHistoryReader.ts" });
  return module.exports.findTurnPageStart;
}

const findTurnPageStart = loadFindTurnPageStart();

// 构造测试数据：role 序列 + 每条 100 字节
function entries(roles, byteLength = 100) {
  return roles.map((role) => ({ role, byteLength }));
}

test("pages align to whole turns: Nth user message from the end becomes the page start", () => {
  // user@0 (0-2), user@3 (3-5), user@6 (6-9) 共 3 轮
  const e = entries(["user", "assistant", "assistant", "user", "assistant", "tool", "user", "assistant", "assistant", "assistant"]);
  assert.equal(findTurnPageStart(e, 10, 2, 1_000_000), 3, "last 2 turns start at the 2nd user from end");
  assert.equal(findTurnPageStart(e, 10, 3, 1_000_000), 0, "3 turns = whole session");
  assert.equal(findTurnPageStart(e, 10, 1, 1_000_000), 6, "single turn page");
});

test("fewer turns than requested falls back to session head", () => {
  const e = entries(["user", "assistant", "user", "assistant"]);
  assert.equal(findTurnPageStart(e, 4, 5, 1_000_000), 0);
});

test("leading non-user fragments attach to the first turn", () => {
  // system 碎片在首个 user 之前：翻到最后时整体归首轮
  const e = entries(["system", "user", "assistant", "user", "assistant"]);
  assert.equal(findTurnPageStart(e, 5, 2, 1_000_000), 0);
});

test("byte budget drops oldest whole turns but never splits one", () => {
  // 3 轮 × 3 条 × 100B = 900B；预算 650B → 丢最旧一轮（300B）剩 600B
  const e = entries(["user", "assistant", "assistant", "user", "assistant", "assistant", "user", "assistant", "assistant"]);
  assert.equal(findTurnPageStart(e, 9, 3, 650), 3, "oldest turn dropped wholesale");
  // 预算 550B → 再丢一轮，只剩最新一轮 300B
  assert.equal(findTurnPageStart(e, 9, 3, 550), 6);
});

test("newest turn is kept whole even when it alone exceeds the budget", () => {
  // 最新一轮 5 条 × 200B = 1000B 超 256B 预算：仍整轮保留（宁超预算不拆轮）
  const e = entries(["user", "assistant", "user", "assistant", "assistant", "assistant", "assistant"], 200);
  assert.equal(findTurnPageStart(e, 7, 2, 256), 2);
});

test("degenerate inputs return session head", () => {
  const e = entries(["user", "assistant"]);
  assert.equal(findTurnPageStart(e, 0, 3, 1000), 0);
  assert.equal(findTurnPageStart(e, 2, 0, 1000), 0);
});

test("consecutive user messages count as a single turn (speaker-hold semantics)", () => {
  // 连发 3 条 user 无回复 → 1 轮；随后 assistant 回复。
  // user@0 u1, user@1 u2, user@2 u3, assistant@3, user@4 (第二轮)
  const e = entries([
    "user", "user", "user", "assistant",
    "user", "assistant",
  ]);
  // 整段只有 2 轮（u1+u2+u3 合并，u4 单独）：取 2 轮 = 全段头
  assert.equal(findTurnPageStart(e, 6, 2, 1_000_000), 0, "two speaker turns cover the whole session");
  // 取 1 轮：只有第二轮（u4）——起点在下标 4
  assert.equal(findTurnPageStart(e, 6, 1, 1_000_000), 4, "last speaker turn starts at u4");
  // 取 1 轮只看第一段（before=4，即 u1..assistant）：起点 0（连发三条作为一个轮）
  assert.equal(findTurnPageStart(e, 4, 1, 1_000_000), 0, "consecutive users merge into one turn");
});

test("misc entries between consecutive users do not split the turn", () => {
  // error/system 卡片夹在连发 user 之间：仍属同一发言权周期，不拆轮。
  const e = entries(["user", "system", "user", "assistant", "user", "assistant"]);
  // 起点 0 与 4：u2（下标 2）被 system 卡分隔后仍并入 u1 的轮
  assert.equal(findTurnPageStart(e, 4, 1, 1_000_000), 0);
  assert.equal(findTurnPageStart(e, 6, 2, 1_000_000), 0);
  assert.equal(findTurnPageStart(e, 6, 1, 1_000_000), 4);
});

test("byte budget drops whole speaker turns including consecutive user runs", () => {
  // 第一段轮：3 条 user + 1 assistant（400B）；第二段：user + assistant（200B）
  const e = entries(["user", "user", "user", "assistant", "user", "assistant"], 100);
  // 预算 600B = 刚好装下两段轮：整段保留，连发段不拆。
  assert.equal(findTurnPageStart(e, 6, 2, 600), 0, "whole session fits within budget");
  // 预算 400B（正好第一段大小）：两段都超总预算？不——600>400，丢第一段后剩 200B ≤ 400 → 起点 u4。
  assert.equal(findTurnPageStart(e, 6, 2, 400), 4, "oldest speaker turn dropped wholesale, consecutive run never split");
  // 预算 100B：丢第一段（400B）后 200B 仍超 → 只剩最新一轮：宁超预算不拆轮。
  assert.equal(findTurnPageStart(e, 6, 2, 100), 4, "newest speaker turn kept whole even above budget");
});
