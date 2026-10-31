import { t, type TranslationKey } from "../../i18n";
import { shouldShowRemoteGitCapabilityNote, type RemoteGitCapabilityNoteContext, type RemoteGitCapabilityNoteKind } from "../../utils/remoteGitCapabilityNotes";

/**
 * 远端 Git 能力说明条：只解释「这个位置没有哪些能力」，不渲染任何假按钮或成功分支。
 * 文案复用现有 live key（historyReadOnly / commitHint / compareHint），多仓说明新增 repoScopeSingle。
 */
const NOTE_KEYS: Record<RemoteGitCapabilityNoteKind, TranslationKey> = {
	history: "remoteGit.historyReadOnly",
	commit: "remoteGit.commitHint",
	repoScope: "remoteGit.repoScopeSingle",
	compare: "remoteGit.compareHint",
};

export function RemoteGitCapabilityNote(props: { kind: RemoteGitCapabilityNoteKind; context?: RemoteGitCapabilityNoteContext }) {
	if (!shouldShowRemoteGitCapabilityNote(props.kind, props.context)) return null;
	return (
		<p data-testid={`remote-git-capability-note-${props.kind}`} className="px-3 pb-1 text-xs text-text-secondary">
			{t(NOTE_KEYS[props.kind])}
		</p>
	);
}
