/**
 * 状态条尾部的「事实后缀」数据源：上下文压力、重试倒计时。
 *
 * 状态条只说后台/时间线已经确定的事实（用户反馈：动画经常轮询、不能真实反映后台），
 * 所以这里只放可测量的量，没有任何文案猜测。
 *
 * 不再提供本轮工具调用次数：状态条不再显示「· 工具调用 N 次」（用户反馈是噪音）。
 *
 * 刻意**不含本轮已用时间**：TurnRow 末尾已经有唯一的实时耗时（LiveDuration，100ms 跳动，
 * 流式期间就在状态条上方一行），状态条再读一遍是同一个数字显示两次；而且那一份口径更准
 * （扣掉 ask_question 等待、不含重试退避），这里另起一套只会给出对不上的第二个时间。
 */

/** 上下文占用达到该百分比时在状态条尾部提示（压缩通常发生在这之上，提前告警） */
export const CONTEXT_PRESSURE_PERCENT = 80;

/**
 * 重试倒计时的剩余整秒（向上取整，永不为负）：重试卡自带 retryAtMs，
 * 这里只做减法，不参与「还剩几次」的判断（那是 deriveRetryProgress 的事）。
 */
export function retryCountdownSeconds(retryAtMs: number | undefined, now: number): number | undefined {
	if (retryAtMs === undefined || !Number.isFinite(retryAtMs)) return undefined;
	return Math.max(0, Math.ceil((retryAtMs - now) / 1000));
}
