import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { atom, useAtomValue, useSetAtom, useStore } from "jotai";
import { animateScrollTop, pinScrollDurationMs } from "../lib/pinTurnScroll";
import { selectAtom } from "jotai/utils";
import { desktopApi } from "../desktopApi";
import type { AgentRuntimeState, ChatMessage, SessionRecord } from "../../../shared/types";
import {
	cacheSessionMessagesAtom,
	clearSessionHistoryAtom,
	prependSessionHistoryPageAtom,
	prependSessionMessagePageAtom,
  sessionMessageLoadStateAtom,
  sessionMessagesCacheAtom,
  sessionMessageCacheBySessionIdAtomFamily,
  sessionRecordByIdAtomFamily,
  saveSessionScrollAnchorAtom,
  sessionScrollAnchorByIdAtom,
  setSessionMessageLoadStateAtom,
  touchSessionMessagesAtom,
	type SessionScrollAnchor,
} from "../atoms";
import type { MessageScrollerScrollApi } from "../components/agents/message-scroller";
import {
  TURN_WINDOW_AUTO_EXPAND_THRESHOLD,
  resolveAutoExpandThreshold,
} from "./timeline/autoExpandThreshold";
import {
  countUserTurns,
  TIMELINE_SCROLLED_TURN_LIMIT,
  TIMELINE_WINDOW_EXPAND_STEP,
} from "../components/session/timeline/turnRenderWindow";

/** 滚动接近顶部自动加载历史的阈值（px，2026-11 轮次模型）：
 *  贴顶（≤8px）才触发翻页——「滑到底才翻」，避免在顶部附近任何滚动都连翻历史页。
 *  同时用作「顶部不补偿」阈值：视口顶部 prepend/展开新内容时保持原位可见，
 *  补偿会把新内容推出视口（点击「加载更多/显示更早」无反馈根因，2026-02 修复）。 */
export const HISTORY_AUTO_LOAD_THRESHOLD = 8;
/** 翻页冷却（ms）：加载完成后立即再滚到顶不连翻，需停顿后重新触发（防惯性滚动连翻多页）。 */
const HISTORY_AUTO_LOAD_COOLDOWN_MS = 300;
/** 自动扩窗口冷却（ms）：防惯性滚动接近顶部时连扩多轮（与翻页冷却同量级）。 */
const TURN_WINDOW_AUTO_EXPAND_COOLDOWN_MS = 300;
/** 分批扩展：每帧最多挂载的轮数。
 *  一个 3 轮 cohort 拆成 2+1 两帧，避免本地 DOM 扩展在同一帧集中渲染。 */
const TURN_WINDOW_EXPAND_BATCH_TURNS = 2;

let nextLoadSequence = 0;
/** 新建空会话的跨挂载粘性：切 Tab 时 ChatSessionPane/hook 会销毁重建，useRef 粘性会丢失导致切回闪骨架。
 *  模块级 Set 跨实例保持：某会话一旦被判定为空，则在出现第一条消息前始终视为空，即使预热写入 filePath/dshSessionId 也不翻回。 */
const stickyEmptySessionIds = new Set<string>();
// stickyEmptyRef 已迁移为 stickyEmptySessionIds（全局跨挂载，兼容旧测试断言）
/** 会话加载请求序号（防迟到响应串台）。键按 sessionId 累积，LRU 裁剪防无界增长（2026-10）。 */
const latestLoadBySession = new Map<string, number>();
const LATEST_LOAD_LRU_LIMIT = 20;
function trackLatestLoad(sessionId: string, sequence: number) {
	latestLoadBySession.set(sessionId, sequence);
	if (latestLoadBySession.size <= LATEST_LOAD_LRU_LIMIT) return;
	// 超限：删最早 set 的键（Map 迭代序 = 插入序）
	const oldest = latestLoadBySession.keys().next().value;
	if (oldest !== undefined) latestLoadBySession.delete(oldest);
}
/** sessionId 为空时的占位 atom：恒 undefined（无会话不订缓存条目）。 */
const NO_CACHE_ENTRY_ATOM = atom(undefined);

// 用户主动向上滚超过此阈值后停止自动跟底。值设很小是为了让用户稍微滚一点就能挣脱自动滚动，
// 避免流式消息频繁触发 ResizeObserver/MutationObserver 把用户弹回底部造成"颤抖"。
const BOTTOM_THRESHOLD = 16;
const LEGACY_OWNER_KEY = "legacy";
/** runtime 窗口会话「加载更多对话」的单页轮数（与主进程 DEFAULT_TURN_PAGE_SIZE 对齐） */
const RUNTIME_HISTORY_TURN_PAGE_SIZE = 3;
/** 最新轮自动收起后，把本轮起始消息放在视口约 30% 高度处（中上方，不贴顶不贴底）。 */
const SETTLED_TURN_VIEWPORT_ANCHOR_RATIO = 0.3;

/** 翻页成功后仅开放实际带回的 cohort，防止消息页大小与 DOM 窗口脱节。
 *  disk 消息页不一定以 user 消息开头（可能在长回答中间切断）；只要页非空就至少开放 1 轮，
 *  否则新增 agent-run 会被尾部窗口裁掉，出现「数据已加载但看不见」的无反馈。 */
function resolvePageWindowGrowth(messages: readonly ChatMessage[]): number {
  if (messages.length === 0) return 0;
  const turns = countUserTurns(messages);
  return Math.min(TIMELINE_WINDOW_EXPAND_STEP, Math.max(1, turns));
}

type Tagged<T> = { ownerKey: string; value: T };
type TimelineAnchor = {
  height: number;
  top: number;
  /** 保持旧视口：即使原视口在顶部也只让新历史出现在上方。 */
  preserveAtTop?: boolean;
};

export function isTimelineAtBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): boolean {
  return scrollHeight - scrollTop - clientHeight < BOTTOM_THRESHOLD;
}

export function restoreTimelineAnchor(previousTop: number, heightDelta: number): number {
  return previousTop + heightDelta;
}

/** 顶部补偿决策（数据 prepend / turn 窗口扩大共用，2026-02 修复）：
 *  视口在顶部（≤阈值）时不补偿，保持原位让新加载/展开的内容直接出现在视口顶部——
 *  容器 overflow-anchor:none，插入内容不会自动调整滚动位置，补偿反而把新内容推出视口，
 *  表现为「点击加载更多/显示更早无反馈」。视口中部时按高度差补偿以保持视口内容不动。
 *  返回补偿后的 scrollTop；null = 不补偿（保持原位）。 */
export function resolveTimelineTopCompensation(
  previousTop: number,
  heightDelta: number,
  threshold = HISTORY_AUTO_LOAD_THRESHOLD,
): number | null {
  if (previousTop <= threshold) return null;
  return restoreTimelineAnchor(previousTop, heightDelta);
}

export function matchesTimelineOwner(
  taggedOwnerKey: string,
  currentOwnerKey: string,
): boolean {
  return taggedOwnerKey === currentOwnerKey;
}

export function isSessionRuntimeBusy(
  status: string | undefined,
  state: AgentRuntimeState | undefined,
): boolean {
  // idle/error/closed 是停止的权威边沿；旧 runtime-state 可能稍后到达，
  // 不能让滞后的 isStreaming/isExecutingTool 把页面继续显示为运行中。
  if (status === "idle" || status === "error" || status === "closed" || status === "detached") return false;
  return Boolean(status === "running" || state?.isStreaming || state?.isExecutingTool);
}

/** 用户主动发送才算「正在启动」。输入预热也会把 runtime 打成 starting，但不能锁输入框。 */
export function isUserFacingSessionStart(sendStatus: string | undefined): boolean {
  return sendStatus === "activating";
}

