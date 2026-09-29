import { useMemo } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, GitCommitHorizontal, GitPullRequestArrow, RotateCcw } from "lucide-react";
import type { ChatMessage } from "../../../../shared/types";
import { replySuggestionsForMessages, type ReplyActionSuggestion } from "../../utils/replyActionSuggestions";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";

const ACTION_ICONS = {
	commit: GitCommitHorizontal,
	commitPush: GitPullRequestArrow,
	retry: RotateCcw,
	continue: ArrowRight,
} satisfies Record<ReplyActionSuggestion["id"], typeof ArrowRight>;

/**
 * 最新回复末尾的快捷操作。发送仍由本栏唯一的 composer 拥有，portal 只改变落点，
 * 不另建发送控制器或把提示词塞进草稿；切换会话时拒绝尚未替换的旧 DOM 落点。
 */
export function SessionReplyActions(props: { sessionId: string; messages: readonly ChatMessage[]; target: HTMLDivElement | null; hidden: boolean; sendDisabled: boolean; onSend: (text: string) => void }) {
	const suggestions = useMemo(() => replySuggestionsForMessages(props.messages), [props.messages]);
	if (props.hidden || !props.target || props.target.dataset.sessionId !== props.sessionId || suggestions.length === 0) return null;

	return createPortal(
		<div data-testid="session-reply-action-strip" role="group" aria-label={t("replySuggest.aria")} className="flex min-w-0 flex-wrap items-center gap-1.5 pt-2">
			{suggestions.map((suggestion) => {
				const Icon = ACTION_ICONS[suggestion.id];
				return (
					<Button key={suggestion.id} type="button" variant="outline" size="xs" className="rounded-full" disabled={props.sendDisabled} title={t(suggestion.textKey)} onClick={() => props.onSend(t(suggestion.textKey))}>
						<Icon data-icon="inline-start" aria-hidden="true" />
						<span>{t(suggestion.labelKey)}</span>
					</Button>
				);
			})}
		</div>,
		props.target,
	);
}
