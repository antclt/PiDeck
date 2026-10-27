import type { ChatMessage } from "../../../../../shared/types";

/**
 * 时间线上仍在等待下一次尝试的自动重试进度。
 *
 * 数据源是重试状态卡本身（pi `auto_retry_start` / DSH `llm/retry` 投影成同一套卡片，
 * 见 AgentManager.upsertRetryStatusMessage、dshEventProjector 的 llm/retry 分支），
 * 因此两个后端无需各自再上报一个运行时字段：卡片 running = 正在重试，settled = 已收口。
 *
 * 取「最后一张重试卡」而不是任意一张：同一轮 run 内多次失败会各留一张卡，
 * 只有尾部那张代表当前状态；它已收敛（成功卡由时间线当瞬态卡隐藏，失败卡留痕）
 * 就说明本轮重试已经结束。
 */
export type RetryProgress = {
	/** 第几次重试（pi auto_retry_start.attempt / DSH llm/retry.retry），从 1 开始 */
	attempt: number;
	/** 重试上限；上报缺失时为 undefined，文案退回不带分母的形式 */
	maxAttempts?: number;
	/** 下一次尝试的计划时刻（卡片时间戳 + delayMs）；无退避延迟时缺失，状态条据此读秒 */
	retryAtMs?: number;
};

/** 只有「已调度 / 等延迟后重试」两键代表进行中；retrySucceeded / retryFailed 是已收口。 */
const PENDING_RETRY_KEYS = new Set(["diagnostic.retryScheduled", "diagnostic.retryScheduledAfterDelay"]);

export function deriveRetryProgress(messages: readonly ChatMessage[] | undefined): RetryProgress | undefined {
	if (!messages || messages.length === 0) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "system") continue;
		const key = message.meta?.i18nKey;
		if (typeof key !== "string" || !PENDING_RETRY_KEYS.has(key)) continue;
		// 找到尾部最后一张重试卡，它的状态就是当前真值。
		if (message.meta?.status !== "running") return undefined;
		const attempt = message.meta?.attempt;
		if (typeof attempt !== "number" || !Number.isFinite(attempt) || attempt <= 0) return undefined;
		const maxAttempts = message.meta?.maxAttempts;
		// 退避倒计时的终点：卡片是「调度时刻」打的，加上 pi/DSH 上报的 delayMs。
		// delayMs 缺失或为 0（立即重试）时不给终点，状态条不显示读秒。
		const delayMs = message.meta?.delayMs;
		const retryAtMs = typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs > 0 && Number.isFinite(message.timestamp) ? message.timestamp + delayMs : undefined;
		return {
			attempt,
			maxAttempts: typeof maxAttempts === "number" && Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : undefined,
			retryAtMs,
		};
	}
	return undefined;
}
