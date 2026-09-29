import type { ChatMessage } from "../../../shared/types";
import type { TranslationKey } from "../i18n/rendererCopy.zh-CN";
import { stripThinkingTags } from "../components/session/TimelineFormat";
import { COMMIT_SUGGESTIONS, hasCommitIntent, type CommitSuggestion } from "./commitIntentSuggestions";

export type ReplyActionSuggestion = {
	id: CommitSuggestion["id"] | "retry" | "continue";
	labelKey: TranslationKey;
	textKey: TranslationKey;
};

const CONTINUE: ReplyActionSuggestion = { id: "continue", labelKey: "replySuggest.continue", textKey: "replySuggest.continueText" };
const RETRY: ReplyActionSuggestion = { id: "retry", labelKey: "replySuggest.retry", textKey: "replySuggest.retryText" };
const REQUEST_FAILURE_KEYS = new Set(["diagnostic.requestFailed", "diagnostic.requestFailedAfterRetries", "diagnostic.requestFailedUnknown", "diagnostic.requestFailedUnknownAfterRetries", "diagnostic.retryFailed"]);
const RETRY_PENDING_KEYS = new Set(["diagnostic.retryScheduled", "diagnostic.retryScheduledAfterDelay"]);

/**
 * 仅为最后一轮生成回复尾部动作；按消息顺序倒查，不用时间戳猜测轮次。
 * 请求失败优先于提交意图，工具/扩展自身报错不等于整轮失败。
 * 运行中、Ask 和投递中的门控由持有 composer 的调用方负责。
 */
export function replySuggestionsForMessages(messages: readonly ChatMessage[]): ReplyActionSuggestion[] {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (message.role === "user") return [];
		if (message.role === "error" || message.role === "system") {
			const key = message.meta?.i18nKey;
			if (typeof key === "string" && RETRY_PENDING_KEYS.has(key)) return [];
			if (typeof key === "string" && REQUEST_FAILURE_KEYS.has(key)) return [RETRY];
			continue;
		}
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error") return [RETRY];
		if (message.stopReason === "aborted" || message.stopReason === "length") return [CONTINUE];
		if (message.stopReason && message.stopReason !== "stop") return [];
		const text = stripThinkingTags(message.text).trim();
		if (!text) return [];
		return hasCommitIntent(text) ? [...COMMIT_SUGGESTIONS, CONTINUE] : [CONTINUE];
	}
	return [];
}
