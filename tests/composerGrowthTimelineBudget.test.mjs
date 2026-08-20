import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule() {
  const source = readFileSync("src/renderer/src/rendererUtils.ts", "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: () => ({}),
  });
  return module.exports;
}

function approx(a, b) {
	return Math.abs(a - b) < 1e-9;
}

function assertLayout(got, expected) {
	assert.ok(approx(got.composer, expected.composer), `composer ${got.composer} ≈ ${expected.composer}`);
	assert.ok(approx(got.timeline, expected.timeline), `timeline ${got.timeline} ≈ ${expected.timeline}`);
}

/**
 * 回归：AI 输出内容时 composer 上方出现可变内容（投递通知/widgets），
 * programResize 增高 composer 会从 timeline 扣空间；若 timeline 已到
 * minSize(160px) 下限，库会把 clamp 差额压给 terminal，terminal 被压到
 * 折叠阈值以下即触发 handleTerminalResize 的 px<=35 判定 → 终端被收起。
 * 修复：composer 增高只能占用 timeline 可让出的空间（预算制）。
 */
test("composer growth is capped by the timeline min-size budget", () => {
  const { growComposerWithinTimelineBudget } = loadModule();
  // group 高 800px，timeline minSize=160px → 20% 是保底
  const groupPx = 800;
  const timelineMinPx = 160;
  const layout = { timeline: 40, composer: 20, terminal: 40 };

  // 预算充足：timeline 40% 可让 20% → composer 可长到 30%
  const grown = growComposerWithinTimelineBudget(
    layout,
    20, // composer 当前
    30, // 目标
    groupPx,
    timelineMinPx,
  );
  assertLayout(grown, { composer: 30, timeline: 30 });

  // 预算不足：timeline 只剩 22%（可让 2%），composer 不能长到 30%
  const capped = growComposerWithinTimelineBudget(
    { timeline: 22, composer: 20, terminal: 58 },
    20,
    30,
    groupPx,
    timelineMinPx,
  );
  assertLayout(capped, { composer: 22, timeline: 20 });

  // timeline 已在保底线：composer 完全不能长（预算为 0）
  const atFloor = growComposerWithinTimelineBudget(
    { timeline: 20, composer: 20, terminal: 60 },
    20,
    40,
    groupPx,
    timelineMinPx,
  );
  assertLayout(atFloor, { composer: 20, timeline: 20 });
});

test("timeline budget respects the configured min-size constant", () => {
  const { growComposerWithinTimelineBudget, TIMELINE_MIN_HEIGHT } = loadModule();
  assert.equal(TIMELINE_MIN_HEIGHT, 160);
  // timeline 12% + minSize 12%（=96px/800px 组内），无法让出 → 预算 0
  const capped = growComposerWithinTimelineBudget(
    { timeline: 12, composer: 30, terminal: 58 },
    30,
    40,
    800,
    TIMELINE_MIN_HEIGHT,
  );
  assertLayout(capped, { composer: 30, timeline: 12 });
});

test("collapsing the terminal gives leftover height to the timeline, not the composer", () => {
  const { redistributeTerminalAgainstTimeline } = loadModule();
  // 用户把终端拉到 40%，再折叠到 34px / 800px = 4.25%。
  // 腾出的 35.75% 必须还给 timeline，composer 20% 不得被相邻面板吃掉。
  const next = redistributeTerminalAgainstTimeline(
    { timeline: 40, composer: 20, terminal: 40 },
    4.25,
    20,
  );
  assertLayout(
    { composer: next.composer, timeline: next.timeline },
    { composer: 20, timeline: 75.75 },
  );
  assert.ok(approx(next.terminal, 4.25), `terminal ${next.terminal} ≈ 4.25`);

  // collapse() 之后库已经把高度写进 composer：仍以折叠前的 20% 为准重排。
  const polluted = redistributeTerminalAgainstTimeline(
    { timeline: 40, composer: 55.75, terminal: 4.25 },
    4.25,
    20,
  );
  assertLayout(
    { composer: polluted.composer, timeline: polluted.timeline },
    { composer: 20, timeline: 75.75 },
  );
});

test("expanding the terminal takes height from the timeline, not the composer", () => {
  const { redistributeTerminalAgainstTimeline } = loadModule();
  const next = redistributeTerminalAgainstTimeline(
    { timeline: 75.75, composer: 20, terminal: 4.25 },
    40,
    20,
    20,
  );
  assertLayout(
    { composer: next.composer, timeline: next.timeline },
    { composer: 20, timeline: 40 },
  );
  assert.ok(approx(next.terminal, 40), `terminal ${next.terminal} ≈ 40`);
});

