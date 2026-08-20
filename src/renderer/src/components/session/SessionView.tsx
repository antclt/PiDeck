import { useAtomValue } from "jotai";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type ReactNode, type MutableRefObject } from "react";
import {
  type GroupImperativeHandle,
  type PanelImperativeHandle,
  type PanelSize,
} from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../ui-shadcn/resizable";
import type { AgentRuntimeState, GitBranchInfo, ImageContent, TerminalTarget } from "../../../../shared/types";
import type { SessionTimelineController } from "../../hooks/useSessionTimelineController";
import type { PiDesktopApi } from "../../../../preload";
import { isLanWeb, desktopApi as api } from "../../desktopApi";
import { useNotifyLayoutResized } from "../../hooks/useNotifyLayoutResized";
import { SessionHeader } from "./SessionHeader";
import { SessionBranchBar } from "./SessionBranchBar";
import { SessionTodoStrip } from "./SessionTodoStrip";
import { SessionGoalStrip } from "./SessionGoalStrip";
import { SessionSurfaceStage } from "./SessionSurfaceStage";
import { ComposerArea } from "./ComposerArea";
import { SessionRuntimeDock } from "./SessionRuntimeDock";
import { useSessionPaneServices } from "./SessionPaneServices";
import { COMPOSER_MIN_HEIGHT, TIMELINE_MIN_HEIGHT, growComposerWithinTimelineBudget, redistributeTerminalAgainstTimeline, displayProjectDirectoryName, shouldMountBottomComposer, sessionResizableGroupKey, sanitizeSessionPanelLayout, sessionGroupDefaultLayout, resolveComposerPanelHeight } from "../../rendererUtils";
import { projectByIdAtomFamily, sessionRecordByIdAtomFamily } from "../../atoms";
import type { EnqueuePromptSnapshot } from "../../hooks/useSessionSend";

// terminal 程序化布局保护窗口（ms）：programResize 后该窗口内的 terminal
// onResize 一律视为程序化结果，不写 collapsed 状态。独立于 composer 的共享
// 标记，避免 composer onResize 先触发清掉保护后，terminal 回调被误判为折叠。
const TERMINAL_PROGRAMMATIC_PROTECT_MS = 250;

export type SessionViewProps = {
  // ── Session identity ──
  sessionId: string;
  sessionTitle: string;
  sessionTimeline: SessionTimelineController;
  /** 分屏栏：加边框与点击聚焦；单栏 Tab 已外置，同样只渲染 Header */
  splitPane?: boolean;
  focused?: boolean;
  onFocusPane?: () => void;
  activeAgentId?: string;
  activeAgent?: {
    compactionCount?: number;
    noSession?: boolean;
    status?: string;
  } | null;
  hasActiveConversation: boolean;
  hasProject: boolean;

  // ── Layout refs ──
  chatHeaderRef: RefObject<HTMLDivElement | null>;
  composerRef: RefObject<HTMLElement | null>;
  composerOffsetHeight: number;
  terminalRowHeight: number;

  // ── Header 状态 ──
  isAgentStarting: boolean;
  isRestarting: boolean;
  sessionDuration?: number;

  // ── Timeline interaction ──
  showThinking: boolean;
  validCommandNames: Set<string>;
  validFilePaths: Set<string>;
  onPreviewImage: (image: ImageContent) => void;
  onOpenFile?: (path: string) => void;
  onDiffFile?: (path: string) => void;
  onResendUserMessage?: (message: any) => void;
  onEditMessage?: (messageId: string, newText: string) => void;
  onDeleteMessage?: (messageId: string) => void;
  onForkMessage?: (message: any) => void;
  forkingMessageId?: string | null;
  onToast: (message: string) => void;
  onQuickPrompt?: (prompt: string) => void;
  canMutateActiveMessages: boolean;
  /** 分支导航条：打开兄弟/父/子分支会话（SessionRuntimeInjector 装配 openSidebarSessionById） */
  onOpenBranchSession?: (sessionId: string) => void;

  // ── Composer ──
  enqueueSessionPrompt: (sessionId: string, snapshot: EnqueuePromptSnapshot) => boolean;
  gitInfo?: GitBranchInfo;
  openFilePath?: (path: string) => void;
  ensureSessionId?: (sessionId: string) => Promise<string>;
  queuePanel?: ReactNode;
  runtimeUi?: ReactNode;

  // ── Terminal dock ──
  terminalDockVisible: boolean;
  terminalOpen: boolean;
  terminalDockClosing: boolean;
  terminalCollapsed: boolean;
  availableTerminalHeight: number;
  /** 终端归属键（agent:<id> / project:<id>）：状态回写与 dock 实例隔离都按它 */
  terminalOwnerKey?: string;
  /** agent 或 project 终端目标；undefined 时不渲染 dock */
  terminalTarget?: TerminalTarget;
  setTerminalOpenForOwner: (open: boolean) => void;
  setTerminalCollapsedForOwner: (collapsed: boolean) => void;
  setTerminalHeightByOwner: (
    updater: (current: Record<string, number>) => Record<string, number>
  ) => void;

  // ── Other visibility ──
  settingsOpen: boolean;
  configOpen: boolean;
  environmentDialog: boolean;

  // ── Session actions ──
  runCreateSessionDraft: () => void;
  abortAgent: () => void;
};

