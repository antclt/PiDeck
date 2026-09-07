/**
 * 公告通知弹出时机策略（纯函数，可单测）。
 *
 * 不打扰原则：公告是低优先级广播，绝不允许打断用户正在进行的操作
 * （输入/选词、Agent 运行、模态交互），窗口不在前台时也不急着弹。
 * 待提醒内容不丢弃——侧栏红点始终可见，空闲后下一轮轮询自动补弹。
 */

/**
 * 「是否可打扰」上下文。字段全部由采集方（useAnnouncementNotifier 的
 * readAnnouncementBusyContext）填充；本文件只做纯判定，便于 node --test 覆盖。
 */
export type AnnouncementBusyContext = {
	/** 焦点在 composer 富文本输入框内（正在打字/IME 选词）。 */
	composerFocused: boolean;
	/** 当前会话 Agent 运行中（流式回复/工具执行）。 */
	agentBusy: boolean;
	/** 任意模态对话框打开（toast 会压在弹窗上层，观感差）。 */
	modalOpen: boolean;
	/** 窗口失焦/最小化/隐藏到托盘（用户不在看 PiDeck）。 */
	windowInactive: boolean;
};

/** 可见时的轮询间隔（ms）：空转成本仅 2 次 atom 读 + 3 次 DOM 查询，可忽略。 */
export const ANNOUNCEMENT_POLL_VISIBLE_MS = 3_000;
/** 窗口不活跃时的轮询间隔（ms）：后台无需及时性，节流省电。 */
export const ANNOUNCEMENT_POLL_HIDDEN_MS = 30_000;

/** 是否处于「不该打扰」状态：任一忙碌信号命中即跳过本轮弹出（待提醒保留）。 */
export function isBusyForAnnouncement(ctx: AnnouncementBusyContext): boolean {
	return ctx.composerFocused || ctx.agentBusy || ctx.modalOpen || ctx.windowInactive;
}

/** 下一轮轮询延迟：窗口不活跃时用大间隔，可见时用短间隔保证空闲后及时弹出。 */
export function nextTickDelayMs(ctx: AnnouncementBusyContext): number {
	return ctx.windowInactive ? ANNOUNCEMENT_POLL_HIDDEN_MS : ANNOUNCEMENT_POLL_VISIBLE_MS;
}

/** 公告级别 → 全局 toast 的严重度映射（info/warn/critical → info/warning/error）。 */
export function levelToNoticeKind(
	level: "info" | "warn" | "critical",
): "info" | "warning" | "error" {
	if (level === "critical") return "error";
	if (level === "warn") return "warning";
	return "info";
}