test("session view uses the budget function in programResize (not raw delta)", () => {
  const sessionView = readFileSync(
    "src/renderer/src/components/session/SessionView.tsx",
    "utf8",
  );
  // programResize 必须走预算函数：raw delta 在 timeline 触底时会压扁 terminal
  assert.match(sessionView, /growComposerWithinTimelineBudget/);
  assert.match(sessionView, /sanitizeSessionPanelLayout/);
  assert.match(sessionView, /sessionResizableGroupKey\(sessionPanels\)/);
  assert.match(sessionView, /shouldMountBottomComposer/);
  assert.match(sessionView, /groupResizeBehavior="preserve-pixel-size"/);
  assert.match(sessionView, /composerHeightSessionRef/);
  assert.match(sessionView, /sessionTimeline\.isSurfaceLoading/);

  // timeline 面板的 minSize 用同一常量，预算函数与 JSX 约束不漂移
  assert.match(sessionView, /minSize=\{TIMELINE_MIN_HEIGHT\}/);
  // 折叠阈值判定仍保留（用户拖拽到 35px 以下应折叠），但程序化增长不再触发它
  assert.match(sessionView, /px <= 35/);
  // 折叠终端必须走 redistribuion：库的 collapse() 会把高度补给相邻 composer
  assert.match(sessionView, /redistributeTerminalAgainstTimeline/);
  assert.match(sessionView, /composerHeightStateRef\.current \/ groupPx/);
  assert.match(
    sessionView,
    /if \(now < terminalProgrammaticExpireRef\.current\) return/,
  );
});

/**
 * 回归：打开历史会话首帧 messages=[]，旧逻辑卸底部 composer，Group 只剩 timeline，
 * 但仍用 session-group-2p 复用 layouts["timeline,composer"]（例如 83.506%, 16.494%），
 * react-resizable-panels K() 抛 `Invalid 1 panel layout`。
 */
test("history session loading keeps the bottom composer so the group is never 1-panel", () => {
  const { shouldMountBottomComposer, sessionResizableGroupKey, sanitizeSessionPanelLayout } = loadModule();

  assert.equal(
    shouldMountBottomComposer({
      hasActiveConversation: true,
      messageCount: 0,
      isConversationLoading: true,
    }),
    true,
    "loading history must keep the bottom composer mounted",
  );
  assert.equal(
    shouldMountBottomComposer({
      hasActiveConversation: true,
      messageCount: 0,
      isConversationLoading: false,
    }),
    false,
    "empty ready sessions stay on the start surface",
  );
  assert.equal(
    shouldMountBottomComposer({
      hasActiveConversation: true,
      messageCount: 3,
      isConversationLoading: false,
    }),
    true,
  );
  assert.equal(
    shouldMountBottomComposer({
      hasActiveConversation: false,
      messageCount: 0,
      isConversationLoading: true,
    }),
    false,
  );

  assert.equal(sessionResizableGroupKey({ composer: false, terminal: false }), "session-group-1p");
  assert.equal(sessionResizableGroupKey({ composer: true, terminal: false }), "session-group-2p");
  assert.equal(sessionResizableGroupKey({ composer: true, terminal: true }), "session-group-3p");
  assert.notEqual(
    sessionResizableGroupKey({ composer: false, terminal: false }),
    sessionResizableGroupKey({ composer: true, terminal: false }),
    "1-panel and 2-panel groups must not share a cache key",
  );

  // 2 值缓存打到 1 面板：只留 timeline=100，丢掉 composer 百分比
  const onePanel = sanitizeSessionPanelLayout(
    { timeline: 83.506, composer: 16.494 },
    { composer: false, terminal: false },
  );
  // vm 沙箱对象与测试字面量原型不同，不能 deepEqual；按键/值断言即可。
  assert.equal(onePanel.timeline, 100);
  assert.equal(onePanel.composer, undefined);
  assert.equal(Object.keys(onePanel).join(","), "timeline");

  // 3 值缓存打到 2 面板：丢掉 terminal，composer 保持，timeline 吸收差额
  const twoPanel = sanitizeSessionPanelLayout(
    { timeline: 50, composer: 16.494, terminal: 33.506 },
    { composer: true, terminal: false },
  );
  assert.equal(twoPanel.composer, 16.494);
  assert.equal(twoPanel.terminal, undefined);
  assert.ok(Math.abs(twoPanel.timeline - (100 - 16.494)) < 1e-9);
});