export function SessionView({
  sessionId,
  sessionTitle,
  sessionTimeline,
  splitPane = false,
  focused = true,
  onFocusPane,
  activeAgentId,
  activeAgent,
  hasActiveConversation,
  hasProject,
  chatHeaderRef,
  composerRef,
  composerOffsetHeight,
  terminalRowHeight,
  isAgentStarting,
  isRestarting,
  sessionDuration,
  showThinking,
  validCommandNames,
  validFilePaths,
  onPreviewImage,
  onOpenFile,
  onDiffFile,
  onResendUserMessage,
  onEditMessage,
  onDeleteMessage,
  onForkMessage,
  forkingMessageId,
  onToast,
  onQuickPrompt,
  canMutateActiveMessages,
  onOpenBranchSession,
  enqueueSessionPrompt,
  gitInfo,
  openFilePath,
  ensureSessionId,
  queuePanel,
  runtimeUi,
  terminalDockVisible,
  terminalOpen,
  terminalDockClosing,
  terminalCollapsed,
  availableTerminalHeight,
  terminalOwnerKey,
  terminalTarget,
  setTerminalOpenForOwner,
  setTerminalCollapsedForOwner,
  setTerminalHeightByOwner,
  settingsOpen,
  configOpen,
  environmentDialog,
  runCreateSessionDraft,
  abortAgent,
}: SessionViewProps) {
  const paneServices = useSessionPaneServices();
  // 会话身份面包屑的项目名：多 Tab/分屏时提醒当前会话属于哪个项目。
  // 从会话记录解析 projectId → 项目目录名；无记录（匿名会话等）时省略。
  const sessionRecord = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
  const project = useAtomValue(projectByIdAtomFamily(sessionRecord?.projectId ?? ""));
  const projectName = project ? displayProjectDirectoryName(project) : undefined;
  // #115 U5 垂直轴：timeline | composer | terminal 三段由 react-resizable-panels 接管。
  // composer 高度本地持有（px），终端高度/折叠仍由 useTerminalDock 的 per-agent
  // 状态持有，拖拽结果经 onResize 回写，外部状态经 imperative API 同步。
  // 起步高度走 COMPOSER_MIN_HEIGHT（输入卡本身），测到内容后再 hug；
  // 不再用 DEFAULT(160) 预留指标空位。Ask 固定在时间线底部，不占输入栏高度。
  const [composerHeight, setComposerHeight] = useState(COMPOSER_MIN_HEIGHT);
  const notifyLayoutResized = useNotifyLayoutResized();
  const terminalPanelRef = useRef<PanelImperativeHandle | null>(null);
  const sessionGroupRef = useRef<GroupImperativeHandle | null>(null);

  // ── composer 面板自适应高度（#115 U5 布局换装） ──────────────
  // 面板高度由 react-resizable-panels 持有；输入区上方出现可变内容（Todo/记忆
  // widget、图片附件等）时，footer 固定高度会把 composer-box 挤到 min-height 并
  // 被 overflow-hidden 裁切，输入区显示不清晰。这里通过 panelRef 命令式 resize：
  // 内容需要更高 → 自动增高；内容减少（含完全消失）且当前高度由内容驱动 → 回缩，
  // 但用户手动拖高的高度不被内容变化回缩。
  const composerPanelRef = useRef<PanelImperativeHandle | null>(null);
  const composerHeightStateRef = useRef(COMPOSER_MIN_HEIGHT);
  // 用户手动拖高后的面板高度。0 = 从未拖过，此时 hug 实测内容，不把 DEFAULT 当楼板。
  const userComposerHeightRef = useRef(0);
  // 内容驱动高度：最近一次内容所需的面板高度。回缩只发生在 current <= 该值
  // （面板高度未超过内容所需，即没有被用户手动拖高）。
  const contentDrivenHeightRef = useRef(COMPOSER_MIN_HEIGHT);
  // resize() 经 ResizeObserver 异步触发 onResize；用「时间窗口 + 内容驱动高度
  // 匹配」双重判断区分程序 resize 与用户拖拽，避免程序增高后的回调被误判为
  // 用户操作（误判会把用户手动高度抬到内容高度，导致内容减少时不再回缩）。
  const programmaticResizeTargetRef = useRef<number | null>(null);
  const programResizeExpireRef = useRef(0);
  // terminal 专用的程序化保护窗口：programResize 设置、仅由超时清空。
  // 不能复用 programmaticResizeTargetRef——composer 的 onResize 会把它清掉，
  // 若 terminal 的 onResize 后触发（连续 setLayout 竞态下 K() 把 terminal
  // 压到折叠阈值），就落在保护窗口外被误判为用户折叠，导致发送消息时终端被收起。
  const terminalProgrammaticExpireRef = useRef(0);

  const composerMaxHeight = Math.max(COMPOSER_MIN_HEIGHT, Math.min(480, window.innerHeight - 260));
  const terminalPanelVisible =
    !isLanWeb && !settingsOpen && !configOpen && !environmentDialog &&
    terminalDockVisible && terminalOpen;
  // 历史会话加载期 messages 仍为空：仍挂底部栏，避免 1 面板 Group 套用 2 值缓存。
  // 空会话磁盘就绪后卸底部栏，改由 timeline 内 SessionStartSurface 居中输入。
  const bottomComposerVisible = shouldMountBottomComposer({
    hasActiveConversation,
    messageCount: sessionTimeline.messages.length,
    isConversationLoading: sessionTimeline.isSurfaceLoading,
  });
  const sessionPanels = {
    composer: bottomComposerVisible,
    terminal: terminalPanelVisible,
  };

  function applyComposerHeight(px: number, fromUser: boolean) {
    composerHeightStateRef.current = px;
    setComposerHeight(px);
    if (fromUser) {
      userComposerHeightRef.current = px;
    }
  }

  function programResize(target: number): boolean {
    programmaticResizeTargetRef.current = target;
    programResizeExpireRef.current = Date.now() + 200;
    terminalProgrammaticExpireRef.current =
      Date.now() + TERMINAL_PROGRAMMATIC_PROTECT_MS;
    try {
      // 优先走 Group.setLayout：composer 增高时保持 terminal 高度不变，从 timeline
      // 拿空间。库的 panel.resize() 默认从相邻面板（terminal）拿空间，粘贴图片会
      // 把终端面板压扁（#115 U5 反馈）。timeline 低于 minSize 时由 K() 自动 clamp。
      const group = sessionGroupRef.current;
      const composerSize = composerPanelRef.current?.getSize();
      if (
        group &&
        composerSize &&
        composerSize.inPixels > 0 &&
        composerSize.asPercentage > 0
      ) {
        const layout = group.getLayout();
        if (Object.keys(layout).length > 0) {
          // getSize() 返回 px 与百分比，反推 group 总高，把目标 px 转成百分比。
          const groupPx = (composerSize.inPixels / composerSize.asPercentage) * 100;
          const targetPct = Math.min(100, (target / groupPx) * 100);
          // 增高预算受 timeline 保底线限制：timeline 让不出空间时不再硬扣，
          // 否则库 K() 会把 clamp 差额压给 collapsible 的 terminal，导致发送消息/输出时终端被收起。
          const budget = growComposerWithinTimelineBudget(
            layout,
            composerSize.asPercentage,
            targetPct,
            groupPx,
            TIMELINE_MIN_HEIGHT,
          );
          // setLayout 键必须等于当前已注册面板，否则 K() 抛 Invalid N panel layout。
          // 关终端 / 历史会话加载期卸 composer 后 getLayout 仍可能带旧键。
          const next = sanitizeSessionPanelLayout(
            { ...layout, composer: budget.composer, timeline: budget.timeline },
            { composer: bottomComposerVisible, terminal: terminalPanelVisible },
          );
          group.setLayout(next);
          return true;
        }
      }
      // group 未就绪（挂载早期）回退旧路径：相邻面板（terminal）让出空间。
      composerPanelRef.current?.resize(target);
    } catch {
      // 面板尚未注册到 ResizablePanelGroup（挂载早期时序）时 resize 会抛
      // Group not found；静默跳过并清除目标值，下一轮内容测量会再次尝试。
      programmaticResizeTargetRef.current = null;
      return false;
    }
    // 兜底：resize 未触发 onResize（面板未挂载/已卸载）时也清除目标值，
    // 避免残留目标吞掉下一次真实拖拽（与目标恰好一致的极小概率）。
    window.setTimeout(() => {
      if (Date.now() >= programResizeExpireRef.current) {
        programmaticResizeTargetRef.current = null;
      }
    }, 250);
    return true;
  }

  /**
   * ComposerArea 上报独立卡 + 输入卡 +（有数字才出现的）指标条总高度。
   * 未拖过时 hug 实测值，不把 DEFAULT 当用户偏好；指标消失后底空隙一并收回。
   * 输入卡本身 shrink-0：面板被终端拖高时剩余空白不撑开输入框。
   */
  function handleComposerContentHeight(contentHeight: number) {
    const target = resolveComposerPanelHeight({
      contentHeight,
      userPreferredHeight: userComposerHeightRef.current,
      minHeight: COMPOSER_MIN_HEIGHT,
      maxHeight: composerMaxHeight,
    });
    const current = composerHeightStateRef.current;
    // 百分比缓存可能把面板撑高，而 state 仍是 min：state 已贴合时仍要对齐视觉高度。
    const visualPx = Math.round(composerPanelRef.current?.getSize()?.inPixels ?? current);
    if (target === current && Math.abs(visualPx - target) <= 2) return;
    if (target > current) {
      contentDrivenHeightRef.current = target;
      if (programResize(target)) applyComposerHeight(target, false);
      return;
    }
    // 未拖过必须收回空隙（指标消失、独立卡收起）；拖过才用内容驱动闸门，避免拖高被回吞。
    if (userComposerHeightRef.current <= 0 || current <= contentDrivenHeightRef.current) {
      contentDrivenHeightRef.current = Math.min(
        contentDrivenHeightRef.current,
        target,
      );
      if (programResize(target)) applyComposerHeight(target, false);
    }
  }

  const terminalRowHeightRef = useRef(terminalRowHeight);
  terminalRowHeightRef.current = terminalRowHeight;

  // 终端 Panel 随 terminalOpen 动态挂载，约束注册有一帧延迟（与抽屉同款问题），
  // imperative 同步统一推迟一帧并容错。折叠/展开后立刻把差额还给 timeline：
  // collapse() 会把高度补给相邻 composer，输入框停在半空；切会话会再跑一遍
  // collapse，必须用 composerHeightStateRef（用户拖拽/内容高度）当锚点，
  // 不能读已经被撑高的 layout.composer。
  useEffect(() => {
    const panel = terminalPanelRef.current;
    const group = sessionGroupRef.current;
    if (!panel) return;
    const frame = requestAnimationFrame(() => {
      try {
        // 先打程序化窗口：collapse() 触发的 composer onResize 既不能记成用户拖高，
        // 也不能写进 composerHeight——否则切会话再 collapse 会用被污染的锚点。
        programmaticResizeTargetRef.current = composerHeightStateRef.current;
        programResizeExpireRef.current = Date.now() + 200;
        terminalProgrammaticExpireRef.current =
          Date.now() + TERMINAL_PROGRAMMATIC_PROTECT_MS;
        if (terminalCollapsed) { if (!panel.isCollapsed()) panel.collapse(); }
        else if (panel.isCollapsed()) panel.expand();
        if (!group) return;
        const size = composerPanelRef.current?.getSize();
        if (!size || size.inPixels <= 0 || size.asPercentage <= 0) return;
        const groupPx = (size.inPixels / size.asPercentage) * 100;
        const preserveComposerPct = Math.min(
          100,
          (composerHeightStateRef.current / groupPx) * 100,
        );
        const collapsedPct = (34 / groupPx) * 100;
        const terminalPct = terminalCollapsed
          ? collapsedPct
          : Math.min(100, (terminalRowHeightRef.current / groupPx) * 100);
        const next = redistributeTerminalAgainstTimeline(
          group.getLayout(),
          terminalPct,
          preserveComposerPct,
          (TIMELINE_MIN_HEIGHT / groupPx) * 100,
        );
        if (!next) return;
        group.setLayout(next);
      } catch { /* 约束未就绪，下轮状态再同步 */ }
    });
    return () => cancelAnimationFrame(frame);
  }, [terminalCollapsed, terminalOpen, terminalDockVisible]);

  function handleComposerResize(size: PanelSize) {
    const px = Math.round(size.inPixels);
    const now = Date.now();
    // 程序 resize 的异步回调：时间窗口内（刚 programResize），或最终高度与
    // 内容驱动高度一致（即使回调延迟/像素取整）都视为程序化结果，不记为用户
    // 手动高度，避免内容减少时误判导致不回缩。
    // 折叠/展开终端期间的 onResize 一律丢弃：库会短暂把腾出的高度写进 composer，
    // 若此时写 state / 用户锚点，切会话再 collapse 会把输入框重新撑到半空。
    if (now < terminalProgrammaticExpireRef.current) return;
    const isProgrammatic =
      (programmaticResizeTargetRef.current != null &&
        now < programResizeExpireRef.current) ||
      Math.abs(px - contentDrivenHeightRef.current) <= 2;
    if (isProgrammatic) {
      programmaticResizeTargetRef.current = null;
      composerHeightStateRef.current = px;
      setComposerHeight(px);
      return;
    }
    // 从未拖过：丢掉首帧均分/百分比缓存的一次跳变（16% 缓存 ≈160px 也会锁住底空隙）。
    // 真拖分隔条是从当前像素连续变化，允许小步；一次跳过 40px 视为布局噪声。
    // 必须立刻 hug 回 state：只 return 的话面板已是 160、state 仍是 112，后续测量会以为已经贴合。
    if (
      userComposerHeightRef.current <= 0 &&
      px > composerHeightStateRef.current + 40
    ) {
      void programResize(contentDrivenHeightRef.current);
      return;
    }
    programmaticResizeTargetRef.current = null;
    applyComposerHeight(px, true);
  }

  function handleTerminalResize(size: PanelSize) {
    const px = Math.round(size.inPixels);
    if (!terminalOwnerKey) return;
    // 34px 为折叠条高度：拖到折叠阈值视为折叠，拖回展开。
    // 程序化 setLayout（composer 增高/回缩）触发的 onResize 不算用户折叠意图：
    // 布局挤压导致的面板变矮不应把 collapsed 状态写死，否则下次打开仍是收起的。
    // 用独立保护窗口而非共享的 programmaticResizeTargetRef：后者会被 composer 的
    // onResize 消费清空，terminal 回调后触发时会失去保护。
    const withinProgrammaticWindow =
      Date.now() < terminalProgrammaticExpireRef.current;
    if (px <= 35) {
      if (!terminalCollapsed && !withinProgrammaticWindow) {
        setTerminalCollapsedForOwner(true);
      }
      return;
    }
    if (terminalCollapsed && !withinProgrammaticWindow) {
      setTerminalCollapsedForOwner(false);
    }
    const maxHeight = Math.max(120, availableTerminalHeight);
    setTerminalHeightByOwner((current) => ({
      ...current,
      [terminalOwnerKey]: Math.min(px, maxHeight),
    }));
  }

  // solo 栏无 sessionId key，切会话复用本组件。必须在 render 阶段重置高度：
  // useLayoutEffect 太晚，Group 已按旧 defaultSize 注册，输入框会悬在半空。
  // setState-during-render 是 React 官方「prop 变化重置 state」写法，本轮会被丢弃重渲。
  const composerHeightSessionRef = useRef(sessionId);
  if (composerHeightSessionRef.current !== sessionId) {
    composerHeightSessionRef.current = sessionId;
    composerHeightStateRef.current = COMPOSER_MIN_HEIGHT;
    userComposerHeightRef.current = 0;
    contentDrivenHeightRef.current = COMPOSER_MIN_HEIGHT;
    if (composerHeight !== COMPOSER_MIN_HEIGHT) {
      setComposerHeight(COMPOSER_MIN_HEIGHT);
    }
  }

  // 最近一次三面板布局快照（terminal 可见时持续记录），关闭终端时恢复用。
  const lastThreePanelLayoutRef = useRef<Record<string, number> | null>(null);
  useEffect(() => {
    if (!terminalPanelVisible) return;
    try {
      lastThreePanelLayoutRef.current =
        sessionGroupRef.current?.getLayout() ?? null;
    } catch { /* Group 未挂载 */ }
  });

  // terminal 面板卸载时 Group 重注册：2 面板布局缓存缺失会按 defaultSize
  // 回退（输入框高度跳变 + 内容被压缩出滚动条）。这里在 paint 前用「关闭前
  // 的三面板布局」主动恢复：composer 保持关闭前高度，timeline 吸收 terminal
  // 释放的空间；setLayout 同时填充 "timeline,composer" 缓存，重开终端时
  // 三面板缓存恢复原布局。程序化标记避免恢复触发的 onResize 污染用户手动高度。
  //
  // 条件只按 terminalPanelVisible（面板渲染条件）判断，不叠加 terminalOpen：
  // 打开设置/配置弹窗时 settingsOpen=true → terminal 面板卸载（组变 2 面板），
  // 但 terminalOpen 仍为 true；若此时 return 不转换布局，缓存仍是 3 值，
  // react-resizable-panels 的 ResizeObserver 用 3 值校验 2 面板会抛
  // 「Invalid 2 panel layout」导致 SessionView 崩溃（0.7.0-beta 线上反馈）。
  useLayoutEffect(() => {
    if (terminalPanelVisible) return;
    const prev = lastThreePanelLayoutRef.current;
    const group = sessionGroupRef.current;
    const panel = composerPanelRef.current;
    if (!prev || !group || !panel || prev.composer === undefined) return;
    try {
      // 卸 terminal 时若 composer 也未挂（空会话起始页），只保留 timeline，
      // 不能把 2 值 layout 打到 1 面板上（Invalid 1 panel layout）。
      const next = sanitizeSessionPanelLayout(prev, {
        composer: bottomComposerVisible,
        terminal: false,
      });
      const size = panel.getSize();
      if (size.inPixels <= 0 || size.asPercentage <= 0) return;
      const groupPx = size.inPixels / (size.asPercentage / 100);
      const expectedPx = Math.round(groupPx * (prev.composer / 100));
      programmaticResizeTargetRef.current = expectedPx;
      programResizeExpireRef.current = Date.now() + 200;
      group.setLayout(next);
      applyComposerHeight(expectedPx, false);
    } catch { /* Group 未就绪 */ }
  }, [bottomComposerVisible, terminalPanelVisible, terminalOpen]);

  return (
    <div
      className={
        splitPane
          ? `session-split-pane flex h-full min-h-0 flex-col${focused ? " session-split-pane-focused" : ""}`
          : "contents"
      }
      onMouseDown={splitPane ? () => onFocusPane?.() : undefined}
    >
      {/* Tab 栏已统一外置；运行控制（停止/重启）在共享 Tab 栏的 Tab 下拉；
          本栏只保留会话状态徽章与分屏身份标题（抽屉开关在共享 Tab 栏）。 */}
      <SessionHeader
        headerRef={chatHeaderRef}
        statusSessionId={sessionId}
        title={sessionTitle}
        projectName={projectName}
        paneTitle={splitPane ? sessionTitle : undefined}
        onExitSplit={
          splitPane ? () => paneServices.exitSessionSplit(sessionId) : undefined
        }
        compactionCount={activeAgent?.compactionCount}
        isAnonymous={activeAgent?.noSession}
        duration={sessionDuration}
        isStarting={isAgentStarting}
      />
      {/* 分支导航条：仅当当前会话存在 fork 分支关系（父/兄弟/子分支）时显示 */}
      <SessionBranchBar sessionId={sessionId} onOpenSession={onOpenBranchSession} />
      <ResizablePanelGroup
        // 面板数变化（terminal / composer 卸载）时强制重建：旧 Group 的
        // layouts["timeline,composer"] 2 值缓存不能套到 1 面板（历史会话加载期
        // 曾卸底部栏 → Invalid 1 panel layout: 83.506%, 16.494%）。
        key={`${sessionId}:${sessionResizableGroupKey(sessionPanels)}`}
        orientation="vertical"
        className="session-v-group"
        groupRef={sessionGroupRef}
        // groupSize=0 的首帧若不传 defaultLayout，库 He() 会把未设 defaultSize 的面板均分，
        // 输入栏占半屏；键序必须 timeline → composer → terminal，与 DOM 一致。
        defaultLayout={sessionGroupDefaultLayout(
          sessionPanels,
          composerHeightStateRef.current,
          terminalCollapsed ? 34 : terminalRowHeight,
          Math.max(1, window.innerHeight - 120),
        )}
        // 拖拽命中区放大：输入框（composer-box）顶部边框在 v-splitter 下方约
        // 8px（footer gap-2），默认 fine 10px 覆盖不到——需在输入框框线上就能拖。
        // fine 20 → 命中区上下各 ~9.5px，覆盖输入框上沿。
        resizeTargetMinimumSize={{ fine: 20, coarse: 24 }}
      >
        <ResizablePanel id="timeline" minSize={TIMELINE_MIN_HEIGHT} className="session-v-timeline">
          <SessionSurfaceStage
            sessionId={sessionId}
            sessionTimeline={sessionTimeline}
            isRestarting={isRestarting}
            timelineProps={{
              hasProject,
              onCreateSession: runCreateSessionDraft,
              showThinking,
              validCommandNames,
              validFilePaths,
              onPreviewImage,
              onOpenExternal: (url: string, forceSystem?: boolean) => api.app.openExternal(url, forceSystem),
              onOpenFile,
              onDiffFile,
              onResendUserMessage: canMutateActiveMessages ? onResendUserMessage : undefined,
              onEditMessage: canMutateActiveMessages ? onEditMessage : undefined,
              onDeleteMessage: canMutateActiveMessages ? onDeleteMessage : undefined,
              onForkMessage: canMutateActiveMessages ? onForkMessage : undefined,
              forkingMessageId,
              onToast,
              onQuickPrompt,
              runtimeUi,
            }}
          />
        </ResizablePanel>

        {/* 有消息或仍在加载：底部 composer。空会话就绪后卸掉，改由起始页居中输入。 */}
        {bottomComposerVisible && (
          <>
            <ResizableHandle className="v-splitter" />
            <ResizablePanel
              id="composer"
              panelRef={composerPanelRef}
              minSize={COMPOSER_MIN_HEIGHT}
              maxSize={composerMaxHeight}
              defaultSize={composerHeightStateRef.current}
              // 窗口缩放时保持输入栏像素高度，避免百分比缓存把栏撑出大块底空隙。
              groupResizeBehavior="preserve-pixel-size"
              onResize={handleComposerResize}
              // 与时间线共享同一条滚动条槽位：面板 overflow-hidden + scrollbar-gutter:stable
              // 预留与真实滚动条等宽的右侧槽位（时间线视口由自身 gutter 预留），
              // 使输入框与消息列的百分比宽度/居中基准一致，任何宽度设置与平台下都对齐
              // （macOS 覆盖式滚动条时两侧槽位同为 0，依然对齐；不写死像素值）。
              className="session-v-composer overflow-hidden [scrollbar-gutter:stable]"
            >
              <ComposerArea
                ref={composerRef}
                sessionId={sessionId}
                gitInfo={gitInfo}
                height={composerHeight}
                onContentHeightChange={handleComposerContentHeight}
                onOpenFile={openFilePath}
                enqueue={enqueueSessionPrompt}
                ensureSessionId={ensureSessionId}
                queuePanel={queuePanel}
                // 输入框上方独立卡栈（dsh input dock 移植）：todo → goal，与 queue 同列同宽；
                // 高度由 ComposerMeasuredExtras 测量内容总高，面板 hug 该值
                widgets={
                  <>
                    <SessionTodoStrip sessionId={sessionId} />
                    <SessionGoalStrip sessionId={sessionId} />
                  </>
                }
              />
            </ResizablePanel>
          </>
        )}

        {terminalPanelVisible && (
          <>
            <ResizableHandle className="v-splitter" />
            <ResizablePanel
              id="terminal"
              panelRef={terminalPanelRef}
              collapsible
              collapsedSize={34}
              minSize={120}
              maxSize={Math.max(120, availableTerminalHeight)}
              defaultSize={terminalCollapsed ? 34 : terminalRowHeight}
              onResize={handleTerminalResize}
              className="session-v-terminal"
            >
              <SessionRuntimeDock
                key={terminalOwnerKey}
                target={terminalTarget}
                mounted={terminalDockVisible}
                open={terminalOpen}
                closing={terminalDockClosing}
                collapsed={terminalCollapsed}
                height={terminalRowHeight}
                terminal={api.terminal}
                onOpenChange={(open) => setTerminalOpenForOwner(open)}
                onCollapsedChange={(collapsed) => setTerminalCollapsedForOwner(collapsed)}
                onHeightChange={() => {
                  // 高度由面板 onResize 统一回写，此回调保留仅为兼容接口
                }}
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}
