import type { ChatMessage } from "../../../../../shared/types";
import { formatDuration } from "../TimelineFormat.ts";

/**
 * 状态条尾部的「事实后缀」数据源：本轮起点、本轮工具步数、上下文压力。
 *
 * 状态条只说后台/时间线已经确定的事实（用户反馈：动画经常轮询、不能真实反映后台），
 * 所以这里只放可测量的量，没有任何文案猜测。计时只是把「没有反馈的空窗」变成
 * 「已经等了多久」——pi 与 DSH 都不上报连接层/网络层信号，秒表是唯一诚实的表达。
 */

/** 上下文占用达到该百分比时在状态条尾部提示（压缩通常发生在这之上，提前告警） */
export const CONTEXT_PRESSURE_PERCENT = 80;

export type TurnStatusFacts = {
	/** 本轮墙钟起点（最后一条用户消息时间）；无用户消息时缺失 = 不计时 */
	turnStartedAt?: number;
	/** 本轮已发生的工具调用次数（最后一条用户消息之后的 tool 消息数） */
	toolSteps: number;
};

export function deriveTurnStatusFacts(messages: readonly ChatMessage[] | undefined): TurnStatusFacts {
	if (!messages || messages.length === 0) return { toolSteps: 0 };
	let toolSteps = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		// 倒序遇到本轮的用户消息就收口：更早的工具属于上一轮，不能计入「第 N 步」。
		if (message.role === "user") return { turnStartedAt: message.timestamp, toolSteps };
		if (message.role === "tool") toolSteps += 1;
	}
	// 没有用户消息（续跑、历史被截到工具段）：步数照给，但绝不编造起点。
	return { toolSteps };
}

/**
 * 状态条秒表文案：<1 分钟只给整秒（每秒刷新的读秒带十分位会抖动），更长的走
 * 时间线共用的 formatDuration 档位（「1m20s」「2h5m3s」）。
 */
export function elapsedClockText(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	return formatDuration(totalSeconds * 1000);
}

/**
 * 重试倒计时的剩余整秒（向上取整，永不为负）：重试卡自带 retryAtMs，
 * 这里只做减法，不参与「还剩几次」的判断（那是 deriveRetryProgress 的事）。
 */
export function retryCountdownSeconds(retryAtMs: number | undefined, now: number): number | undefined {
	if (retryAtMs === undefined || !Number.isFinite(retryAtMs)) return undefined;
	return Math.max(0, Math.ceil((retryAtMs - now) / 1000));
}
