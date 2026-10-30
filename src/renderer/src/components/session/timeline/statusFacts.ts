/**
 * 状态条尾部的「事实后缀」数据源：本轮已用时间、上下文压力、重试倒计时。
 *
 * 状态条只说后台/时间线已经确定的事实（用户反馈：动画经常轮询、不能真实反映后台），
 * 所以这里只放可测量的量，没有任何文案猜测。
 *
 * 不再提供本轮工具调用次数：状态条不再显示「· 工具调用 N 次」（用户反馈是噪音）。
 *
 * 关于「本轮已用时间」：2026-10 用户反馈 TurnRow 末尾那个实时秒表「单独挂在最底部有点突兀」，
 * 移到状态条与「正在执行命令…」同行。为了避免同一个数字显示两次，TurnRow 末尾改为
 * **只在本轮结束后**显示固定耗时；实时值全轮只有状态条一处。
 * 口径与 TurnRow 保持一致：起点 = run.startedAt + askWaitMs（等待用户回答的时长不计入），
 * 阻塞提问期间冻结在 askPendingAt，不把用户思考时间算成模型耗时。
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

/**
 * 本轮已用毫秒：无有效起点返回 undefined（不编造读数）。
 *
 * frozenAt 优先于 now：ask_question 阻塞期间秒表必须冻在提问弹起那一刻，
 * 否则「用户在思考」的时间会被计进 agent 耗时，与轮末固定值对不上。
 */
export function elapsedRunMs(startedAt: number | undefined, now: number, frozenAt?: number): number | undefined {
	if (startedAt === undefined || !Number.isFinite(startedAt) || startedAt <= 0) return undefined;
	const end = frozenAt !== undefined && Number.isFinite(frozenAt) ? frozenAt : now;
	if (!Number.isFinite(end)) return undefined;
	return Math.max(0, end - startedAt);
}

/**
 * 秒表读数：整秒粒度。
 *
 * 不用 formatDuration 的十分位：状态条是「顺手看一眼」的旁注，每秒跳两次太吵，
 * 而且十分位跳动会带着整行文字轻微抖动；轮末的固定耗时仍用 formatDuration 保留精度。
 */
export function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	let text = "";
	if (hours > 0) text += `${hours}h`;
	if (minutes > 0) text += `${minutes}m`;
	if (seconds > 0) text += `${seconds}s`;
	return text;
}
