/**
 * PiDeck Retry No-Body Extension
 *
 * 背景：中转网关（如 thetoken）偶发返回「HTTP 状态码 + 空响应体」的故障，
 * 例如 `400 status code (no body)`、`503 status code (no body)`。
 * 这类错误本质是上游/连接层瞬态故障（响应体为空，网关没来得及写 body），
 * 而非请求构造错误（后者必有 body 说明原因）。实测这类错误重发即成功。
 *
 * 问题：pi 的内置重试判定 `isRetryableAssistantError`（pi-ai/dist/utils/retry.js）
 * 只按 `errorMessage` 文本匹配可重试名单——名单里有 429/500/502/503/504/524
 * 与 `connection error` 等关键词，但 **400 不在名单里**。因此网关把同样的
 * 空响应故障报成 400 时，pi 不会重试，会话直接卡住；报成 503 时却能自动重试。
 *
 * 方案：本扩展在 `message_end` 事件里拦截 assistant 错误消息，识别「空响应」
 * 特征（`(no body)` 等），把 `errorMessage` 追加 ` (connection error)`。
 * 改写后的文本命中 pi 重试名单里的 `connection.?error` 正则，从而让 pi 的
 * `_isRetryableError` → `isRetryableAssistantError` 判定为可重试，走内置的
 * `_prepareRetry` 完整闭环：
 *
 *   - 指数退避：delayMs = baseDelayMs * 2^(attempt-1)（默认 2s/4s/8s，可设置）
 *   - 最大次数：settings.retry.maxRetries 上限，超出后发 auto_retry_end{success:false}
 *   - 可中止：重试 sleep 期间可被 abort 取消
 *   - 不污染会话：_prepareRetry 会从 agent state 移除 error 消息再重发
 *   - UI 事件：auto_retry_start/end 原生触发，PiDeck 气泡显示「重试中」无需额外处理
 *
 * 为什么不直接改状态码为 503：那会篡改事实、丢失「网关报的是 400」这一诊断
 * 信息。追加说明词既保留原文又诚实表达「这是连接层瞬态故障，正在重试」。
 *
 * @packageDocumentation
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 纯函数：空响应错误识别与改写（不依赖 pi API，便于独立测试）
// ---------------------------------------------------------------------------

/**
 * 判断错误信息是否为「空响应」类网关故障。
 *
 * 匹配特征（不区分大小写）：
 * - `400 status code (no body)` / `503 status code (no body)` — thetoken 网关格式
 * - `...no body` 结尾 — 省略状态码前缀的变体
 * - `empty response body` / `no response body` — 其他网关的通用表述
 *
 * 边界条件：只匹配「空响应」这一确定性特征，不匹配任意 400/5xx——避免误伤
 * 真正的请求构造错误（那些错误有 body 说明原因，重试无意义）。
 *
 * @param errorMessage - assistant 消息的 errorMessage 字段
 * @returns 是否为空响应类故障
 */
export function isNoBodyError(errorMessage: string): boolean {
	if (!errorMessage) return false;
	return (
		/\(no body\)/i.test(errorMessage) ||
		/no body\s*$/i.test(errorMessage) ||
		/empty\s+response\s+body/i.test(errorMessage) ||
		/no\s+response\s+body/i.test(errorMessage)
	);
}

/**
 * 把空响应错误改写为可重试文本，使其命中 pi 内置重试名单。
 *
 * 追加 ` (connection error)` 命中 pi 的 `RETRYABLE_PROVIDER_ERROR_PATTERN` 中的
 * `connection.?error` 正则（`isRetryableAssistantError` 判定 `errorMessage` 全文）。
 * 保留原文：用户气泡仍能看到原始错误 + 重试原因，会话历史可诊断。
 *
 * @param errorMessage - 原始错误信息
 * @returns 改写后的可重试错误信息
 */
export function makeRetryableErrorMessage(errorMessage: string): string {
	return `${errorMessage} (connection error)`;
}

// ---------------------------------------------------------------------------
// Pi 扩展入口
// ---------------------------------------------------------------------------

/**
 * PiDeck 内置扩展：让「空响应」类错误复用 pi 的内置重试机制。
 *
 * 挂载到 `message_end` 事件，只处理 assistant + stopReason=error + 空响应。
 * 通过返回 `{ message }` 原地替换 finalized message（agent-session 的
 * `emitMessageEnd` 会 `_replaceMessageInPlace` 改写同一对象），改写发生在
 * `_lastAssistantMessage` 赋值与 `_handlePostAgentRun` 重试判定之前，
 * 因此改写后的 errorMessage 会被 pi 当作「原始错误」参与重试判定。
 */
export default function (pi: ExtensionAPI): void {
	pi.on("message_end", ({ message }) => {
		// 只处理 assistant 的错误消息（user/toolResult/custom 消息直接透传）
		if (message.role !== "assistant") return;
		if (message.stopReason !== "error") return;

		const errorMessage = message.errorMessage;
		if (!errorMessage || !isNoBodyError(errorMessage)) return;

		// 返回替换消息：仅改写 errorMessage，其余字段（content/api/usage 等）
		// 通过展开保留，避免 _replaceMessageInPlace 删掉原消息的其他字段。
		return {
			message: {
				...message,
				errorMessage: makeRetryableErrorMessage(errorMessage),
			},
		};
	});
}
