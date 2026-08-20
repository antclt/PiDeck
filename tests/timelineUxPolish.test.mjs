import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const toolCard = readFileSync(
  "src/renderer/src/components/session/ToolCallComponents.tsx",
  "utf8",
);
const turnExecution = readFileSync(
  "src/renderer/src/components/session/turn/useTurnExecution.ts",
  "utf8",
);
const controller = readFileSync(
  "src/renderer/src/hooks/useSessionTimelineController.ts",
  "utf8",
);
const scroller = readFileSync(
  "src/renderer/src/components/agents/message-scroller.tsx",
  "utf8",
);
const turnRow = readFileSync(
  "src/renderer/src/components/session/turn/TurnRow.tsx",
  "utf8",
);
const timeline = readFileSync(
  "src/renderer/src/components/session/SessionMessageTimeline.tsx",
  "utf8",
);

test("tool card name uses medium weight like process summary, not bold 650", () => {
  assert.match(
    toolCard,
    /className="shrink-0 text-control font-medium lowercase text-text-secondary"/,
  );
  assert.doesNotMatch(toolCard, /font-\[650\]/);
  // ToolActivityCard 也不再用 <strong> 加粗
  assert.doesNotMatch(toolCard, /tool-activity-copy>\s*<strong>/);
  assert.match(toolCard, /tool-activity-name/);
});

test("latest turn auto-collapses from the timeline idle signal after streaming", () => {
  // 1.5s idle 计时在 timeline 侧；TurnRow 只消费 autoCollapseTick。
  assert.doesNotMatch(turnExecution, /}, 1500\)/);
  assert.match(timeline, /TURN_SETTLE_IDLE_COLLAPSE_MS = 1500/);
  assert.match(turnExecution, /autoCollapseTick/);
  assert.match(turnExecution, /onAutoCollapsed/);
  // 不再在「运行中 → 停转」边沿自动展开执行过程（旧 2026-12 兼容行为已移除）
  assert.doesNotMatch(turnExecution, /const justFinished = wasRunningRef\.current && !running;/);
  // 上升沿仍只在设置①开启时展开，避免用户收起后被 busy 抖动撑开
  assert.match(turnExecution, /!wasRunningRef\.current/);
  assert.match(turnExecution, /setStepsVisibleFromUser/);
});

test("scrollToBottom uses stick-to-bottom spring via scrollerScrollApiRef", () => {
  assert.match(controller, /scrollerScrollApiRef/);
  assert.match(controller, /api\.scrollToBottom\(\{ animation \}\)/);
  // 不再把回底按钮绑成裸 timeline.scrollTo 作为主路径（兜底除外）
  assert.match(scroller, /scrollApiRef/);
  assert.match(scroller, /MessageScrollerScrollApi/);
  assert.match(timeline, /scrollApiRef=\{controller\.scrollerScrollApiRef\}/);
});

test("auto-collapse uses run-start positioning without breaking follow semantics", () => {
  // 最终回答标记仍在（折叠后阅读用）；自动收起回调使用新的 onAutoCollapsed。
  assert.match(turnRow, /data-final-answer=\{run\.id\}/);
  assert.doesNotMatch(controller, /scrollFinalAnswerIntoView/);
  assert.doesNotMatch(turnRow, /onProcessAutoCollapsed/);
  assert.doesNotMatch(timeline, /onProcessAutoCollapsed/);
  assert.match(turnRow, /onAutoCollapsed/);
  assert.match(controller, /scrollFinalAnswerToUpperMiddle/);
  assert.match(controller, /data-final-answer/);
  assert.match(controller, /SETTLED_TURN_VIEWPORT_ANCHOR_RATIO/);
  // isLatestRun（自动收起）保持按「最后一条显示条目」判定；
  // live 挂载门用单独的 isLastAgentRun（最后一个 agent-run）判定——
  // 两者语义不同，不能合并（见 liveMountDecision 回归）
  assert.match(timeline, /isLatestRun=\{index === displayRuns\.length - 1\}/);
  assert.match(timeline, /isLastAgentRun=\{index === lastAgentRunIndex\}/);
  assert.match(timeline, /lastAgentRunIndex/);
});

test("followOutput re-lock uses spring when far from bottom", () => {
  // 避免回底按钮 setAutoScroll(true) 后被 layout instant 掐死弹簧
  assert.match(
    scroller,
    /reduce \|\| distance <= followThreshold \? "instant" : "smooth"/,
  );
});
