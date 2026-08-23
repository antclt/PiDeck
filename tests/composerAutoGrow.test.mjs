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
const tipTapComposer = readFileSync(
  "src/renderer/src/components/session/composer/TipTapComposer.tsx",
  "utf8",
);
const timelineCss = readFileSync("src/renderer/src/styles/timeline.css", "utf8");

/**
 * 输入区高度契约（对齐 dsh-web InputBar）：
 * todo / goal / queue 是输入卡上方的独立卡，不和输入卡抢同一段 flex 高度；
 * 输入卡内容自适应（正文超高才长高，封顶后内部滚动）；
 * 面板仍按「独立卡 + 输入卡」总高度 hug，避免裁切，但输入卡本身不再 flex-1 吃剩余空间。
 * 因此拉伸 todo / 拖终端分隔条都不会把输入框拉高。
 */
test("composer measures extras and the input card as total content height", () => {
  assert.match(composerArea, /widgetsRef/);
  assert.match(composerArea, /attachmentBarRef/);
  assert.match(composerArea, /composerBoxRef/);
  // 同步测量：layout effect 在绘制前 flush，面板 hug 与内容同帧
  assert.match(composerArea, /useLayoutEffect\(\(\) => \{\n\s*if \(!mountedRef\.current\) return;/);
  assert.match(composerArea, /const contentHeight = measureContentHeight\(\);[\s\S]*onHeightChangeRef\.current\(contentHeight\)/);
  // 首测仍等 Panel 注册；之后子组件自己的展开/收起只会触发 ResizeObserver。
  // 观察回调必须在绘制前同步提交，不能再延后一帧。
  assert.match(composerArea, /import \{ flushSync \} from "react-dom"/);
  assert.match(
    composerArea,
    /const reportObservedContentHeight = \(\) => \{\n\s*if \(!mountedRef\.current\) return;[\s\S]*?flushSync\(\(\) => \{\n\s*reportContentHeight\(\);\n\s*\}\);\n\s*\};/,
  );
  assert.match(composerArea, /new ResizeObserver\(reportObservedContentHeight\)/);
  assert.match(composerArea, /mountedRef\.current = false;[\s\S]*observer\.disconnect\(\)/);
  assert.match(
    composerArea,
    /initialMeasureFrame = requestAnimationFrame\(\(\) => \{[\s\S]*mountedRef\.current = true;[\s\S]*reportContentHeight\(\);/,
  );
  // 非受控（起始页）随内容 intrinsic 增高，不再用 extra+DEFAULT 抬本地 height
  assert.doesNotMatch(composerArea, /extra \+ \(props\.defaultHeight \?\? COMPOSER_DEFAULT_HEIGHT\)/);
});

test("extras height sync lives in a child that rerenders when variable content changes", () => {
  assert.match(
    composerArea,
    /function ComposerMeasuredExtras[\s\S]*useLayoutEffect/,
  );
  assert.match(
    composerArea,
    /<ComposerMeasuredExtras[\s\S]*widgets=\{props\.widgets \?\? null\}/,
  );
});

test("widget stacks scroll only when the panel is hard-capped, while the input card stays shrink-proof", () => {
  // 正常高度下 widgets 按内容撑开；timeline/terminal 已到约束时才允许它缩小并内部滚动，
  // 避免 footer overflow-hidden 把输入卡裁掉。自然 scrollHeight 仍参与 panel 预算。
  const widgetsSlot = composerArea.indexOf("ref={widgetsRef}");
  const attachmentSlot = composerArea.indexOf("ref={attachmentBarRef}");
  const boxSlot = composerArea.indexOf("ref={composerBoxRef}");
  assert.ok(widgetsSlot !== -1 && widgetsSlot < attachmentSlot);
  assert.match(
    composerArea,
    /Math\.max\(widgetsEl\.offsetHeight, widgetsEl\.scrollHeight\)/,
  );
  assert.match(
    composerArea,
    /ref=\{widgetsRef\}[\s\S]*?className="flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto overscroll-contain pb-px empty:hidden"/,
  );
  // 末尾 1px 进入 scrollHeight 与面板预算，避免最后一张卡的下沿贴着裁切面。
  assert.match(composerArea, /ComposerWidgetLayoutProvider/);
  assert.match(composerArea, /ref=\{attachmentBarRef\}[\s\S]*?className="shrink-0"/);
  assert.match(
    composerArea,
    /composer-box relative flex w-full min-w-0 shrink-0 flex-col/,
  );
  assert.doesNotMatch(
    composerArea,
    /composer-box relative flex min-h-0 w-full min-w-0 flex-1 flex-col/,
  );
  assert.ok(boxSlot !== -1);
});

test("image attachment bar stays glued to the input box", () => {
  const measuredComponent = composerArea.indexOf("function ComposerMeasuredExtras");
  const widgetsSlot = composerArea.indexOf("ref={widgetsRef}", measuredComponent);
  const attachmentSlot = composerArea.indexOf("ref={attachmentBarRef}", measuredComponent);
  const measuredCall = composerArea.indexOf("<ComposerMeasuredExtras");
  const composerBoxSlot = composerArea.indexOf('className={["composer-box');
  assert.ok(widgetsSlot !== -1 && widgetsSlot < attachmentSlot);
  assert.ok(
    measuredCall !== -1 &&
      measuredCall < composerBoxSlot,
  );
  assert.match(composerArea, /composer\.attachments\.length > 0 \? \(/);
  assert.match(composerArea, /getComputedStyle\(footerEl\)/);
  assert.match(composerArea, /style\.rowGap/);
  assert.match(composerArea, /style\.paddingBottom/);

});

test("session view hugs composer panel to measured content height, not default plus extras", () => {
  assert.match(sessionView, /composerPanelRef/);
  assert.match(sessionView, /panelRef=\{composerPanelRef\}/);
  assert.match(sessionView, /onContentHeightChange=\{handleComposerContentHeight\}/);
  // 面板目标 = 测得的独立卡+输入卡总高，不再用 DEFAULT+extra 把输入区算进「被 extras 顶高」
  assert.doesNotMatch(sessionView, /COMPOSER_DEFAULT_HEIGHT \+ extraHeight/);
  assert.match(sessionView, /resolveComposerPanelHeight\(/);
  assert.doesNotMatch(sessionView, /Math\.max\(userPreferred, contentHeight, COMPOSER_MIN_HEIGHT\)/);
  assert.match(sessionView, /group\.setLayout\(next\)/);
  assert.match(sessionView, /growComposerWithinTimelineBudget/);
  assert.match(sessionView, /const panel = composerPanelRef\.current;[\s\S]*panel\.resize\(target\)/);
  assert.match(sessionView, /target > current/);
  assert.match(sessionView, /current <= contentDrivenHeightRef\.current/);
  assert.match(sessionView, /contentDrivenHeightRef\.current = Math\.min/);
  assert.match(sessionView, /programmaticResizeTargetRef/);
  assert.match(sessionView, /programResizeExpireRef\.current = Date\.now\(\) \+ 200/);
  assert.match(sessionView, /Math\.abs\(px - contentDrivenHeightRef\.current\) <= 2/);
  assert.match(sessionView, /applyComposerHeight\(px, true\)/);
  assert.match(sessionView, /const appliedLayout = group\.setLayout\(next\)/);
  assert.match(sessionView, /const appliedTarget = Math\.round\(/);
  assert.match(sessionView, /appliedLayout\.composer \?\? budget\.composer/);
  assert.match(sessionView, /const appliedHeight = programResize\(target\);[\s\S]*applyComposerHeight\(appliedHeight, false\)/);
  assert.match(sessionView, /Group not found/);
});

test("typed text grows the editor up to a dsh-like cap then scrolls", () => {
  assert.match(rendererUtils, /COMPOSER_TEXT_MAX_HEIGHT = 336/);
  assert.match(composerArea, /--composer-text-max-height/);
  assert.match(composerArea, /COMPOSER_TEXT_MAX_HEIGHT/);
  // host 可以 flex-1 填满 shrink-0 输入卡的 min-height；解耦靠的是输入卡本身不吃面板。
  assert.match(
    tipTapComposer,
    /tiptap-composer-host flex min-w-0 flex-1 flex-col overflow-hidden/,
  );
  assert.match(
    timelineCss,
    /\.composer \.tiptap-composer-host \.ProseMirror,\s*\.composer \.tiptap-composer-host \.rich-input \{[\s\S]*?max-height:\s*var\(--composer-text-max-height,\s*336px\);[\s\S]*?overflow-y:\s*auto;/,
  );
});

test("auto growth does not relax the existing minimum-size constraints", () => {
  assert.match(rendererUtils, /COMPOSER_DEFAULT_HEIGHT = 160/);
  assert.match(rendererUtils, /COMPOSER_MIN_HEIGHT = 112/);
  assert.match(sessionView, /minSize=\{COMPOSER_MIN_HEIGHT\}/);
  assert.match(composerArea, /composer-box[^"]*shrink-0/);
  // footer 的 8px 底部留白属于可见内容，测量链会把它计进面板高度，避免输入卡贴边。
  assert.match(composerArea, /className="composer[^\"]*px-0 pb-2"/);
});
