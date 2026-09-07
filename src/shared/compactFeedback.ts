/**
 * 手动压缩的统一可用态与结果分类。
 *
 * 可用态（按钮 / /compact 共用）：
 * - 上下文占用数据可用（percent 已上报）即可压缩，不再设占用门槛——
 *   占用很低时点击由 pi 自行判定（nothing-to-do / too-small 按原文分类提示）；
 * - 无占用数据（会话未运行 / 尚未上报）视为未就绪，按钮禁用；
 * - 压缩进行中：拒绝重复请求（不再静默当成功）；
 * - compaction cancelled：静默（自动压缩撞车 / 新消息打断）。
 *
 * urgency 色阶保留：≥90 红 / ≥70 黄，仅作视觉提示，不影响可点性。
 */

export type CompactUrgency = "idle" | "warn" | "danger";

export type CompactUiState = {
	/** 上下文占用数据可用（已上报 percent），按钮可点、会发 RPC。 */
	ready: boolean;
	compacting: boolean;
	urgency: CompactUrgency;
};

export type CompactNoticeKind =
	| "done"
	| "nothingToDo"
	| "tooSmall"
	| "inProgress"
	| "failed"
	| "silent";

/** 圆环/压缩可用性判定用的占用字段；与 runtime state / 圆环 occupancy 同源。 */
export type CompactUsageInput = {
	contextPercent?: number | null;
	contextTokens?: number | null;
	contextWindow?: number | null;
};

/**
 * 把 runtime 上报收成「圆环/压缩门槛用」的占用百分比。
 * pi/dsh 偶发 percent=0 但 tokens 非 0（取整或尚未随 tokens 刷新）；
 * 圆环会按 tokens/window 重算，斜杠 /compact 必须用同一数字，否则会出现
 * 「圆环显示 40%、按钮可点，/compact 却提示太小」的分叉。
 * percent 缺失返回 null：草稿刚启动尚未上报，不在客户端拦截。
 * 不封顶 100：pi 按 tokens/contextWindow 直接计算（缓存超窗等场景可 >100%），
 * 其 CLI footer 也显示原始值；封顶会让「真实 112%」显示成 100%，与
 * ~used/window 原始数字及会话头部明细（用原始值）互相矛盾。
 */
export function resolveCompactUsagePercent(
	state?: CompactUsageInput | null,
): number | null {
	if (state?.contextPercent == null) return null;
	let percent = state.contextPercent;
	const used = state.contextTokens;
	const contextWindow = state.contextWindow;
	if (percent <= 0 && used != null && used > 0 && contextWindow != null && contextWindow > 0) {
		percent = (used / contextWindow) * 100;
	}
	return percent;
}

/** 圆环压缩按钮的可见交互态：压缩中禁用；无占用数据（percent 未上报）也禁用。
 * 占用达标与否不再影响可点性（随时可压缩），urgency 色阶仅作视觉提示。 */
export function compactUiState(
	percent: number | null | undefined,
	compacting: boolean,
): CompactUiState {
	return {
		ready: percent != null,
		compacting,
		urgency: percent == null ? "idle" : percent >= 90 ? "danger" : percent >= 70 ? "warn" : "idle",
	};
}

/**
 * 把 pi/DSH/IPC 错误原文收成统一 kind。
 * 调用方再映射 i18n；silent = 不弹 toast。
 */
export function classifyCompactError(raw: string): CompactNoticeKind {
	const lower = raw.trim().toLowerCase();
	if (!lower) return "failed";
	if (/nothing to compact|already compacted/.test(lower)) return "nothingToDo";
	if (/session too small|too small|not ready|below threshold/.test(lower)) {
		return "tooSmall";
	}
	if (/already compacting|compaction in progress/.test(lower)) return "inProgress";
	// cancelled 必须在 inProgress 之后：后者含 compacting，前者含 compaction cancelled
	if (/compaction cancelled|cancelled/.test(lower)) return "silent";
	return "failed";
}
