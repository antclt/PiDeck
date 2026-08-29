/**
 * 会话定位轴（右缘刻度）的刻度规划（纯函数，可单测）。
 *
 * 背景：刻度轴此前封顶最近 15 条用户消息——长会话「最上面的刻度不是第一条消息、
 * 很多消息没有刻度」。改为全量展示后，条数可能远超容器可用高度，需要：
 * 1. 优先全量展示：刻度间距（itemSize）按可用高度收缩；
 * 2. 间距压到下限仍放不下：均匀抽稀，但首尾刻度强制保留——
 *    最顶刻度必须对应第一条用户消息（否则「跳到会话开头」不可达），
 *    最底刻度对应最后一条（跟手，滚动位置可预期）。
 */

/** 刻度间距上限（px）：与既有观感一致（每格 14px）。 */
export const RAIL_TICK_MAX_SIZE = 14;
/** 刻度间距下限（px）：再小就只能靠抽稀，保证剩余刻度仍可 hover/点击。 */
export const RAIL_TICK_MIN_SIZE = 4;

export type RailTickPlan<T> = {
  /** 实际渲染的条目（可能被抽稀；顺序不变）。 */
  items: T[];
  /** 每格间距（px），同时用于刻度行高与预览卡对位。 */
  itemSize: number;
};

/**
 * 按容器可用高度规划刻度。
 * availableHeight ≤ 0（首帧未测量）时按全量 + 上限间距渲染，测量后由
 * ResizeObserver 触发重算，不阻塞首帧。
 */
export function planRailTicks<T>(items: readonly T[], availableHeight: number): RailTickPlan<T> {
  const count = items.length;
  if (count === 0) return { items: [], itemSize: RAIL_TICK_MAX_SIZE };
  if (availableHeight <= 0) return { items: [...items], itemSize: RAIL_TICK_MAX_SIZE };
  const fitted = Math.floor(availableHeight / count);
  if (fitted >= RAIL_TICK_MAX_SIZE) return { items: [...items], itemSize: RAIL_TICK_MAX_SIZE };
  if (fitted >= RAIL_TICK_MIN_SIZE) return { items: [...items], itemSize: fitted };
  const maxCount = Math.max(2, Math.floor(availableHeight / RAIL_TICK_MIN_SIZE));
  return { items: sampleWithFixedEnds(items, maxCount), itemSize: RAIL_TICK_MIN_SIZE };
}

/**
 * 均匀抽稀并强制保留首尾。
 * 步长 (count-1)/(maxCount-1) ≥ 1（maxCount ≤ count），取样下标严格递增不重复；
 * round 使首尾自然落在 0 与 count-1。
 */
export function sampleWithFixedEnds<T>(items: readonly T[], maxCount: number): T[] {
  const count = items.length;
  if (count === 0) return [];
  if (count <= maxCount) return [...items];
  const slots = Math.max(2, maxCount);
  const sampled: T[] = [];
  for (let slot = 0; slot < slots; slot += 1) {
    sampled.push(items[Math.round((slot * (count - 1)) / (slots - 1))]);
  }
  return sampled;
}
