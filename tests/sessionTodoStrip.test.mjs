import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 恢复 dsh-web 形态的独立横栏卡（SessionTodoStrip / SessionFilesStrip /
 * SessionSubagentsStrip 取代 SessionWidgetsCard 分段条与悬浮弹层）后的契约断言：
 * i18n 文案、composer 挂载链、progressLabel / dismiss 纯函数、旧组件删除。
 */
const composerSource = () =>
  readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
const viewSource = () =>
  readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
const startSource = () =>
  readFileSync("src/renderer/src/components/session/SessionStartSurface.tsx", "utf8");
const stripSource = () =>
  readFileSync("src/renderer/src/components/session/SessionTodoStrip.tsx", "utf8");
const zh = () => readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = () => readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("composer forwards widgets slot; session surfaces mount the three strips then goal", () => {
  const composer = composerSource();
  const view = viewSource();
  const start = startSource();
  // ComposerArea：widgets prop 透传到 ComposerMeasuredExtras（测量链驱动面板增高）
  assert.match(composer, /widgets\?: ReactNode/);
  assert.match(composer, /widgets=\{props\.widgets \?\? null\}/);
  // SessionView：todo → files → subagents → goal，独立横栏卡顺序挂载
  assert.match(view, /<SessionTodoStrip sessionId=\{sessionId\} \/>/);
  assert.match(
    view,
    /<SessionFilesStrip[\s\S]*?run=\{latestAgentRun\}[\s\S]*?onDiffFile=\{onDiffFile\}/,
  );
  assert.match(
    view,
    /<SessionSubagentsStrip[\s\S]*?onOpenChildSession=\{onOpenBranchSession\}/,
  );
  assert.match(view, /<SessionGoalStrip sessionId=\{sessionId\} \/>/);
  assert.ok(
    view.indexOf("<SessionTodoStrip") < view.indexOf("<SessionFilesStrip") &&
      view.indexOf("<SessionFilesStrip") < view.indexOf("<SessionSubagentsStrip") &&
      view.indexOf("<SessionSubagentsStrip") < view.indexOf("<SessionGoalStrip"),
    "strip order must be todo → files → subagents → goal in SessionView widgets",
  );
  // SessionStartSurface：引导页同样挂三个横栏 + goal
  assert.match(start, /<SessionTodoStrip sessionId=\{props\.sessionId\} \/>/);
  assert.match(start, /<SessionFilesStrip sessionId=\{props\.sessionId\} \/>/);
  assert.match(start, /<SessionSubagentsStrip sessionId=\{props\.sessionId\} \/>/);
  assert.match(start, /<SessionGoalStrip sessionId=\{props\.sessionId\} \/>/);
});

test("todo strip copy is present in both locale dictionaries", () => {
  for (const locale of [zh(), en()]) {
    assert.match(locale, /"sessionTodo\.done": "\{done\}/);
    assert.match(locale, /"sessionTodo\.active": "\{active\}/);
    assert.match(locale, /"sessionTodo\.pending": "\{pending\}/);
    assert.match(locale, /"sessionTodo\.empty"/);
    // dismiss 随横栏形态回归：手动关闭 + 内容指纹变化后重新出现
    assert.match(locale, /"sessionTodo\.dismiss"/);
  }
});

test("progress label keeps zero-segment omission and en-space middot join in the strip", () => {
  const strip = stripSource();
  // progressLabel：零计数段过滤 + en-space(U+2002) · en-space 连接（与旧 todo 条同口径）
  assert.match(strip, /export function progressLabel/);
  assert.match(strip, /done > 0 \? t\("sessionTodo\.done"/);
  assert.match(strip, /active > 0 \? t\("sessionTodo\.active"/);
  assert.match(strip, /pending > 0 \? t\("sessionTodo\.pending"/);
  assert.match(strip, /join\("\\u2002·\\u2002"\)/);
});

test("dismiss helpers keep widget-lines fingerprints", () => {
  const strip = stripSource();
  // 手动关闭按「内容指纹」记录：指纹相同保持隐藏，工具更新列表后重新出现
  assert.match(strip, /export function widgetLinesSignature/);
  assert.match(strip, /export function isWidgetDismissed/);
  assert.match(strip, /export function dismissWidgetEntries/);
});

test("segmented bar and floating popover are removed; strip cards replaced them", () => {
  const view = viewSource();
  assert.throws(() =>
    readFileSync("src/renderer/src/components/session/SessionWidgetsCard.tsx"),
  );
  assert.throws(() =>
    readFileSync("src/renderer/src/components/session/SessionWidgetsPopover.tsx"),
  );
  assert.doesNotMatch(view, /SessionWidgetsCard|SessionWidgetsPopover/);
  // 弹层专用 atoms 一并移除：行级折叠统一走 composer 通道
  const composerAtoms = readFileSync("src/renderer/src/atoms/composer-atoms.ts", "utf8");
  assert.doesNotMatch(
    composerAtoms,
    /widgetsPopoverSegmentFamily|widgetsDisclosureCollapsedFamily/,
  );
  // 悬浮弹层不在 timeline 面板内渲染：SessionSurfaceStage 只承载时间线
  const stage = readFileSync(
    "src/renderer/src/components/session/SessionSurfaceStage.tsx",
    "utf8",
  );
  assert.doesNotMatch(stage, /SessionWidgetsPopover/);
});
