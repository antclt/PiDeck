import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 统一组件卡（SessionWidgetsCard 取代原 SessionTodoStrip / SessionModifiedFilesStrip）后，
 * 原 todo 条专测收敛为：i18n 文案、composer 挂载链、chat-header chips 移除的结构断言。
 * progressLabel 等纯展示 helper 已内联到 SessionWidgetsPopover（非导出），
 * todo 解析口径由 sessionTodoSnapshot.test.mjs 覆盖。
 */
const composerSource = () =>
  readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
const viewSource = () =>
  readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
const startSource = () =>
  readFileSync("src/renderer/src/components/session/SessionStartSurface.tsx", "utf8");
const popoverSource = () =>
  readFileSync("src/renderer/src/components/session/SessionWidgetsPopover.tsx", "utf8");
const zh = () => readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = () => readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("composer area forwards a widgets slot and session surfaces mount the unified card", () => {
  const composer = composerSource();
  const view = viewSource();
  const start = startSource();
  // ComposerArea：widgets prop 透传到 ComposerMeasuredExtras（测量链驱动面板增高）
  assert.match(composer, /widgets\?: ReactNode/);
  assert.match(composer, /widgets=\{props\.widgets \?\? null\}/);
  // SessionView / SessionStartSurface：底部 widgets 栈挂统一组件卡 + goal 条
  assert.match(view, /import \{ SessionWidgetsCard \} from "\.\/SessionWidgetsCard"/);
  assert.match(view, /<SessionWidgetsCard/);
  assert.match(start, /<SessionWidgetsCard sessionId=\{props\.sessionId\} \/>/);
  assert.ok(
    view.indexOf("<SessionWidgetsCard") < view.indexOf("<SessionGoalStrip"),
    "widgets card must precede goal in SessionView widgets",
  );
});

test("todo strip copy is present in both locale dictionaries", () => {
  for (const locale of [zh(), en()]) {
    assert.match(locale, /"sessionTodo\.done": "\{done\}/);
    assert.match(locale, /"sessionTodo\.active": "\{active\}/);
    assert.match(locale, /"sessionTodo\.pending": "\{pending\}/);
    assert.match(locale, /"sessionTodo\.empty"/);
    // 统一组件卡常驻，不再有关闭按钮文案
    assert.doesNotMatch(locale, /"sessionTodo\.dismiss"/);
  }
});

test("progress label keeps zero-segment omission and en-space middot join in the popover", () => {
  const popover = popoverSource();
  // progressLabel：零计数段过滤 + en-space(U+2002) · en-space 连接（与旧 todo 条同口径）
  assert.match(popover, /function progressLabel/);
  assert.match(popover, /items\.done > 0 \? t\("sessionTodo\.done"/);
  assert.match(popover, /items\.active > 0 \? t\("sessionTodo\.active"/);
  assert.match(popover, /items\.pending > 0 \? t\("sessionTodo\.pending"/);
  assert.match(popover, /join\("\\u2002·\\u2002"\)/);
});

// ── chat-header widget chips 已移除（2026-08 用户要求：待办统一走输入框上方常驻条）──

test("chat-header widget chips are removed; header slot and mounts are gone", () => {
  const view = viewSource();
  const header = readFileSync(
    "src/renderer/src/components/session/SessionHeader.tsx",
    "utf8",
  );
  // 组件文件删除 + 挂载/槽位/import 移除
  assert.throws(() =>
    readFileSync("src/renderer/src/components/session/SessionWidgetChips.tsx"),
  );
  assert.doesNotMatch(view, /SessionWidgetChips/);
  assert.doesNotMatch(header, /widgetChips/);
  // 旧 strip 组件也已删除，统一走 SessionWidgetsCard
  assert.throws(() =>
    readFileSync("src/renderer/src/components/session/SessionTodoStrip.tsx"),
  );
  assert.throws(() =>
    readFileSync("src/renderer/src/components/session/SessionModifiedFilesStrip.tsx"),
  );
});
