import type { ChatMessage } from "../../../../../shared/types";

/**
 * 状态条尾部的「事实后缀」数据源：本轮工具步数、上下文压力、重试倒计时。
 *
 * 状态条只说后台/时间线已经确定的事实（用户反馈：动画经常轮询、不能真实反映后台），
 * 所以这里只放可测量的量，没有任何文案猜测。
 *
 * 刻意**不含本轮已用时间**：TurnRow 末尾已经有唯一的实时耗时（LiveDuration，100ms 跳动，
 * 流式期间就在状态条上方一行），状态条再读一遍是同一个数字显示两次；而且那一份口径更准
 * （扣掉 ask_question 等待、不含重试退避），这里另起一套只会给出对不上的第二个时间。
 */

/** 上下文占用达到该百分比时在状态条尾部提示（压缩通常发生在这之上，提前告警） */
export const CONTEXT_PRESSURE_PERCENT = 80;

/**
 * 本轮已发生的工具调用次数：从尾部倒序数 `role === "tool"` 的消息，
 * 遇到本轮的用户消息就收口——上一轮的工具不能算进「第 N 步」。
 * 没有用户消息（续跑、历史被截到工具段）时，尾部工具全部计入。
 */
export function countTurnToolSteps(messages: readonly ChatMessage[] | undefined): number {
	if (!messages || messages.length === 0) return 0;
	let toolSteps = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "user") return toolSteps;
		if (message.role === "tool") toolSteps += 1;
	}
	return toolSteps;
}

/**
 * 重试倒计时的剩余整秒（向上取整，永不为负）：重试卡自带 retryAtMs，
 * 这里只做减法，不参与「还剩几次」的判断（那是 deriveRetryProgress 的事）。
 */
export function retryCountdownSeconds(retryAtMs: number | undefined, now: number): number | undefined {
	if (retryAtMs === undefined || !Number.isFinite(retryAtMs)) return undefined;
	return Math.max(0, Math.ceil((retryAtMs - now) / 1000));
}
