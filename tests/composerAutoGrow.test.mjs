import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerArea = readFileSync(
  "src/renderer/src/components/session/ComposerArea.tsx",
  "utf8",
);
const sessionView = readFileSync(
  "src/renderer/src/components/session/SessionView.tsx",
  "utf8",
);
const rendererUtils = readFileSync(
  "src/renderer/src/rendererUtils.ts",
  "utf8",
);
const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
const tipTapComposer = readFileSync(
  "src/renderer/src/components/session/composer/TipTapComposer.tsx",
  "utf8",
);
const timelineCss = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
const terminalDock = readFileSync(
  "src/renderer/src/components/terminal/TerminalDockPanel.tsx",
  "utf8",
);

/**
 * 输入栏是时间线列里的固有高度 chrome，不是 Group 百分比面板。
 * 窗口缩放时时间线吸收余量；待办/改文件条随内容撑开，列被 max-height 卡住才内部滚动。
 */
test("composer is intrinsic chrome inside the timeline column, not a resizable panel", () => {
  assert.doesNotMatch(sessionView, /id="composer"/);
  assert.doesNotMatch(sessionView, /groupResizeBehavior="preserve-pixel-size"/);
  assert.doesNotMatch(sessionView, /onContentHeightChange/);
  assert.doesNotMatch(sessionView, /handleComposerContentHeight/);
  assert.doesNotMatch(sessionView, /composerPanelRef/);
  assert.doesNotMatch(sessionView, /resolveComposerPanelHeight/);
  assert.doesNotMatch(sessionView, /growComposerWithinTimelineBudget/);
  assert.match(sessionView, /id="timeline"/);
  assert.match(sessionView, /session-v-composer/);
  assert.match(
    sessionView,
    /maxHeight: `min\(\$\{COMPOSER_MAX_HEIGHT\}px, calc\(100% - var\(--session-timeline-min/,
  );
  assert.match(sessionView, /session-v-timeline-stage/);
  assert.match(foundation, /\.session-v-composer \.composer \{[\s\S]*?height:\s*auto;/);
  assert.doesNotMatch(foundation, /\.session-v-timeline > \*/);
});

test("footer sizes to content and does not hug a measured pixel height", () => {
  assert.doesNotMatch(composerArea, /flushSync/);
  assert.doesNotMatch(composerArea, /measureContentHeight/);
  assert.doesNotMatch(composerArea, /onContentHeightChange/);
  assert.doesNotMatch(composerArea, /ResizeObserver/);
  assert.doesNotMatch(composerArea, /defaultHeight/);
  assert.match(composerArea, /style=\{composerFooterStyle\(\)\}/);
  assert.match(
    composerArea,
    /className="flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto overscroll-contain pb-px empty:hidden"/,
  );
  assert.match(
    composerArea,
    /composer-box relative flex w-full min-w-0 shrink-0 flex-col/,
  );
  assert.doesNotMatch(
    composerArea,
    /composer-box relative flex min-h-0 w-full min-w-0 flex-1 flex-col/,
  );
});

test("extras wrapper rerenders with disclosure so the footer can follow content", () => {
  assert.match(composerArea, /function ComposerMeasuredExtras/);
  assert.match(composerArea, /useComposerWidgetLayoutValue\(/);
  assert.match(
    composerArea,
    /<ComposerMeasuredExtras[\s\S]*widgets=\{props\.widgets \?\? null\}/,
  );
});

test("image attachment bar stays glued to the input box", () => {
  const extrasReturn = composerArea.indexOf("return (", composerArea.indexOf("function ComposerMeasuredExtras"));
  const widgetsSlot = composerArea.indexOf("overflow-y-auto overscroll-contain", extrasReturn);
  const attachmentSlot = composerArea.indexOf("{props.attachmentBar}", extrasReturn);
  const measuredCall = composerArea.indexOf("<ComposerMeasuredExtras");
  const composerBoxSlot = composerArea.indexOf('className={["composer-box');
  assert.ok(widgetsSlot !== -1 && attachmentSlot !== -1 && widgetsSlot < attachmentSlot);
  assert.ok(measuredCall !== -1 && measuredCall < composerBoxSlot);
  assert.match(composerArea, /composer\.attachments\.length > 0 \|\| composer\.pasteFiles\.files\.length > 0 \? \(/);
});

test("terminal preserves pixel size so window resize does not scale the dock", () => {
  assert.match(terminalDock, /groupResizeBehavior="preserve-pixel-size"/);
});

test("typed text grows the editor up to a dsh-like cap then scrolls", () => {
  assert.match(rendererUtils, /COMPOSER_TEXT_MAX_HEIGHT = 336/);
  assert.match(composerArea, /--composer-text-max-height/);
  assert.match(composerArea, /COMPOSER_TEXT_MAX_HEIGHT/);
  assert.match(
    tipTapComposer,
    /tiptap-composer-host flex min-w-0 flex-1 flex-col overflow-hidden/,
  );
  assert.match(
    timelineCss,
    /\.composer \.tiptap-composer-host \.ProseMirror,\s*\.composer \.tiptap-composer-host \.rich-input \{[\s\S]*?max-height:\s*var\(--composer-text-max-height,\s*336px\);[\s\S]*?overflow-y:\s*auto;/,
  );
});

test("column keeps a timeline floor and a compact composer floor", () => {
  assert.match(rendererUtils, /COMPOSER_DEFAULT_HEIGHT = 160/);
  assert.match(rendererUtils, /COMPOSER_MIN_HEIGHT = 112/);
  assert.match(rendererUtils, /COMPOSER_MAX_HEIGHT = 480/);
  assert.match(sessionView, /TIMELINE_MIN_HEIGHT \+ COMPOSER_MIN_HEIGHT/);
  assert.match(composerArea, /composer-box[^"]*shrink-0/);
  assert.match(composerArea, /className="composer[^\"]*px-0 pb-2"/);
});
