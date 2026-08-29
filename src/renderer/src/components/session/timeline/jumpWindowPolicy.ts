/**
 * 刻度/消息跳转（jumpToMessage）的挂载与补页策略（纯函数，可单测）。
 *
 * 背景：时间线只挂载滚动窗口内的轮次，且更早的历史按页落盘加载。点击刻度时
 * 目标可能（a）已加载但未挂载——扩渲染窗口；（b）尚未加载——跳转驱动补页；
 * （c）无处可寻——放弃。策略集中在这里，controller 只负责执行。
 */
import { TIMELINE_WINDOW_EXPAND_STEP } from "./turnRenderWindow";

/** 补页防呆：一次跳转最多驱动的补页次数（避免超大文件被一次跳转无限翻页）。 */
export const JUMP_MAX_LOAD_ATTEMPTS = 6;
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
  attempts: number;
}): JumpPendingAction {
  if (input.targetInLoadedData) {
    // 指数步长收敛：远目标不用一格格挪；窗口大于已加载数据时等同全量挂载，无害
    const multiplier = Math.min(2 ** input.attempts, JUMP_EXPAND_MAX_MULTIPLIER);
    return { kind: "expand", turns: TIMELINE_WINDOW_EXPAND_STEP * multiplier };
  }
  if (!input.hasMorePages) return { kind: "give-up" };
  if (input.isLoadingPage) return { kind: "wait" };
  if (input.attempts >= JUMP_MAX_LOAD_ATTEMPTS) return { kind: "give-up" };
  return { kind: "load-page" };
}
