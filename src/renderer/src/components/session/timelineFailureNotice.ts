import type { ChatMessage } from "../../../../shared/types";
import { t, translateI18nDescriptor } from "../../i18n";
import { stripAnsi } from "./TimelineFormat";

/**
 * 失败/重试提示：时间线不再渲染卡片，改为 toast。
 * 主进程以 role=error / role=system 消息携带这些 i18nKey（见 AgentManager）。
 * pi 启动失败、runtimeError，以及扩展执行错误（带 debugDetails）保留诊断卡片。
 */
export const FLOATING_FAILURE_KEYS = new Set([
	"diagnostic.requestFailed",
	"diagnostic.requestFailedAfterRetries",
	"diagnostic.requestFailedUnknown",
	"diagnostic.requestFailedUnknownAfterRetries",
	"diagnostic.agentStopped",
	"diagnostic.promptRejected",
	"diagnostic.promptDeliveryUnknown",
	"diagnostic.commandFailed",
	"diagnostic.commandDeliveryUnknown",
	"diagnostic.commandCancelled",
	"diagnostic.processReconnectFailed",
	"diagnostic.historyLoadFailed",
	"diagnostic.retryScheduled",
	"diagnostic.retryScheduledAfterDelay",
	"diagnostic.retrySucceeded",
	"diagnostic.retryFailed",
]);

export const EXTENSION_ERROR_I18N_KEY = "diagnostic.extensionError";

/** toast 里附带的 debugDetails 上限，避免整段堆栈撑爆通知。 */
const MAX_TOAST_DETAIL_CHARS = 280;

export type FailureNoticeKind = "info" | "error";

export type FailureNoticeContent = {
	title: string;
	body: string;
	kind: FailureNoticeKind;
	duration: number;
	id?: string;
};

function messageI18nKey(message: ChatMessage): string {
	const key = message.meta?.i18nKey;
	return typeof key === "string" ? key : "";
}

/** 判断消息是否为「失败/重试类」提示（时间线不渲染、改 toast）。 */
export function isFloatingFailureMessage(message: ChatMessage): boolean {
	return FLOATING_FAILURE_KEYS.has(messageI18nKey(message));
}

/** 扩展执行错误：时间线保留诊断卡，同时对新发生的错误弹一次带详情的 toast。 */
export function isExtensionErrorMessage(message: ChatMessage): boolean {
	return messageI18nKey(message) === EXTENSION_ERROR_I18N_KEY;
}

/** 需要弹 toast 的诊断（浮动失败 + 扩展错误）。 */
export function isFailureNoticeMessage(message: ChatMessage): boolean {
	return isFloatingFailureMessage(message) || isExtensionErrorMessage(message);
}

function readDebugDetails(meta: ChatMessage["meta"]): string {
	const raw = typeof meta?.debugDetails === "string" ? meta.debugDetails.trim() : "";
	return raw;
}

function clipDetail(text: string): string {
	if (text.length <= MAX_TOAST_DETAIL_CHARS) return text;
	return `${text.slice(0, MAX_TOAST_DETAIL_CHARS)}…`;
}

/**
 * 组装失败/重试/扩展错误 toast。
 * 扩展错误不用「会话失败」当标题，并把 pi 原文（debugDetails）放进正文。
 */
export function composeFailureNotice(message: ChatMessage): FailureNoticeContent {
	const meta = message.meta;
	const key = messageI18nKey(message);
	const isRetry = key.startsWith("diagnostic.retry");
	const summary = stripAnsi(translateI18nDescriptor(meta, message.text) || message.text).trim();
	const details = stripAnsi(readDebugDetails(meta));
	const isExtensionError = key === EXTENSION_ERROR_I18N_KEY;

	let body = summary;
	if (isExtensionError) {
		// 标题已说明是扩展错误；正文优先给可排查的原文，没有原文再回退概括句。
		body = details ? clipDetail(details) : summary;
	} else if (!isRetry && details && details !== summary && !summary.includes(details)) {
		body = `${summary}\n${clipDetail(details)}`;
	}

	return {
		title: t(
			isRetry
				? "diagnostic.retryToastTitle"
				: isExtensionError
					? "diagnostic.extensionErrorToastTitle"
					: "diagnostic.failureToastTitle",
		),
		body,
		kind: isRetry ? "info" : "error",
		duration: isRetry ? 2200 : 6000,
		id: isRetry ? `session-retry:${message.agentId}` : undefined,
	};
}
