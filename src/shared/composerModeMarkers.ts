/**
 * 组合输入模式（计划 / 目标）的隐藏标记 —— 主进程与渲染层共用的唯一字面量来源。
 *
 * 实现载体：renderer 把标记塞进 `agentMessage`（用户可见消息保持原文），pi 内置扩展
 * `pi-deck-plan-mode` / `pi-deck-goal-mode` 在 input 事件里识别、剥掉标记并切换到对应工具集。
 *
 * 为什么放在 shared：主进程在**发送边界**要用同一份字面量做兜底（远端会话没注入对应扩展时，
 * 标记没人识别 ⇒ 原文进 prompt 且只读不生效）。两边各写一份字符串，第一次改名就会让兜底静默失效。
 */
export const PI_DECK_PLAN_MODE_MARKER = "__PI_DECK_PLAN_MODE__";
export const PI_DECK_GOAL_MODE_MARKER = "__PI_DECK_GOAL_MODE__";

/**
 * 标记 → 负责它的内置扩展。顺序即检测顺序；`mode` 只用于状态回退与日志。
 *
 * 新增第三种模式时在这里加一行即可：渲染层负责生成标记，主进程负责「扩展没注入就剥标记」。
 */
export const PI_DECK_MODE_MARKER_EXTENSIONS = [
	{ marker: PI_DECK_PLAN_MODE_MARKER, extension: "pi-deck-plan-mode.ts", mode: "plan" },
	{ marker: PI_DECK_GOAL_MODE_MARKER, extension: "pi-deck-goal-mode.ts", mode: "goal" },
] as const;

export type PiDeckComposerMode = (typeof PI_DECK_MODE_MARKER_EXTENSIONS)[number]["mode"];
