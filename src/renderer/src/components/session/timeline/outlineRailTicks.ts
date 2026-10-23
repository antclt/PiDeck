/**
 * 会话定位轴（右缘刻度）的刻度规划（纯函数，可单测）。
 *
 * 数量上限：用户反馈「旁边横条太多」。调研三个真实实现后的取舍——
 * Proma 的 scroll-minimap 用 20 根**不可点的桶**做位置图（`MAX_BARS = 20`），
 * dsh TurnNavigator 与 vivid-layer Chat Minimap 都是「全部条目 + 能滚」。
 * 没有一家把**稀疏采样**出来的条当成跳转按钮：刻度可点就必须点得动，
 * 采样会把相邻提问整段丢掉、留下的又常常超出补页预算（点了没反应）。
 *
 * 所以这里不做均匀采样，而是**滑动窗口**：以当前阅读位置为中心最多取
 * RAIL_TICK_LIMIT 个检查点。窗口跟着滚动走——底部时是「最新的 30 条」，
 * 往上翻窗口上移，更早的提问进入窗口（上滑即显示更多）。
 *
 * 间距：能舒展就舒展（上限 14px），放不下就按条数收缩到可点击下限 10px；
 * 连上限条数 × 下限间距都放不下的极窄窗口（终端坞拉开 + 小窗口）才退化为导轨内部滚动。
 */

/** 刻度间距上限（px）：与既有观感一致（每格 14px）。 */
export const RAIL_TICK_MAX_SIZE = 14;
/** 刻度间距下限（px）：同时是滚动档位的固定 pitch，保证刻度仍可 hover/点击。 */
export const RAIL_TICK_MIN_SIZE = 10;
/** 刻度条数上限：滑动窗口大小（2026-10 用户反馈「旁边横条太多」）。 */
export const RAIL_TICK_LIMIT = 30;
/**
 * 点未加载刻度时最多轮询几次（每次 60ms，即约 600ms 的时间盒）。
 *
 * 注意这不是「页数」：`loadMoreMessages` 在上一页仍在飞时直接 return
 * （useSessionTimelineController 的 in-flight 守卫），所以部分轮询是空转。
 * 因此窗口内最靠前的几条仍可能补不到——渲染层对补不到的情况必须给提示，
 * 不能承诺「看得见就一定点得到」。
 */
export const RAIL_PENDING_MAX_ATTEMPTS = 10;

export type RailTickPlan<T> = {
	/** 实际渲染的条目（已按窗口截取）。 */
	items: T[];
	/** 每格间距（px），同时用于刻度行高与预览卡对位。 */
	itemSize: number;
	/** 连上限条数都放不下：渲染层让导轨自身滚动。 */
	scrollable: boolean;
};

/**
 * 取以 activeIndex 为中心、最多 limit 条的滑动窗口。
 *
 * - 条数不超上限：原样返回（短会话不受影响）。
 * - 当前位置未知（activeIndex < 0）：取最近的一批（= 打开会话时的「最新 30 条」）。
 * - 其余：窗口尽量包住当前位置；贴到首尾时自然收缩，不产生空位。
 */
export function windowRailItems<T>(items: readonly T[], activeIndex: number, limit = RAIL_TICK_LIMIT): T[] {
	const count = items.length;
	if (count <= limit) return [...items];
	const half = Math.floor(limit / 2);
	const anchor = activeIndex >= 0 && activeIndex < count ? activeIndex : count - 1;
	const start = Math.max(0, Math.min(count - limit, anchor - half));
	return items.slice(start, start + limit);
}

/**
 * 按容器可用高度规划刻度。
 * availableHeight ≤ 0（首帧未测量）时按上限间距渲染，测量后由
 * ResizeObserver 触发重算，不阻塞首帧。
 */
export function planRailTicks<T>(items: readonly T[], availableHeight: number): RailTickPlan<T> {
	const visible = [...items];
	const count = visible.length;
	if (count === 0) return { items: visible, itemSize: RAIL_TICK_MAX_SIZE, scrollable: false };
	if (availableHeight <= 0) return { items: visible, itemSize: RAIL_TICK_MAX_SIZE, scrollable: false };
	const fitted = Math.floor(availableHeight / count);
	if (fitted >= RAIL_TICK_MAX_SIZE) return { items: visible, itemSize: RAIL_TICK_MAX_SIZE, scrollable: false };
	if (fitted >= RAIL_TICK_MIN_SIZE) return { items: visible, itemSize: fitted, scrollable: false };
	return { items: visible, itemSize: RAIL_TICK_MIN_SIZE, scrollable: true };
}

export type OutlineRailItem = { id: string; role: string; title: string; time: string; entryId?: string; pending?: boolean };

/**
 * 合并「已加载消息大纲」与「索引目录」（计划 §6 S4）。
 *
 * 为什么需要：刻度原先只覆盖已加载消息，长会话最上面的刻度不是第一条提问。
 * 目录项按 entryId 去重：已加载的保留原文标题，未加载的用目录给的标题
 * （索引建表时带走的用户消息 preview，不是序号占位），顺序按目录（= 活动链）为准。
 */
export function mergeOutlineRailItems(loaded: readonly OutlineRailItem[], directory: readonly { entryId: string; title: string; time?: string }[]): OutlineRailItem[] {
	if (directory.length === 0) return [...loaded];
	const byEntryId = new Map<string, OutlineRailItem>();
	for (const item of loaded) if (item.entryId) byEntryId.set(item.entryId, item);
	const merged: OutlineRailItem[] = [];
	for (const entry of directory) {
		const hit = byEntryId.get(entry.entryId);
		if (hit) {
			merged.push(hit);
			continue;
		}
		merged.push({ id: `outline-pending:${entry.entryId}`, entryId: entry.entryId, role: "user", title: entry.title, time: entry.time ?? "", pending: true });
	}
	// 目录只覆盖用户检查点；已加载但没有 entryId 的 live 消息追加在尾部，不能凭空丢刻度。
	const seen = new Set(merged.map((item) => item.id));
	for (const item of loaded) if (!seen.has(item.id)) merged.push(item);
	return merged;
}

/** 是否为「目录里有、消息还没加载」的占位刻度。 */
export function isPendingRailItemId(id: string): boolean {
	return id.startsWith("outline-pending:");
}

/** 从占位刻度 id 取回 entryId。 */
export function pendingEntryIdOf(id: string): string | undefined {
	return id.startsWith("outline-pending:") ? id.slice("outline-pending:".length) : undefined;
}