/** catalog 已确认无磁盘历史：空草稿、从未落文件的 pi 会话、尚无 host id 的新 DSH。
 * 预热会写 filePath / dshSessionId，但草稿在真正开聊前仍算空——见控制器 sticky。 */
export function isKnownEmptySessionRecord(
  record: Pick<SessionRecord, "status" | "filePath" | "messageCount" | "backend" | "dshSessionId"> | undefined,
): boolean {
  if (!record) return false;
  if (record.status === "draft") return true;
  if ((record.messageCount ?? 0) > 0) return false;
  if (record.filePath) return false;
  if (record.backend === "dsh" && record.dshSessionId) return false;
  return true;
}

export function deriveSessionSurfaceRuntime(
  messageCount: number,
  messageLoadStatus: string | undefined,
  sendStatus: string | undefined,
  runtimeStatus: string | undefined,
  runtimeState: AgentRuntimeState | undefined,
  hasCachedEntry?: boolean,
  /**
   * catalog 已确认是空草稿（draft / 无会话文件且 messageCount=0）。
   * 不能把 undefined/loading 钉成骨架：否则新建会话先挂底部输入栏再卸掉改居中起始页
   * （输入框上跳），切回空会话还闪「正在加载历史」。有 filePath 的历史仍走下方规则。
   */
  knownEmpty?: boolean,
) {
  const activating = isUserFacingSessionStart(sendStatus);
  const status = activating ? "starting" : runtimeStatus;
  return {
    status,
    isLoading: !knownEmpty && messageCount === 0 && (
      messageLoadStatus === "loading" ||
      // 挂载首帧 loadState 尚未写入（passive effect 在 paint 后才置 loading），
      // undefined 一律视为加载中——否则有历史的会话会被误判为「空会话」，
      // 闪出 SessionStartSurface 起始页（打开/切回大会话闪屏根因）。
      messageLoadStatus === undefined ||
      // ready 但缓存条目不存在（从未写入或被 LRU 淘汰）＝ disk 读取结果尚未到达
      // （cacheMessages 对 disk 读取无论空/非空都会创建条目）：必须钉在骨架屏。
      // 缓存条目已存在（即使 messages 为空）说明 disk 已返回——空会话显示起始页
      // 是合法终态，不会进入加载死循环。读取失败（error）不在此列。
      // 预热/发送 activating 不能再钉骨架：空会话应留在起始页，避免「输入一半整页闪骨架」。
      (messageLoadStatus === "ready" && !hasCachedEntry)
    ),
    isStarting: activating,
    isBusy: activating || sendStatus === "sending" || isSessionRuntimeBusy(status, runtimeState),
  };
}

export function canLoadSessionTimelineMore(isStarting: boolean, messageCount: number): boolean {
  // 只在初始加载（无消息）时隐藏按钮；runtime 创建期间已有消息则不隐藏
  return !(isStarting && messageCount === 0);
}

export function isLatestTimelineRunBusy(
  isAgentBusy: boolean,
  index: number,
  runCount: number,
): boolean {
  return isAgentBusy && index === runCount - 1;
}

export type SessionTimelineController = {
  timelineRef: RefObject<HTMLElement | null>;
  messages: ChatMessage[];
	visibleMessages: ChatMessage[];
	totalMessageCount: number;
	hasMoreMessages: boolean;
  /** 下一次「加载更多」触发 disk 轮次分页（渲染窗口已耗尽且窗口前还有历史） */
  nextLoadIsHistory: boolean;
  isLoadingMoreMessages: boolean;
  /** 补页后保持当前视口（新历史只出现在上方）。所有入口统一，不再有「新页直接出现」的跳动。 */
  loadMoreMessages: (source?: "scroll" | "button") => void;
  /** 标记一次程序化滚动（turn 窗口展开补偿等组件内补偿用），抑制自动加载监听。
   *  durationMs > 0 时按时间窗口抑制（连续 smooth scroll 会派发多个 scroll 事件）。 */
  markProgrammaticScroll: (durationMs?: number) => void;
  jumpToMessage: (messageId: string) => void;
  scrollToBottom: () => void;
  /** 最新轮自动收起后，把该轮最终回答开头平滑放到视口中上方；仅仍在跟随时生效。 */
  scrollFinalAnswerToUpperMiddle: (runId: string) => void;
  /** 滚动回调（MessageScroller viewport 接线）：维护会话切换的滚动锚点。 */
  handleTimelineScroll: () => void;
  autoScroll: boolean;
  showScrollToBottom: boolean;
  /** 由 MessageScroller 汇报用户是否仍在实时尾部，避免两套滚动监听互相抢占。 */
  setAutoScrollFromScroller: (following: boolean) => void;
  /**
   * 挂到 MessageScroller 的 stick-to-bottom 引擎 API（回底弹簧）。
   * 未挂上时 scrollToBottom 退化为原生 scrollTo。
   */
  scrollerScrollApiRef: RefObject<MessageScrollerScrollApi | null>;
  /** 上滚查看历史时的渲染窗口轮数（贴底时渲染层用 TIMELINE_MOUNTED_TURN_LIMIT，忽略此值）。
   *  2026-08 黑屏治理：历史不再全量放开挂载，窗口随「显示更早」逐步扩大。 */
  scrolledWindowTurns: number;
  /** 扩大上滚渲染窗口（每次最多 +3 轮）；数据翻页与本地 DOM 扩展使用同一 cohort。 */
  expandWindow: () => void;
  /**
   * 上滚渲染窗口是否仍可扩展（由渲染层同步 turnWindowActive：已加载数据未被全部挂载）。
   * 滚动监听读它决定「先扩窗口」还是「翻数据页」（方案 C 渐进扩展，2026-12）。
   */
  windowExpandableRef: RefObject<boolean>;
  /**
   * 磁盘消息尚未就绪（含挂载首帧 loadStatus 未写入）。
   * SessionView 用它在历史会话加载期仍挂底部 composer，避免 1 面板 Group 吃到 2 值布局缓存。
   */
  isSurfaceLoading: boolean;
  /** 本栏粘住的空会话：预热写 filePath/dshSessionId 后仍不闪历史骨架。 */
  knownEmpty: boolean;
  /**
   * 强制从磁盘重载本会话时间线（编辑/删除/重发改 JSONL 后）。
   * 绕过「已加载 + 有缓存就跳过」和 runtime 缓存守卫。
   */
  reloadFromDisk: () => Promise<void>;
};

