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
const timeline = readFileSync(
  "src/renderer/src/components/session/SessionMessageTimeline.tsx",
  "utf8",
);
const timelineCards = readFileSync(
  "src/renderer/src/components/session/TimelineEventCards.tsx",
  "utf8",
);
const chatContentWidth = readFileSync(
  "src/renderer/src/components/session/chatContentWidth.ts",
  "utf8",
);
const overlay = readFileSync(
  "src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx",
  "utf8",
);
const foundation = readFileSync(
  "src/renderer/src/styles/foundation.css",
  "utf8",
);
const tailwind = readFileSync(
  "src/renderer/src/styles/tailwind.css",
  "utf8",
);
const timelineStyles = readFileSync(
  "src/renderer/src/styles/timeline.css",
  "utf8",
);
const toolCards = readFileSync(
  "src/renderer/src/components/session/ToolCallComponents.tsx",
  "utf8",
);
const webTimeline = readFileSync(
  "src/renderer/src/web/WebTimeline.tsx",
  "utf8",
);
const approvalCard = readFileSync(
  "src/renderer/src/components/ui-shadcn/approval-card.tsx",
  "utf8",
);
const planModeExt = readFileSync(
  "resources/extensions/pi-deck-plan-mode.ts",
  "utf8",
);

test("Ask cards keep long content readable in every render path", () => {
  // 选项卡片/描述必须换行展示（break-words whitespace-normal），不能截断或裁切；
  // 注意批量问答 tab 胶囊是例外：tab 只做单行摘要（truncate），完整问题在详情区展示。
  assert.match(overlay, /break-words whitespace-normal/);
  // 批量问答 tab 胶囊：单行截断 + 悬停 title 看全文，禁止多行溢出胶囊固定高度。
  assert.match(overlay, /max-w-\[28ch\] min-w-0 truncate text-left" title=\{question\.question\}/);
  assert.match(toolCards, /whitespace-normal break-words font-mono text-caption/);
  assert.match(toolCards, /formatAskTitle\(item\.question/);
  assert.match(webTimeline, /formatAskTitle\(props\.request\.title/);
  assert.match(webTimeline, /flex-col items-start justify-center whitespace-normal/);
  assert.match(timelineStyles, /\.ask-question-card-option \{[\s\S]*?height: auto;[\s\S]*?min-height: 28px;/);
  assert.match(timelineStyles, /\.ask-question-card-options-confirm \.ask-question-card-option \{[\s\S]*?width: auto;[\s\S]*?min-width: 80px;/);
  // Ask 的展开内容必须交给会话时间线滚动，卡片本身不能因固定高度裁掉步骤或说明。
  assert.match(timelineStyles, /\.tool-card \{[\s\S]*?overflow: visible;/);
});

test("Plan/simple select options render as single-row optically aligned buttons", () => {
  // 2026-12 用户反馈：上下两行（标签/说明各一行）文本对不齐。
  // live 卡选项改为单行：固定高度 + 标签不缩 + 说明 truncate，等宽等高光学对齐。
  assert.match(
    overlay,
    /ask-inline-bar-option h-\[30px\] w-full min-w-0 max-w-none items-center justify-start gap-2 px-2 py-0 text-left/,
  );
  assert.match(overlay, /max-w-\[45%\] shrink-0 truncate text-caption font-medium leading-none text-text-primary/);
  assert.match(overlay, /min-w-0 flex-1 truncate text-micro leading-none text-text-tertiary/);
  // 时间线卡同一视觉语言：flex row + 单行截断，不再是上下两行。
  assert.match(timelineStyles, /\.ask-question-card-option \{[\s\S]*?flex-direction: row;[\s\S]*?align-items: center;/);
  assert.match(timelineStyles, /\.ask-question-card-option-label,[\s\S]*?white-space: nowrap;[\s\S]*?text-overflow: ellipsis;/);
});

test("Plan mode prompts keep steps concise and visually separated", () => {
  // 2026-12 用户反馈：步骤挤在一起难读。两处约束：
  // 1) 注入模型的 PLAN MODE 提示词要求每步一句短句、独立编号行（从源头控制简洁度）；
  // 2) 选单标题里每步之间空一行，卡片段落视觉隔离。
  assert.match(planModeExt, /Keep plan steps concise: one short sentence per step/);
  assert.match(planModeExt, /Put each step on its own numbered line/);
  assert.match(planModeExt, /\.join\("\\n\\n"\)/);
  // 摘要行带「是否执行」提问：卡片默认单行折基时也能看懂下一步待确认的动作。
  assert.match(planModeExt, /计划草案已就绪（" \+ todoItems\.length \+ " 步），是否执行？/);
});

test("Long ask descriptions collapse to a preview with eye toggle", () => {
  // 2026-12 用户反馈：plan 草案步骤太多导致卡片过高。默认折叠为 2 行摘要，
  // hover（title）可看全文，眼睛按钮显式切换全文/摘要；不传 previewLines 时行为不变。
  assert.match(approvalCard, /descriptionPreviewLines\?: number/);
  assert.match(approvalCard, /descriptionClamped && "line-clamp-2"/);
  assert.match(approvalCard, /title=\{descriptionClamped \? props\.description : undefined\}/);
  assert.match(approvalCard, /descExpanded \? <EyeOff size=\{14\}/);
  // live 卡与时间线卡都启用 1 行预览：plan 步骤已入上方待办，卡片默认只露摘要行。
  assert.match(overlay, /descriptionPreviewLines=\{1\}/);
  assert.match(timelineCards, /descriptionPreviewLines=\{1\}/);
  // 「1口」乱码回归：plan 草案步骤前缀不得用 ☐（部分 Windows 字体渲染成空心方框）。
  // widget/进度消息的 ☑/☐ 保留（agentTodoList 测试锁定，完成态语义明确）。
  assert.doesNotMatch(planModeExt, /\$\(item\.step\)\. ☐/);
});

/**
 * Ask 是会话级阻塞交互，不应参与 composer 的 flex 高度分配；否则 Ask 展开时会和
 * 编辑器的最小高度互相挤压。回归契约从两方面锁定这个边界：composer 不再接收 runtimeUi，
 * timeline 负责承载它；Ask 内容也不再创建第二个纵向滚动 owner。
 */
test("ask stays out of composer sizing and uses the session timeline as its scroll owner", () => {
  assert.doesNotMatch(composerArea, /runtimeUi/);
  assert.match(sessionView, /<SessionSurfaceStage[\s\S]*runtimeUi,/);
  assert.match(timeline, /className="session-runtime-ui mx-auto w-full/);
  assert.doesNotMatch(timeline, /session-runtime-ui sticky bottom-0/);
  // 内容宽度：消息区/输入框 inline width，Ask 随时间线同宽。
  // 时间线侧挂在 MessageScroller 的 contentProps（内层 [role=log]）上，
  // 视口铺满面板、滚动条贴面板最右，内容列仍与 composer 同宽居中。
  // 空态例外：showSurfaceEmptyState 时去掉约束（起始页自控宽度，与引导页一致）。
  assert.match(timeline, /contentProps=\{showSurfaceEmptyState \? undefined : \{ style: chatContentWidthStyle \}\}/);
  assert.doesNotMatch(timeline, /style=\{chatContentWidthStyle\}/);
  assert.doesNotMatch(timeline, /--chat-inline-pad/);
  assert.doesNotMatch(foundation, /--chat-inline-pad|--chat-side-gap/);
  assert.doesNotMatch(overlay, /CollapsibleContent className="min-h-0 overflow-y-auto"/);
  assert.doesNotMatch(overlay, /max-h-\[(?:55vh|180px|240px)\][^\n]*overflow-y-auto/);
});

/**
 * 没有 Ask 时，composer 仍从输入卡的最小高度起步；footer 的底部留白会进入
 * ComposerMeasuredExtras 的实测总高，再由 SessionView 在首次绘制前 hug 到正确高度。
 * 这样 Ask 不参与 composer 分配，也不会把 8px 留白漏算成裁切。
 */
test("composer measurement includes the bottom breathing room after ask moves to timeline", () => {
  assert.match(composerArea, /className="composer[^\"]*px-0 pb-2"/);
  assert.match(composerArea, /style\.paddingBottom/);
  assert.match(composerArea, /return Math\.ceil\([\s\S]*\+ paddingBottom\)/);
  assert.match(sessionView, /resolveComposerPanelHeight\(/);
});

/**
 * 消息列与输入框必须共享同一条滚动条槽位：时间线视口由自身 scrollbar-gutter 预留，
 * composer 面板用 overflow-hidden + scrollbar-gutter:stable 预留同宽槽位，两者百分比
 * 宽度/居中基准一致——任何宽度设置与平台（macOS 覆盖式滚动条时两侧同为 0）下都对齐，
 * 不依赖写死的像素补偿。
 */
test("composer panel reserves the same scrollbar gutter as the timeline", () => {
  assert.match(sessionView, /session-v-composer overflow-hidden \[scrollbar-gutter:stable\]/);
  assert.doesNotMatch(sessionView, /paddingRight/);
  // 时间线侧：宽度约束挂在滚动内容上（视口自带 scrollbar-gutter:stable 预留槽位）；
  // 空态例外：showSurfaceEmptyState 时去掉约束（起始页自控宽度，与引导页一致）。
  assert.match(timeline, /contentProps=\{showSurfaceEmptyState \? undefined : \{ style: chatContentWidthStyle \}\}/);
  assert.match(chatContentWidth, /scrollbar-gutter:stable/);
});
