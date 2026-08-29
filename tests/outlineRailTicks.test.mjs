import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}) });
  return module.exports;
}

const railTicks = compile(
  "src/renderer/src/components/session/timeline/outlineRailTicks.ts",
);

const makeItems = (count) =>
  Array.from({ length: count }, (_, index) => ({ id: `msg-${index}` }));

test("空条目：空规划", () => {
  const plan = railTicks.planRailTicks([], 800);
  assert.equal(plan.items.length, 0);
});

test("未测量（高度 ≤ 0）：全量渲染 + 上限间距，不阻塞首帧", () => {
  const plan = railTicks.planRailTicks(makeItems(30), 0);
  assert.equal(plan.items.length, 30);
  assert.equal(plan.itemSize, railTicks.RAIL_TICK_MAX_SIZE);
});

test("空间充裕：全量渲染，间距取上限", () => {
  const plan = railTicks.planRailTicks(makeItems(20), 800);
  assert.equal(plan.items.length, 20);
  assert.equal(plan.itemSize, railTicks.RAIL_TICK_MAX_SIZE);
});

test("放不下但可收缩：全量渲染，间距 = floor(可用高度 / 条数)", () => {
  const plan = railTicks.planRailTicks(makeItems(100), 800);
  assert.equal(plan.items.length, 100);
  assert.equal(plan.itemSize, 8);
  // 收缩后的总高度不超过可用高度
  assert.ok(plan.items.length * plan.itemSize <= 800);
});

test("收缩到下限仍放不下：均匀抽稀，间距取下限", () => {
  const plan = railTicks.planRailTicks(makeItems(400), 100);
  assert.equal(plan.itemSize, railTicks.RAIL_TICK_MIN_SIZE);
  assert.ok(plan.items.length * plan.itemSize <= 100);
  assert.ok(plan.items.length < 400);
});

test("抽稀必须保留首尾：最顶刻度 = 第一条，最底刻度 = 最后一条", () => {
  const items = makeItems(400);
  const plan = railTicks.planRailTicks(items, 100);
  assert.equal(plan.items[0].id, "msg-0");
  assert.equal(plan.items[plan.items.length - 1].id, "msg-399");
});

test("抽稀取样下标严格递增，无重复刻度", () => {
  const items = makeItems(300);
  const plan = railTicks.planRailTicks(items, 64);
  const ids = plan.items.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  const indexes = plan.items.map((item) => Number(item.id.slice(4)));
  for (let i = 1; i < indexes.length; i += 1) {
    assert.ok(indexes[i] > indexes[i - 1]);
  }
});

test("sampleWithFixedEnds：条数不超上限时原样返回", () => {
  const items = makeItems(10);
  // vm 沙箱跨 realm 数组原型不同，展开成宿主数组再比较
  const sampled = railTicks.sampleWithFixedEnds(items, 12);
  assert.deepEqual([...sampled].map((item) => item.id), [...items].map((item) => item.id));
});

test("sampleWithFixedEnds：上限压到 2 时只留首尾", () => {
  const sampled = railTicks.sampleWithFixedEnds(makeItems(50), 2);
  assert.deepEqual([...sampled].map((item) => item.id), ["msg-0", "msg-49"]);
});