export function useSessionTimelineController(options: {
  sessionId?: string;
  messages?: ChatMessage[];
  initialPageSize?: number;
  pageSize?: number;
}): SessionTimelineController {
  const ownerKey = options.sessionId ?? LEGACY_OWNER_KEY;
  const timelineRef = useRef<HTMLElement | null>(null);
  const ownerKeyRef = useRef(ownerKey);
  ownerKeyRef.current = ownerKey;
  // 切换恢复时读滚动锚点快照用（不订阅：恢复后滚动写 atom 不打扰已恢复的视口）
  const store = useStore();
  const cacheSliceAtom = useMemo(
    () => selectAtom(
      sessionMessagesCacheAtom,
      (cache) => options.sessionId ? cache[options.sessionId]?.messages : undefined,
      Object.is,
    ),
    [options.sessionId],
  );
  const cachedMessages = useAtomValue(cacheSliceAtom);
  const messages = options.messages ?? cachedMessages ?? [];
  const controllerEnabled = options.sessionId !== undefined && options.messages === undefined;

  // ── 会话切换滚动位置保持（状态即真相）──
  // 滚动节流直接写 per-session atom（内容不变跳过 → 引用稳定 → 零订阅重渲染）；
  // 恢复 = 切换时从 atom 读一次快照执行，不订阅（后续滚动写 atom 不打扰已恢复的视口）。
  const saveScrollAnchor = useSetAtom(saveSessionScrollAnchorAtom);
  // 最后已知锚点缓存：供 cleanup 兜底落盘（250ms 节流窗口内切走不丢）。
  // 不能用 cleanup 读 DOM——会话切换复用同一组件实例（无 key），cleanup 执行时
  // timeline 的 children 可能已替换为新会话消息，读 DOM 会串数据。
  const currentAnchorRef = useRef<SessionScrollAnchor | null>(null);
  const scrollAnchorFrameRef = useRef<number | undefined>(undefined);
  const scrollSaveTimerRef = useRef<number | undefined>(undefined);

  /**
   * 计算当前视口锚点（纯读取，不落盘）。
   * 规则：在底部跟流 → null（切回继续跟底）；查看历史 → 记录
   * 「视口顶部的第一条消息行 + 距视口顶偏移 + 分页窗口」。
   * 锚点行用 data-message-id（run 或消息行都带），恢复时无需关心具体类型。
   */
  const computeCurrentAnchor = useCallback((): SessionScrollAnchor | null => {
    const timeline = timelineRef.current;
    if (!timeline) return null;
    if (isTimelineAtBottom(timeline.scrollTop, timeline.scrollHeight, timeline.clientHeight)) {
      return null;
    }
    const viewportRect = timeline.getBoundingClientRect();
    const rows = timeline.querySelectorAll<HTMLElement>("[data-message-id]");
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom >= viewportRect.top + 1) {
        const messageId = row.dataset.messageId ?? "";
        if (!messageId) continue;
        return {
          messageId,
          // 保留负偏移：视口顶部常被上一行底部占据（行顶在视口上方），
          // 截断为 0 会导致恢复时把行顶对齐视口顶、整体位置偏下（高大行偏差明显）。
          // 恢复侧 scrollTop = max(0, elTop - offsetTop) 已兜底负值。
          offsetTop: rect.top - viewportRect.top,
          // 2026-11 轮次模型：不再有 100 条分页窗口，visibleCount 恒为 0（兼容字段）
          visibleCount: 0,
          savedAt: Date.now(),
        };
      }
    }
    // 无任何消息行（空会话/加载中）
    return null;
  }, []);

  /** 把当前锚点写入 atom（节流）。内容未变化由 atom 侧跳过，引用保持稳定。 */
  const persistCurrentAnchor = useCallback((sessionId: string) => {
    scrollSaveTimerRef.current = undefined;
    saveScrollAnchor({ sessionId, anchor: currentAnchorRef.current });
  }, [saveScrollAnchor]);

  /** 透传给 MessageScroller viewport 的滚动回调（SessionMessageTimeline 接线）。
   *  rAF 合并高频滚动计算锚点（不每帧 getBoundingClientRect），再节流 250ms 落盘 atom。 */
  const handleTimelineScroll = useCallback(() => {
    const sessionId = ownerKeyRef.current;
    if (!sessionId || sessionId === LEGACY_OWNER_KEY) return;
    if (scrollAnchorFrameRef.current != null) return;
    scrollAnchorFrameRef.current = requestAnimationFrame(() => {
      scrollAnchorFrameRef.current = undefined;
      // 回调执行时若已切走（ownerKeyRef 已更新），丢弃——旧会话状态由 cleanup 落盘。
      if (ownerKeyRef.current !== sessionId) return;
      currentAnchorRef.current = computeCurrentAnchor();
      // 节流写 atom：只排一个 timer，期间连续滚动不重复写；
      // 内容未变时 atom 侧跳过（引用稳定，订阅者零重渲染）。
      if (scrollSaveTimerRef.current != null) return;
      scrollSaveTimerRef.current = window.setTimeout(() => {
        persistCurrentAnchor(sessionId);
      }, 250);
    });
  }, [computeCurrentAnchor, persistCurrentAnchor]);

  // ── Load messages from disk when sessionId changes ──
	// 只订本会话缓存条目（family selectAtom 隔离）：其它会话的消息到达/分页不拖着重渲染本栏。
	const cachedEntry = useAtomValue(
		options.sessionId
			? sessionMessageCacheBySessionIdAtomFamily(options.sessionId)
			: NO_CACHE_ENTRY_ATOM,
	);
	const cacheMessages = useSetAtom(cacheSessionMessagesAtom);
	const prependMessagePage = useSetAtom(prependSessionMessagePageAtom);
	const prependHistoryPage = useSetAtom(prependSessionHistoryPageAtom);
  const setLoadState = useSetAtom(setSessionMessageLoadStateAtom);
  const touchMessages = useSetAtom(touchSessionMessagesAtom);
  const loadStates = useAtomValue(sessionMessageLoadStateAtom);
  const lastLoadedSessionRef = useRef<string | undefined>(undefined);
  const sessionRecord = useAtomValue(
    sessionRecordByIdAtomFamily(options.sessionId ?? ""),
  );
  const knownEmptyFromRecord = isKnownEmptySessionRecord(sessionRecord);
  // 空会话粘性（跨挂载）：新建会话输入一半切走再切回时，hook 实例已销毁重建，
  // 旧的 useRef 粘性会丢失。若此时预热已写入 filePath/dshSessionId，knownEmptyFromRecord
  // 仍为 true（draft 始终 true），但对非 draft 的匿名/活跃空会话也需保持起始页，
  // 避免切回时变骨架、输入框从居中跳到底部（用户反馈）。
  const stickySessionId = options.sessionId;
  if (stickySessionId) {
    if (messages.length > 0) {
      stickyEmptySessionIds.delete(stickySessionId);
    } else if (knownEmptyFromRecord) {
      stickyEmptySessionIds.add(stickySessionId);
    }
  }
  const knownEmpty = Boolean(
    stickySessionId && (knownEmptyFromRecord || stickyEmptySessionIds.has(stickySessionId)),
  );
  // 与 SessionMessageTimeline 同一套 deriveSessionSurfaceRuntime：历史会话首帧
  // messages 仍为空时视为加载中，底部 composer 不能卸掉。空草稿除外——
  // 新建/切回空会话必须留在起始页，不能先挂底部栏再卸（输入框上跳）。
  const isSurfaceLoading = deriveSessionSurfaceRuntime(
    messages.length,
    options.sessionId ? loadStates[options.sessionId]?.status : undefined,
    undefined,
    undefined,
    undefined,
    Boolean(cachedEntry),
    knownEmpty,
  ).isLoading;

	// useLayoutEffect 而非 useEffect：loading 状态必须在首帧 paint 之前写入，
	// 否则被动 effect 先于 loading 绘制一帧「空会话」→ 有历史的会话会闪出起始页。
	useLayoutEffect(() => {
    const sessionId = options.sessionId;
    if (!sessionId) return;
    const previouslyLoaded = lastLoadedSessionRef.current === sessionId;
    // 已加载且缓存条目仍在 → 跳过（正常运行路径）。
    // 缓存条目被 8-LRU 淘汰（条目变 undefined）时重新走磁盘加载自愈——
    // 否则已挂载会话永久卡骨架屏（2026-12 回归修复）。
    if (previouslyLoaded && cachedEntry) return;
    if (!previouslyLoaded) lastLoadedSessionRef.current = sessionId;
    // 切会话复用同一 hook 实例（solo 栏无 sessionId key）：已有缓存时不要把
    // loadState 打成 loading。空会话 messages=0 + loading 会闪骨架「正在加载历史」。
    if (cachedEntry || knownEmpty) return;

    const sequence = ++nextLoadSequence;
    trackLatestLoad(sessionId, sequence);
    setLoadState({ sessionId, state: { status: "loading" } });

		void desktopApi.sessions
			.readRecordMessagePage(sessionId, undefined, options.initialPageSize ?? 100)
			.then((page: { messages: ChatMessage[]; total: number; nextBefore: number | null }) => {
				if (latestLoadBySession.get(sessionId) !== sequence) return;
				cacheMessages({
					sessionId,
					messages: page.messages,
					source: "disk",
					expectedRevision: 0,
					page: { total: page.total, nextBefore: page.nextBefore },
				});
        setLoadState({ sessionId, state: { status: "ready" } });
      })
      .catch((error: unknown) => {
        if (latestLoadBySession.get(sessionId) !== sequence) return;
        setLoadState({
          sessionId,
          state: {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
        });
      });
  }, [options.sessionId, cachedEntry, knownEmpty]);

  const reloadFromDisk = useCallback(async () => {
    const sessionId = options.sessionId;
    if (!sessionId) return;
    const sequence = ++nextLoadSequence;
    trackLatestLoad(sessionId, sequence);
    setLoadState({ sessionId, state: { status: "loading" } });
    try {
      const page = await desktopApi.sessions.readRecordMessagePage(
        sessionId,
        undefined,
        options.initialPageSize ?? 100,
      );
      if (latestLoadBySession.get(sessionId) !== sequence) return;
      cacheMessages({
        sessionId,
        messages: page.messages,
        source: "disk",
        expectedRevision: 0,
        page: { total: page.total, nextBefore: page.nextBefore },
        force: true,
      });
      setLoadState({ sessionId, state: { status: "ready" } });
    } catch (error: unknown) {
      if (latestLoadBySession.get(sessionId) !== sequence) return;
      setLoadState({
        sessionId,
        state: {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }, [cacheMessages, options.initialPageSize, options.sessionId, setLoadState]);

	const diskPage = controllerEnabled && cachedEntry?.source === "disk"
		? cachedEntry.page
		: undefined;
	// ── 激活显示窗口（2026-08 激活分页）──
	// runtime 窗口会话：显示数组 = disk 历史前缀（轮次页 prepend）+ 运行时窗口段。
	// 前缀与窗口段是两个下标空间，仅在渲染层按顺序拼接，合并/去重由 atoms 保证。
	const runtimeHistory = controllerEnabled && cachedEntry?.source === "runtime"
		? cachedEntry.history
		: undefined;
	const combinedMessages = useMemo(
		() => (runtimeHistory ? [...runtimeHistory.messages, ...messages] : messages),
		[runtimeHistory, messages],
	);
	// 窗口前还有历史可加载：已加载前缀看游标（数值或 entryId），未加载看窗口起点（>0 说明激活时被截断）。
	// slideOut 单独重建前缀时 nextBefore 可能为 null，但 nextBeforeEntryId 仍指向更早锚点，
	// 不能把这种前缀误判为「已经到最早」。
	const historyHasMore = controllerEnabled && cachedEntry?.source === "runtime"
		? (runtimeHistory
			? runtimeHistory.nextBefore !== null || Boolean(runtimeHistory.nextBeforeEntryId)
			: (cachedEntry.windowStart ?? 0) > 0)
		: false;
	// 2026-11 轮次模型：不再按 100 条分页器切片，显示数组 = 已加载全部（历史前缀 + 运行时窗口段）。
	// 内存预算由主进程 12 轮缓存 + 回底临时历史清理承担，渲染层不再有第二道条数窗口。
	const visibleMessages = combinedMessages;
	const [isLoadingMessagePage, setIsLoadingMessagePage] = useState(false);
  const [autoScroll, setAutoScroll] = useState(() => {
    // 会话切换滚动位置保持：切回有锚点的会话时，初始就不跟底（不在底部）。
    // 若初始 true，MessageScroller 的 followOutput layout effect 会在恢复前滚底，
    // 造成「先滚到底再纠正」的闪跳（引擎在途动画由 restoreAt 取消，但初始值仍应正确）。
    const sessionId = options.sessionId;
    if (!sessionId) return true;
    return !store.get(sessionScrollAnchorByIdAtom)[sessionId];
  });
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  // 与 autoScroll 初始值保持一致（有锚点的会话首帧即不跟底），避免首帧 ref/state 不一致
  const autoScrollRef = useRef(autoScroll);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollUntilRef = useRef(0);
  const settleScrollCancelRef = useRef<(() => void) | undefined>(undefined);
  const scrollerScrollApiRef = useRef<MessageScrollerScrollApi | null>(null);
  const loadMoreAnchorRef = useRef<Tagged<TimelineAnchor> | undefined>(undefined);
  const pendingJumpRef = useRef<Tagged<string> | undefined>(undefined);
  const highlightTimersRef = useRef(new Map<number, number>());
  // ── 上滚渲染窗口（2026-08 黑屏治理）──
  // 贴底和上滚初始都只挂 3 轮；每次接近顶部最多扩一个 3 轮 cohort，
  // 先消费 atom 已有的尾部 9 轮，再进入主进程缓存/文件分页。回底开始新的浏览周期。
  const [scrolledWindowTurns, setScrolledWindowTurns] = useState(TIMELINE_SCROLLED_TURN_LIMIT);
  /** 窗口是否仍可扩展（由 SessionMessageTimeline 按 turnWindowActive 同步，渲染期写入）。 */
  const windowExpandableRef = useRef(false);
  /** 自动扩窗口冷却时间戳（防惯性滚动接近顶部时连扩多轮）。 */
  const lastWindowExpandAtRef = useRef(0);
  /** 分批扩展（2026-12 层次 1）：滚动触发的扩展拆成多帧小批挂载，避免 3 轮 cohort 同步渲染掉帧。
   *  pendingTurns = 待消费的扩展轮数；rAF 每帧消费一小批直到归零；
   *  新请求到来时累加（不丢、不重复计数）。仅滚动监听使用——
   *  按钮点击 / 跳转定位（pendingJump）仍走原子 expandWindow（低频操作，需立即挂载目标）。 */
  const pendingExpandTurnsRef = useRef(0);
  const expandBatchFrameRef = useRef<number | undefined>(undefined);
  const consumeExpandBatch = useCallback(() => {
    expandBatchFrameRef.current = undefined;
    if (pendingExpandTurnsRef.current <= 0) return;
    const batch = Math.min(TURN_WINDOW_EXPAND_BATCH_TURNS, pendingExpandTurnsRef.current);
    pendingExpandTurnsRef.current -= batch;
    setScrolledWindowTurns((prev) => prev + batch);
    if (pendingExpandTurnsRef.current > 0) {
      // 还有剩余：下一帧继续消费，摊平布局/渲染压力
      expandBatchFrameRef.current = window.requestAnimationFrame(consumeExpandBatch);
    }
  }, []);
  const escapeAutoScroll = useCallback(() => {
    if (!autoScrollRef.current) return;
    autoScrollRef.current = false;
    setAutoScroll(false);
    setShowScrollToBottom(true);
  }, []);
  const expandWindowBatched = useCallback((turns = TIMELINE_WINDOW_EXPAND_STEP) => {
    escapeAutoScroll();
    if (turns <= 0) return;
    pendingExpandTurnsRef.current += turns;
    if (expandBatchFrameRef.current === undefined) {
      expandBatchFrameRef.current = window.requestAnimationFrame(consumeExpandBatch);
    }
  }, [consumeExpandBatch, escapeAutoScroll]);
  // 单栏无 key 复用：切会话时重置上滚窗口，避免把上一会话扩开的轮数带到新会话。
  useEffect(() => {
    setScrolledWindowTurns(TIMELINE_SCROLLED_TURN_LIMIT);
    setIsLoadingMessagePage(false);
    pendingExpandTurnsRef.current = 0;
    lastWindowExpandAtRef.current = 0;
    if (expandBatchFrameRef.current !== undefined) {
      window.cancelAnimationFrame(expandBatchFrameRef.current);
      expandBatchFrameRef.current = undefined;
    }
  }, [ownerKey]);
  const expandWindow = useCallback(() => {
    // 跟底状态（内容短于视口、按钮可见）下点击「显示更早」：先解锁跟随，
    // 否则 turnWindowTurns 恒取贴底窗口 3 轮，扩大 scrolledWindowTurns 不生效，
    // 按钮点击表现为无反应（2026-02 修复）。
    if (autoScrollRef.current) {
      autoScrollRef.current = false;
      setAutoScroll(false);
      setShowScrollToBottom(true);
    }
    setScrolledWindowTurns((prev) => prev + TIMELINE_WINDOW_EXPAND_STEP);
  }, []);
  // 回底/卸载时取消未消费的分批扩展（窗口重置回基础大小，pending 作废）
  useEffect(() => {
    if (autoScroll) {
      pendingExpandTurnsRef.current = 0;
      if (expandBatchFrameRef.current !== undefined) {
        window.cancelAnimationFrame(expandBatchFrameRef.current);
        expandBatchFrameRef.current = undefined;
      }
      // 回底 = 新的浏览周期：冷却清零，避免「刚到底又立刻上滚」被上一次扩窗冷却吞掉。
      lastWindowExpandAtRef.current = 0;
      setScrolledWindowTurns(TIMELINE_SCROLLED_TURN_LIMIT);
    }
  }, [autoScroll]);
  useEffect(() => () => {
    if (expandBatchFrameRef.current !== undefined) {
      window.cancelAnimationFrame(expandBatchFrameRef.current);
    }
  }, []);

  const clearHighlightTimers = useCallback(() => {
    for (const timer of highlightTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    highlightTimersRef.current.clear();
  }, []);

  const highlightMessage = useCallback((element: HTMLElement, expectedOwnerKey: string) => {
    if (ownerKeyRef.current !== expectedOwnerKey) return;
    element.classList.remove("message-jump-highlight");
    void element.offsetWidth;
    element.classList.add("message-jump-highlight");
    const timer = window.setTimeout(() => {
      highlightTimersRef.current.delete(timer);
      if (ownerKeyRef.current === expectedOwnerKey) {
        element.classList.remove("message-jump-highlight");
      }
    }, 2000);
    highlightTimersRef.current.set(timer, timer);
  }, []);

  const scrollToBottom = useCallback(() => {
    const requestOwnerKey = ownerKey;
    if (ownerKeyRef.current !== requestOwnerKey) return;
    programmaticScrollRef.current = true;
    window.requestAnimationFrame(() => {
      if (programmaticScrollUntilRef.current === 0) {
        programmaticScrollRef.current = false;
      }
    });
    autoScrollRef.current = true;
    setAutoScroll(true);
    setShowScrollToBottom(false);
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const animation = reduceMotion ? "instant" : "smooth";
    const api = scrollerScrollApiRef.current;
    if (api) {
      // 走 stick-to-bottom 弹簧（mergeAnimations 修好后 "smooth" = 默认弹簧）
      void api.scrollToBottom({ animation });
      return;
    }
    // 引擎尚未挂上时的兜底（会话切换首帧等）
    const timeline = timelineRef.current;
    if (!timeline) return;
    timeline.scrollTo({
      top: timeline.scrollHeight,
      behavior: reduceMotion ? "instant" : "smooth",
    });
  }, [ownerKey]);

  /** 标记一次程序化滚动（turn 窗口展开补偿等组件内补偿用），抑制自动加载监听。
   *  durationMs > 0 时按时间窗口抑制：连续 smooth scroll 会派发多个 scroll 事件，
   *  单次 boolean 会在第一个事件就被消费掉，后续事件可能误触发历史加载。 */
  const markProgrammaticScroll = useCallback((durationMs = 0) => {
    programmaticScrollRef.current = true;
    programmaticScrollUntilRef.current =
      durationMs > 0 ? performance.now() + durationMs : 0;
    if (durationMs === 0) {
      // 单次抑制若没有产生 scroll 事件（赋值后位移为 0），rAF 兜底清除，
      // 避免吞掉用户下一次真实滚动。
      window.requestAnimationFrame(() => {
        if (programmaticScrollUntilRef.current === 0) {
          programmaticScrollRef.current = false;
        }
      });
    }
  }, []);

  /**
   * 最新轮结束 1.5s 且用户无操作、执行过程自动收起后，把该轮最终回答开头放到视口中上方。
   * - 仅用户仍在跟随时执行；已上滚阅读历史不拽回；
   * - 先解锁 stick-to-bottom 再滚动，避免引擎把视口钉回底部；
   * - 用户 wheel/pointerdown/touch/keydown 会取消在途动画（不抢用户操作）；
   * - 回底按钮仍走 MessageScroller 弹簧，这里只负责这次「安静收起」定位。
   */
  const scrollFinalAnswerToUpperMiddle = useCallback((runId: string) => {
    const requestOwnerKey = ownerKey;
    if (ownerKeyRef.current !== requestOwnerKey) return;
    if (!autoScrollRef.current) return;
    const timeline = timelineRef.current;
    if (!timeline) return;
    // 优先对准最终回答容器（data-final-answer=runId）；异常数据没有最终回答时
    // 回退到 run 行本身，至少不把视口拽到旧轮次。
    const element =
      timeline.querySelector<HTMLElement>(`[data-final-answer="${CSS.escape(runId)}"]`) ??
      timeline.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(runId)}"]`);
    if (!element) return;

    settleScrollCancelRef.current?.();
    scrollerScrollApiRef.current?.stopScroll();
    autoScrollRef.current = false;
    setAutoScroll(false);
    setShowScrollToBottom(true);

    const timelineRect = timeline.getBoundingClientRect();
    const rowTop =
      element.getBoundingClientRect().top -
      timelineRect.top +
      timeline.scrollTop;
    const viewportAnchor = Math.round(
      timeline.clientHeight * SETTLED_TURN_VIEWPORT_ANCHOR_RATIO,
    );
    const targetTop = Math.max(0, rowTop - viewportAnchor);
    const reduceMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const duration = pinScrollDurationMs(targetTop - timeline.scrollTop);

    let cancelled = false;
    let cancelAnimation: () => void = () => undefined;
    const interrupt = () => {
      if (cancelled) return;
      cancelled = true;
      programmaticScrollUntilRef.current = 0;
      programmaticScrollRef.current = false;
      cancelAnimation();
      cleanupListeners();
      settleScrollCancelRef.current = undefined;
    };
    const cleanupListeners = () => {
      window.removeEventListener("wheel", interrupt, true);
      window.removeEventListener("touchstart", interrupt, true);
      window.removeEventListener("pointerdown", interrupt, true);
      window.removeEventListener("keydown", interrupt, true);
    };
    window.addEventListener("wheel", interrupt, { passive: true, capture: true });
    window.addEventListener("touchstart", interrupt, { passive: true, capture: true });
    window.addEventListener("pointerdown", interrupt, { capture: true });
    window.addEventListener("keydown", interrupt, { capture: true });

    let completed = false;
    markProgrammaticScroll(duration + 120);
    cancelAnimation = animateScrollTop(timeline, targetTop, {
      reduceMotion,
      isCancelled: () => cancelled,
      onComplete: () => {
        completed = true;
        cleanupListeners();
        programmaticScrollUntilRef.current = 0;
        programmaticScrollRef.current = false;
        settleScrollCancelRef.current = undefined;
      },
    });
    if (!completed) settleScrollCancelRef.current = () => interrupt();
  }, [markProgrammaticScroll, ownerKey]);

  const setAutoScrollFromScroller = useCallback((following: boolean) => {
    autoScrollRef.current = following;
    setAutoScroll(following);
    setShowScrollToBottom(!following);
  }, []);

  /** 计算垫片高度：让「用户消息顶 + 视口高 == 内容总高」，滚到底时用户消息正好钉在顶部。 */

	const loadMoreMessages = useCallback((source: "scroll" | "button" = "scroll") => {
		const requestOwnerKey = ownerKey;
		const timeline = timelineRef.current;
    if (timeline && ownerKeyRef.current === requestOwnerKey) {
      loadMoreAnchorRef.current = {
        ownerKey: requestOwnerKey,
        value: {
          height: timeline.scrollHeight,
          top: timeline.scrollTop,
          ...(source === "scroll" ? { preserveAtTop: true } : {}),
        },
      };
    }
		if (diskPage) {
			const sessionId = options.sessionId;
			const before = diskPage.nextBefore;
			if (!sessionId || before === null || isLoadingMessagePage) return;
			const sequence = ++nextLoadSequence;
			trackLatestLoad(sessionId, sequence);
			const expectedRevision = cachedEntry?.revision ?? 0;
			setIsLoadingMessagePage(true);
			void desktopApi.sessions
				.readRecordMessagePage(sessionId, before, options.pageSize ?? 100)
				.then((page: { messages: ChatMessage[]; total: number; nextBefore: number | null }) => {
					if (latestLoadBySession.get(sessionId) !== sequence) return;
					if (prependMessagePage({ sessionId, before, expectedRevision, page })) {
						// 历史消息页最多只开放一个 3 轮 cohort；数据页可能按消息数返回很多轮，
						// 不能再固定 +10 把 DOM 一次性解锁，剩余已加载数据交给本地扩窗。
						const growth = resolvePageWindowGrowth(page.messages);
						if (growth > 0) expandWindowBatched(growth);
					}
				})
				.finally(() => {
					if (latestLoadBySession.get(sessionId) === sequence) setIsLoadingMessagePage(false);
				});
			return;
		}
		// runtime 窗口会话：直接按轮次补历史（2026-11 轮次模型，不再有 100 条渲染窗口）。
		// 首次加载以运行时窗口段首条消息的 entryId 为锚点（两个下标空间唯一的对齐点），
		// 续页用上一页最旧条目的 entryId（nextBeforeEntryId）——主进程缓存命中路径依赖它。
		if (historyHasMore) {
			const sessionId = options.sessionId;
			if (!sessionId || isLoadingMessagePage) return;
			const before = runtimeHistory?.nextBefore;
			// 首次补历史锚点：窗口首条可能是无 entryId 的系统摘要卡片（compaction/branchSummary），
			// 必须取第一条有 entryId 的消息，否则锚点解析失败导致首次上翻静默放弃。
			const anchorMessage = !runtimeHistory
				? messages.find((m) => typeof m.meta?.entryId === "string")
				: undefined;
			const anchorEntryId =
				typeof anchorMessage?.meta?.entryId === "string" ? anchorMessage.meta.entryId : undefined;
			// 大历史窗口（skipEntries 路径）消息可能整体缺 entryId：退化为窗口首条消息的
			// 文件消息下标（windowStartFilePos）作为数值游标——主进程缓存路径先把它解析成
			// entryId 再查缓存，磁盘路径直接消费文件下标。两者都没有才放弃补历史。
			const anchorFilePos = !runtimeHistory && !anchorEntryId
				? (typeof cachedEntry?.windowStartFilePos === "number"
					? cachedEntry.windowStartFilePos
					: undefined)
				: undefined;
			if (!runtimeHistory && !anchorEntryId && anchorFilePos === undefined) return;
			const sequence = ++nextLoadSequence;
			trackLatestLoad(sessionId, sequence);
			const expectedRevision = cachedEntry?.revision ?? 0;
			setIsLoadingMessagePage(true);
			void desktopApi.sessions
				.readRecordMessagePage(sessionId, before ?? (anchorFilePos !== undefined ? anchorFilePos : undefined), RUNTIME_HISTORY_TURN_PAGE_SIZE, {
					unit: "turn",
					beforeEntryId: anchorEntryId ?? runtimeHistory?.nextBeforeEntryId ?? undefined,
				})
				.then((page) => {
					if (latestLoadBySession.get(sessionId) !== sequence) return;
					if (prependHistoryPage({ sessionId, expectedRevision, before, page })) {
						// runtime history 页与 DOM 使用同一 3 轮 cohort；缓存命中和文件回退
						// 都只开放实际带回的轮数，避免数据 +3、窗口却 +10。
						const growth = resolvePageWindowGrowth(page.messages);
						if (growth > 0) expandWindowBatched(growth);
					}
				})
				.finally(() => {
					if (latestLoadBySession.get(sessionId) === sequence) setIsLoadingMessagePage(false);
				});
			return;
		}
	}, [cachedEntry?.revision, diskPage, expandWindowBatched, historyHasMore, isLoadingMessagePage, messages, options.pageSize, options.sessionId, ownerKey, prependHistoryPage, prependMessagePage, runtimeHistory]);

	// ── 回底清理临时历史（2026-11 轮次模型）──
	// 贴底稳定 1.5s 后清掉翻过的历史前缀（atom 只留运行时窗口段），渲染层内存回到最小；
	// 再次上翻走「atom → 主进程缓存 → 文件」重新拉取（主进程 12 轮内命中，无感）。
	// 上滚/加载历史中会取消待执行的清理；清理后 history 置空，后续再翻再拉。
	const clearHistory = useSetAtom(clearSessionHistoryAtom);
	const historyClearTimerRef = useRef<number | undefined>(undefined);
	useEffect(() => {
		if (!controllerEnabled) return;
		const sessionId = options.sessionId;
		if (!sessionId) return;
		if (autoScroll && runtimeHistory) {
			if (historyClearTimerRef.current != null) return;
			const clearNow = () => {
				historyClearTimerRef.current = undefined;
				if (!clearHistory(sessionId)) return;
				// 清理后丢弃在途历史页响应：迟到页会把已释放的 history 复活并携带旧滚动锚点
				const sequence = ++nextLoadSequence;
				trackLatestLoad(sessionId, sequence);
				setIsLoadingMessagePage(false);
			};
			historyClearTimerRef.current = window.setTimeout(() => {
				const timeline = timelineRef.current;
				// autoScroll 只是「逻辑跟随」，可能还在平滑回底/弹簧动画途中；
				// 物理上没到底就清历史会把用户正在看的页摘掉，延后 500ms 再确认。
				if (
					timeline &&
					!isTimelineAtBottom(timeline.scrollTop, timeline.scrollHeight, timeline.clientHeight)
				) {
					historyClearTimerRef.current = window.setTimeout(clearNow, 500);
					return;
				}
				clearNow();
			}, 1500);
			return () => {
				if (historyClearTimerRef.current != null) {
					window.clearTimeout(historyClearTimerRef.current);
					historyClearTimerRef.current = undefined;
				}
			};
		}
		// 上滚看历史 / 无历史可清：取消待执行清理
		if (historyClearTimerRef.current != null) {
			window.clearTimeout(historyClearTimerRef.current);
			historyClearTimerRef.current = undefined;
		}
	}, [autoScroll, clearHistory, controllerEnabled, options.sessionId, runtimeHistory]);

  const jumpToMessage = useCallback((messageId: string) => {
    const requestOwnerKey = ownerKey;
    const timeline = timelineRef.current;
    if (!timeline || ownerKeyRef.current !== requestOwnerKey) return;
    const existing = timeline.querySelector(
      `[data-message-id="${CSS.escape(messageId)}"]`,
    ) as HTMLElement | null;
    if (existing) {
      existing.scrollIntoView({ behavior: "smooth", block: "start" });
      highlightMessage(existing, requestOwnerKey);
      return;
    }
    const index = combinedMessages.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    // 目标可能在贴底 turn 窗口外：先取消跟随以展开挂载，再等布局后滚动。
    // （2026-11 轮次模型：数据全量在 atom，无需再扩展渲染窗口。）
    autoScrollRef.current = false;
    setAutoScroll(false);
    setShowScrollToBottom(true);
    pendingJumpRef.current = { ownerKey: requestOwnerKey, value: messageId };
  }, [highlightMessage, combinedMessages, ownerKey]);

  useEffect(() => {
    loadMoreAnchorRef.current = undefined;
    pendingJumpRef.current = undefined;
    programmaticScrollRef.current = false;
    programmaticScrollUntilRef.current = 0;
    settleScrollCancelRef.current?.();
    settleScrollCancelRef.current = undefined;
    // 会话切换：清掉上一会话的置顶垫片与动画标记
    clearHighlightTimers();
    return clearHighlightTimers;
  }, [clearHighlightTimers, ownerKey]);

  // 切走落盘：cleanup 把滚动时已算好的 ref 锚点写入 atom，不读 DOM
  // （会话切换复用同一组件实例，cleanup 时 timeline children 可能已是新会话）。
  // 在底部跟流时 ref 为 null → 清除锚点，切回继续跟底。
  useLayoutEffect(() => {
    const sessionId = ownerKey;
    return () => {
      if (scrollAnchorFrameRef.current != null) {
        cancelAnimationFrame(scrollAnchorFrameRef.current);
        scrollAnchorFrameRef.current = undefined;
      }
      if (scrollSaveTimerRef.current != null) {
        window.clearTimeout(scrollSaveTimerRef.current);
        scrollSaveTimerRef.current = undefined;
      }
      if (sessionId && sessionId !== LEGACY_OWNER_KEY) {
        saveScrollAnchor({ sessionId, anchor: currentAnchorRef.current });
      }
      currentAnchorRef.current = null;
    };
  }, [ownerKey, saveScrollAnchor]);

  useEffect(() => {
    if (!controllerEnabled) return;
    // 切换时从 atom 读一次快照（不订阅：恢复后滚动写 atom 不应打扰已恢复的视口）。
    const sessionId = options.sessionId;
    const anchor = sessionId
      ? store.get(sessionScrollAnchorByIdAtom)[sessionId]
      : undefined;
    if (anchor) {
      // 恢复历史查看位置：数据全量在 atom（2026-11 轮次模型无分页窗口），
      // 直接把视口对齐到锚点行；期间禁止自动跟底，新消息到达不拽走用户，
      // 只让「回到底部」按钮保持亮起（stay 语义）。
      autoScrollRef.current = false;
      setAutoScroll(false);
      setShowScrollToBottom(true);
      const requestOwnerKey = ownerKey;
      const frame = requestAnimationFrame(() => {
        const timeline = timelineRef.current;
        if (!timeline || ownerKeyRef.current !== requestOwnerKey) return;
        const el = timeline.querySelector(
          `[data-message-id="${CSS.escape(anchor.messageId)}"]`,
        ) as HTMLElement | null;
        if (el) {
          const elTop =
            el.getBoundingClientRect().top -
            timeline.getBoundingClientRect().top +
            timeline.scrollTop;
          programmaticScrollRef.current = true;
          // 原子恢复：定位 + 解锁锁底 + 取消在途动画一次完成。
          // busy 会话的 ResizeObserver（instant 贴底）看到 isAtBottom=false 不再拽回。
          const api = scrollerScrollApiRef.current;
          const targetTop = Math.max(0, elTop - anchor.offsetTop);
          if (api?.restoreAt) {
            api.restoreAt(targetTop);
          } else {
            // 引擎未挂上（会话切换首帧等）时回退原生定位
            timeline.scrollTop = targetTop;
          }
          // 恢复后的位置即当前锚点：即使恢复后用户未滚动就切走，
          // cleanup 落盘的也是这份锚点（而不是误判为底部/空）。
          currentAnchorRef.current = anchor;
          return;
        }
        // 锚点行不存在（期间被压缩清理 / 在渲染窗口之外——上滚窗口化裁剪）：
        // 对齐渲染窗口顶部（顶部有「显示更早」按钮可继续上溯），保持不跟流，
        // 避免把查看历史的用户拽回底部（2026-08 黑屏治理）。
        autoScrollRef.current = false;
        setAutoScroll(false);
        setShowScrollToBottom(true);
        programmaticScrollRef.current = true;
        timeline.scrollTop = 0;
      });
      return () => cancelAnimationFrame(frame);
    }
    // 无锚点（切走时在底部或从未保存）：默认滚到底、恢复跟底
    autoScrollRef.current = true;
    setAutoScroll(true);
    setShowScrollToBottom(false);
    const requestOwnerKey = ownerKey;
    const frame = requestAnimationFrame(() => {
      const timeline = timelineRef.current;
      if (!timeline || ownerKeyRef.current !== requestOwnerKey) return;
      programmaticScrollRef.current = true;
      timeline.scrollTo({ top: timeline.scrollHeight, behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, [controllerEnabled, ownerKey]);


  // ── 滚动接近顶部自动加载历史（2026-11 轮次模型）──
  // 监听器原挂在 SessionMessageTimeline，迁移到 controller（滚动策略单一 owner）：
  // 程序化滚动（prepend 补偿/贴底/恢复锚点/跳转）同样会派发 scroll 事件，
  // 若补偿后 scrollTop ≤ 阈值会连锁加载下一页；programmaticScrollRef 抑制此类事件，
  // 只响应用户真实滚动（滚到顶才翻一页，停在顶部不动不连翻）。
  const lastHistoryLoadAtRef = useRef(0);
  useEffect(() => {
    if (!controllerEnabled) return;
    const timeline = timelineRef.current;
    if (!timeline) return;
    const hasMore = diskPage ? diskPage.nextBefore !== null : historyHasMore;
    let lastScrollTop = timeline.scrollTop;
    const onScroll = () => {
      if (performance.now() < programmaticScrollUntilRef.current) {
        lastScrollTop = timeline.scrollTop;
        return;
      }
      if (programmaticScrollRef.current) {
        programmaticScrollRef.current = false;
        lastScrollTop = timeline.scrollTop;
        return;
      }
      const now = Date.now();
      // 只在真实上滚时扩窗/预取：触顶后「下滑一下」不应把上方已加载历史突然插进视口。
      const scrollingUp = timeline.scrollTop < lastScrollTop;
      lastScrollTop = timeline.scrollTop;
      if (!scrollingUp) return;
      // 触发阈值随视口高度动态计算（大视口提前更多），下限 120px 兜底。
      const expandThreshold = resolveAutoExpandThreshold(timeline.clientHeight);
      // 方案 C（2026-12）渐进扩展：只要进入「接近顶部」区间且窗口仍可扩展，就先扩
      // 渲染窗口（挂载已加载但未显示的轮次，纯本地 DOM 操作，无 IPC）。
      // 触顶时同样先消费 atom 隐藏数据：用户把滚动条一把拉到顶时不应跳过本地 cohort
      // 直接翻 IPC 页；此时浏览器本来就会显示前插内容，与「触顶加载更早」观感一致。
      if (
        timeline.scrollTop <= expandThreshold &&
        windowExpandableRef.current &&
        pendingExpandTurnsRef.current === 0 &&
        expandBatchFrameRef.current === undefined
      ) {
        if (now - lastWindowExpandAtRef.current < TURN_WINDOW_AUTO_EXPAND_COOLDOWN_MS) return;
        lastWindowExpandAtRef.current = now;
        // 滚动触发的扩展走分批（每帧小批挂载，摊平渲染压力）；
        // 按钮点击 / 跳转定位仍用原子 expandWindow（低频，需立即挂载）。
        expandWindowBatched();
        return;
      }
      // 窗口已覆盖全部已加载数据：在接近顶部区间预取下一页。数据到达时 scrollTop > 8
      // 会做锚点补偿，用户无感；真正触顶时数据通常已在本地，翻页不再「等一下」。
      if (
        timeline.scrollTop > HISTORY_AUTO_LOAD_THRESHOLD &&
        timeline.scrollTop <= expandThreshold &&
        hasMore &&
        !isLoadingMessagePage
      ) {
        if (now - lastHistoryLoadAtRef.current < HISTORY_AUTO_LOAD_COOLDOWN_MS) return;
        lastHistoryLoadAtRef.current = now;
        escapeAutoScroll();
lastHistoryLoadAtRef.current = now;
        loadMoreMessages("scroll");
        return;
      }
      // 触顶且没有本地 cohort 可扩时才补页；isLoading 中不做重复请求。
      if (!hasMore || isLoadingMessagePage) return;
      if (timeline.scrollTop > HISTORY_AUTO_LOAD_THRESHOLD) return;
      // 冷却：prepend 补偿会推高 scrollTop，但惯性滚动仍可能停在顶部连续触发——
      // 300ms 内只翻一页，保证「滑到顶 → 翻一页 → 看完再滑」的节奏。
      if (now - lastHistoryLoadAtRef.current < HISTORY_AUTO_LOAD_COOLDOWN_MS) return;
      lastHistoryLoadAtRef.current = now;
      escapeAutoScroll();
lastHistoryLoadAtRef.current = now;
      loadMoreMessages("scroll");
    };
    timeline.addEventListener("scroll", onScroll, { passive: true });
    return () => timeline.removeEventListener("scroll", onScroll);
  }, [controllerEnabled, diskPage, escapeAutoScroll, expandWindowBatched, historyHasMore, isLoadingMessagePage, loadMoreMessages, timelineRef]);

  useLayoutEffect(() => {
    if (!controllerEnabled) return;
    const anchor = loadMoreAnchorRef.current;
    const timeline = timelineRef.current;
    if (!anchor || !timeline || !matchesTimelineOwner(anchor.ownerKey, ownerKey)) return;
    // 跟底中（autoScrollRef=true）：贴底引擎负责生长补偿，这里恢复会把用户拽回旧位置
    if (autoScrollRef.current) {
      loadMoreAnchorRef.current = undefined;
      return;
    }
    // 所有补页入口统一补偿（preserveAtTop）：即使原视口在顶部也把旧首条钉住，
    // 新历史只出现在上方，用户继续上滚查看——避免「数据一到窗口整体上移」。
    const heightDelta = timeline.scrollHeight - anchor.value.height;
    const nextScrollTop = anchor.value.preserveAtTop
      // 滚动加载用「当前视口」补偿：请求期间用户可能继续滚了，按发起时 anchor 会把用户拽回旧位置。
      ? restoreTimelineAnchor(timeline.scrollTop, heightDelta)
      : resolveTimelineTopCompensation(anchor.value.top, heightDelta);
    if (nextScrollTop === null) {
      loadMoreAnchorRef.current = undefined;
      programmaticScrollRef.current = true;
      const topFrame = requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
      return () => cancelAnimationFrame(topFrame);
    }
    // 标记程序化滚动：prepend 补偿的 scrollTop 赋值会触发 scroll 事件，
    // 不能让 ≤8px 自动加载监听把它当成用户上滚（否则连锁翻页）。
    // rAF 兜底：若补偿实际无位移（delta=0）不产生 scroll 事件，需清掉抑制标记，
    // 避免吞掉下一次用户滚动（scroll 事件任务先于 rAF 派发，顺序安全）。
    programmaticScrollRef.current = true;
    timeline.scrollTop = nextScrollTop;
    loadMoreAnchorRef.current = undefined;
    const frame = requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [controllerEnabled, ownerKey, visibleMessages.length]);

  useEffect(() => {
    if (!controllerEnabled) return;
    const pendingJump = pendingJumpRef.current;
    const timeline = timelineRef.current;
    if (!pendingJump || !timeline || !matchesTimelineOwner(pendingJump.ownerKey, ownerKey)) return;
    const element = timeline.querySelector(
      `[data-message-id="${CSS.escape(pendingJump.value)}"]`,
    ) as HTMLElement | null;
    if (!element) {
      // 目标在渲染窗口之外（上滚窗口化）：逐步扩大窗口，本 effect 随窗口变化重跑
      // 直到目标挂载；目标已不在数据中（期间被压缩清理/删除）则放弃跳转，
      // 避免窗口无限放大（防呆，2026-08 黑屏治理）。
      const stillInData = combinedMessages.some((message) => message.id === pendingJump.value);
      if (!stillInData) {
        pendingJumpRef.current = undefined;
        return;
      }
      expandWindow();
      return;
    }
    pendingJumpRef.current = undefined;
    element.scrollIntoView({ behavior: "smooth", block: "start" });
    highlightMessage(element, ownerKey);
    // autoScroll：贴底 turn 窗口展开后 DOM 才出现目标行，需再跑一轮。
  }, [autoScroll, combinedMessages, controllerEnabled, expandWindow, highlightMessage, ownerKey, scrolledWindowTurns, visibleMessages.length]);

  return {
    timelineRef,
    messages,
    visibleMessages: diskPage ? messages : visibleMessages,
    totalMessageCount: diskPage ? diskPage.total : combinedMessages.length,
    hasMoreMessages: diskPage ? diskPage.nextBefore !== null : historyHasMore,
    // 下一次「加载更多」是否触发 disk 轮次分页（窗口前还有历史）：
    // 2026-11 轮次模型：runtime 会话一律按轮补页（无内存扩窗阶段），文案恒为「加载更多对话」
    nextLoadIsHistory: controllerEnabled && !diskPage && historyHasMore,
    isLoadingMoreMessages: diskPage || historyHasMore ? isLoadingMessagePage : false,
    loadMoreMessages,
    markProgrammaticScroll,
    jumpToMessage,
    scrollToBottom,
    scrollFinalAnswerToUpperMiddle,
    /** 滚动回调：维护会话切换用的滚动锚点（rAF 合并，不触发渲染） */
    handleTimelineScroll,
    autoScroll,
    showScrollToBottom,
    setAutoScrollFromScroller,
    scrollerScrollApiRef,
    scrolledWindowTurns,
    expandWindow,
    windowExpandableRef,
    isSurfaceLoading,
    knownEmpty,
    reloadFromDisk,
  };
}
