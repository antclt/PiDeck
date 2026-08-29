/**
 * 刻度/消息跳转（jumpToMessage）的挂载与补页策略（纯函数，可单测）。
 *
 * 背景：时间线只挂载滚动窗口内的轮次，且更早的历史按页落盘加载。点击刻度时
 * 目标可能（a）已加载但未挂载——扩渲染窗口；（b）尚未加载——跳转驱动补页；
 * （c）无处可寻——放弃。策略集中在这里，controller 只负责执行。
 */
import { TIMELINE_WINDOW_EXPAND_STEP } from "./turnRenderWindow";

/** 补页防呆：一次跳转最多驱动的补页次数。每页 3 轮，40 次 ≈ 120 轮历史深度，
 *  覆盖「点第一条刻度直达会话开头」的长会话；不再与扩窗尝试共用计数
 *  （旧版共用 6 次导致点最上面的刻度经常中途放弃、点第二次才成功）。 */
export const JUMP_MAX_LOAD_ATTEMPTS = 40;
/** 扩窗步长封顶倍数：指数步长 3 → 6 → 12 → 24 后不再增长。 */
export const JUMP_EXPAND_MAX_MULTIPLIER = 8;

export type JumpPendingAction =
  | { kind: "expand"; turns: number }
  | { kind: "load-page" }
  /** 页面在途：保持挂起，isLoadingPage 翻转后由 effect 重跑 */
  | { kind: "wait" }
  | { kind: "give-up" };

export function resolveJumpPendingAction(input: {
  targetInLoadedData: boolean;
  hasMorePages: boolean;
  isLoadingPage: boolean;
  /** 指数扩窗的尝试次数（仅 expand 分支消耗）。 */
  expandAttempts: number;
  /** 跳转驱动补页的次数（仅 load-page 分支消耗，与扩窗互不挤占）。 */
  loadAttempts: number;
}): JumpPendingAction {
  if (input.targetInLoadedData) {
    // 指数步长收敛：仅作「点击时一次到位估算不足」的兜底；窗口大于已加载数据时
    // 等同全量挂载，无害
    const multiplier = Math.min(2 ** input.expandAttempts, JUMP_EXPAND_MAX_MULTIPLIER);
    return { kind: "expand", turns: TIMELINE_WINDOW_EXPAND_STEP * multiplier };
  }
  if (!input.hasMorePages) return { kind: "give-up" };
  if (input.isLoadingPage) return { kind: "wait" };
  if (input.loadAttempts >= JUMP_MAX_LOAD_ATTEMPTS) return { kind: "give-up" };
  return { kind: "load-page" };
}

/**
 * 估算「让目标消息进入挂载窗口」所需的窗口轮数（点击刻度时一次性排满扩窗批次，
 * 替代旧版指数多轮收敛——每轮收敛都要一次完整渲染，表现为「点了要等好几拍」）。
 *
 * 轮次窗口从尾部保留 W 个 run：目标在第 k 轮（1-based，共 T 轮）时需要
 * W ≥ T-k+1，即目标（含）之后还有多少条用户消息。轮次以 user 消息为起点
 * （与补页协议 countUserTurns 同一口径）；+1 轮冗余吸收 system/compaction 等
 * 非 run 条目。估算偏大会整段挂载（jumpNavigationActive 已解除条目预算），无害；
 * 估算不足由 effect 的指数兜底补齐。
 */
export function estimateJumpExpandTurns(
  messages: ReadonlyArray<{ role?: string }>,
  targetIndex: number,
): number {
  if (targetIndex < 0 || targetIndex >= messages.length) return TIMELINE_WINDOW_EXPAND_STEP;
  let turnsFromTargetToEnd = 0;
  for (let index = targetIndex; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") turnsFromTargetToEnd += 1;
  }
  return turnsFromTargetToEnd + 1;
}
