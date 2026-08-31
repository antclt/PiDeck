import { useCallback, useEffect, useState } from "react";
import { FileDiff, Undo2 } from "lucide-react";
import { useAtomValue } from "jotai";
import { t, type TranslationKey } from "../../i18n";
import { sessionRuntimeBySessionIdAtomFamily } from "../../atoms/session-selectors";
import { desktopApi } from "../../desktopApi";
import {
	requireSessionCommand,
	sessionCommandFailureToast,
	toSessionRuntimeTarget,
} from "../../utils/sessionCommands";
import { formatRelativeTime } from "../../utils/relativeTime";
import { showNotice } from "../../utils/notice";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { Badge } from "../ui-shadcn/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../ui-shadcn/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui-shadcn/tooltip";
import type {
	RewindCheckpointSummary,
	RewindCheckpointTrigger,
	RewindRestoreScope,
} from "../../../../shared/types";

/** trigger → i18n key（before-restore 含连字符，key 用 camelCase）。 */
const TRIGGER_LABEL_KEY: Record<RewindCheckpointTrigger, TranslationKey> = {
	turn: "rewind.trigger.turn",
	tool: "rewind.trigger.tool",
	resume: "rewind.trigger.resume",
	"before-restore": "rewind.trigger.beforeRestore",
};

/**
 * 检查点列表（弹层与右侧抽屉面板共用）：拉取当前会话在 refs/pi-checkpoints 下的
 * 快照列表，支持查看相对当前工作区的 diff、按范围（files/conversation/all）回退。
 *
 * 挂载即拉取（弹层打开/面板打开都是挂载时机），回退成功后自动刷新。
 * 滚动容器由父级控制：弹层套 ScrollArea，抽屉面板走 drawer-content-frame。
 */
export function RewindCheckpointList(props: { sessionId: string }) {
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(props.sessionId));
	const target = toSessionRuntimeTarget(props.sessionId, runtime);
	const [checkpoints, setCheckpoints] = useState<RewindCheckpointSummary[]>([]);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	/** checkpointId → diff 文本缓存（存在即视为已加载/已收起开关）。 */
	const [diffs, setDiffs] = useState<Record<string, string>>({});
	const [diffLoadingId, setDiffLoadingId] = useState<string | null>(null);
	/** 待确认回退：检查点 + 回退范围（files/conversation/all，由恢复按钮的下拉菜单选择）。 */
	const [confirmRestore, setConfirmRestore] = useState<
		{ cp: RewindCheckpointSummary; scope: RewindRestoreScope } | null
	>(null);
	const [restoring, setRestoring] = useState(false);

	/** 拉取当前会话检查点列表；无运行时（未激活/已停止）时给出可读提示。 */
	const reload = useCallback(async () => {
		if (!target) {
			setCheckpoints([]);
			setLoadError(t("rewind.unavailable"));
			return;
		}
		setLoading(true);
		setLoadError(null);
		try {
			const list = requireSessionCommand(
				await desktopApi.sessions.listRewindCheckpoints(target),
			).value;
			setCheckpoints(list);
		} catch (error) {
			setCheckpoints([]);
			setLoadError(sessionCommandFailureToast(error, (raw) => t("rewind.loadFailed", { error: raw })));
		} finally {
			setLoading(false);
		}
	}, [target]);

	// 每次挂载（弹层打开/抽屉面板打开）都重新拉取：回退后列表会变化，
	// 且 ref 可能被外部 pi 进程新增。
	useEffect(() => {
		void reload();
	}, [reload]);

	const toggleDiff = useCallback(
		async (cp: RewindCheckpointSummary) => {
			const existing = diffs[cp.id];
			if (existing !== undefined) {
				// 已加载 → 收起（删除缓存项，允许再次展开重新拉取）。
				setDiffs((prev) => {
					const next = { ...prev };
					delete next[cp.id];
					return next;
				});
				return;
			}
			if (!target) return;
			setDiffLoadingId(cp.id);
			try {
				const text = requireSessionCommand(
					await desktopApi.sessions.getRewindCheckpointDiff(target, cp.id),
				).value;
				setDiffs((prev) => ({ ...prev, [cp.id]: text }));
			} catch (error) {
				showNotice(
					sessionCommandFailureToast(error, (raw) => t("rewind.diffLoadFailed", { error: raw })),
					undefined,
					"error",
				);
			} finally {
				setDiffLoadingId(null);
			}
		},
		[target, diffs],
	);

	const performRestore = useCallback(async () => {
		// restoring 防抖：确认框恢复中拒绝再次触发（git 回退不可打断）。
		if (!confirmRestore || !target || restoring) return;
		const { cp, scope } = confirmRestore;
		setRestoring(true);
		try {
			const result = requireSessionCommand(
				await desktopApi.sessions.restoreRewindCheckpoint(target, cp.id, scope),
			).value;
			// conversation/all 会 fork 出新会话（原会话保留）：toast 提示新会话 id。
			if (result.forkedSessionId) {
				showNotice(
					scope === "conversation"
						? t("rewind.conversationForked", { id: cp.id, forked: result.forkedSessionId })
						: t("rewind.restoreDoneForked", { id: cp.id, forked: result.forkedSessionId }),
				);
			} else {
				showNotice(t("rewind.restoreDone", { id: cp.id }));
			}
			setConfirmRestore(null);
			// 回退会改动工作区/会话 → 刷新列表，避免展示过期的快照状态。
			await reload();
		} catch (error) {
			showNotice(
				sessionCommandFailureToast(error, (raw) => t("rewind.restoreFailed", { error: raw })),
				undefined,
				"error",
			);
			setConfirmRestore(null);
		} finally {
			setRestoring(false);
		}
	}, [confirmRestore, target, reload, restoring]);

	return (
		<>
			{loading && checkpoints.length === 0 ? (
				<p className="px-1 py-2 text-xs text-text-tertiary">{t("common.loading")}</p>
			) : loadError ? (
				<p className="px-1 py-2 text-xs text-destructive">{loadError}</p>
			) : checkpoints.length === 0 ? (
				<div className="px-1 py-2 text-xs leading-5 text-text-secondary">
					<p>{t("rewind.empty")}</p>
					<p className="mt-0.5 text-text-tertiary">{t("rewind.emptyHint")}</p>
				</div>
			) : (
				checkpoints.map((cp) => (
					<CheckpointRow
						key={cp.id}
						cp={cp}
						diff={diffs[cp.id]}
						diffLoading={diffLoadingId === cp.id}
						restoring={restoring && confirmRestore?.cp.id === cp.id}
						onToggleDiff={() => void toggleDiff(cp)}
						onRestore={(scope) => setConfirmRestore({ cp, scope })}
					/>
				))
			)}
			{confirmRestore && (
				<ConfirmDialog
					title={t(
						confirmRestore.scope === "files"
							? "rewind.restoreConfirmTitle"
							: confirmRestore.scope === "conversation"
								? "rewind.restoreConfirmConversation"
								: "rewind.restoreConfirmAll",
					)}
					message={t(
						confirmRestore.scope === "files"
							? "rewind.restoreConfirmMessage"
							: confirmRestore.scope === "conversation"
								? "rewind.restoreConfirmMessageConversation"
								: "rewind.restoreConfirmMessageAll",
						{
							id: confirmRestore.cp.id,
							time: formatRelativeTime(confirmRestore.cp.timestamp),
						},
					)}
					confirmLabel={t(
						confirmRestore.scope === "files"
							? "rewind.restoreConfirmRestore"
							: confirmRestore.scope === "conversation"
								? "rewind.restoreConfirmConversation"
								: "rewind.restoreConfirmAll",
					)}
					danger
					onConfirm={() => void performRestore()}
					onCancel={() => setConfirmRestore(null)}
				/>
			)}
		</>
	);
}

function CheckpointRow(props: {
	cp: RewindCheckpointSummary;
	diff?: string;
	diffLoading: boolean;
	restoring: boolean;
	onToggleDiff: () => void;
	onRestore: (scope: RewindRestoreScope) => void;
}) {
	const { cp } = props;
	// 描述缺省时按 trigger 回退到可读标签（tool → 工具名，turn → 第 N 轮）。
	const fallbackLabel =
		cp.trigger === "tool" && cp.toolName
			? cp.toolName
			: cp.trigger === "turn"
				? t("rewind.turnLabel", { turn: cp.turnIndex })
				: cp.trigger === "before-restore"
					? t("rewind.triggerBeforeRestoreHint")
					: t(TRIGGER_LABEL_KEY[cp.trigger]);
	const diffVisible = props.diff !== undefined || props.diffLoading;
	return (
		<div className="rounded-lg border border-border bg-card/60 p-2">
			<div className="flex items-start gap-2">
				<div className="min-w-0 flex-1">
					<p className="truncate text-xs font-medium text-foreground" title={cp.description}>
						{cp.description ?? fallbackLabel}
					</p>
					<div className="mt-1 flex items-center gap-1.5 text-[11px] text-text-tertiary">
						<Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
							{t(TRIGGER_LABEL_KEY[cp.trigger])}
						</Badge>
						{cp.trigger === "tool" && cp.toolName ? (
							<span className="truncate" title={cp.toolName}>{cp.toolName}</span>
						) : cp.trigger === "turn" ? (
							<span>{t("rewind.turnLabel", { turn: cp.turnIndex })}</span>
						) : null}
						<span className="ml-auto shrink-0 tabular-nums">{formatRelativeTime(cp.timestamp)}</span>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								className="grid size-6 place-items-center rounded-md text-text-tertiary transition-colors hover:bg-muted/60 disabled:opacity-50"
								disabled={props.diffLoading || props.restoring}
								aria-label={t(diffVisible ? "rewind.diffClose" : "rewind.diff")}
								onClick={props.onToggleDiff}
							>
								<FileDiff size={13} strokeWidth={1.8} aria-hidden="true" />
							</button>
						</TooltipTrigger>
						<TooltipContent>{t(diffVisible ? "rewind.diffClose" : "rewind.diff")}</TooltipContent>
					</Tooltip>
					{/* 恢复按钮：下拉选择回退范围（仅文件 / 仅对话 / 全部），选项自带说明文案。 */}
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								className="grid size-6 place-items-center rounded-md text-text-tertiary transition-colors hover:bg-muted/60 disabled:cursor-default disabled:opacity-50"
								disabled={props.restoring}
								aria-label={t("rewind.restoreTitle")}
							>
								{props.restoring ? (
									<span className="size-3 animate-spin rounded-full border border-text-tertiary border-t-transparent" aria-hidden="true" />
								) : (
									<Undo2 size={13} strokeWidth={1.8} aria-hidden="true" />
								)}
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="min-w-44">
							<DropdownMenuItem onSelect={() => props.onRestore("files")}>
								<span className="flex flex-col">
									<span className="text-xs font-medium">{t("rewind.scope.files")}</span>
									<span className="text-[10px] text-text-tertiary">{t("rewind.scopeFilesHint")}</span>
								</span>
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => props.onRestore("conversation")}>
								<span className="flex flex-col">
									<span className="text-xs font-medium">{t("rewind.scope.conversation")}</span>
									<span className="text-[10px] text-text-tertiary">{t("rewind.scopeConversationHint")}</span>
								</span>
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => props.onRestore("all")}>
								<span className="flex flex-col">
									<span className="text-xs font-medium">{t("rewind.scope.all")}</span>
									<span className="text-[10px] text-text-tertiary">{t("rewind.scopeAllHint")}</span>
								</span>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
			{diffVisible && (
				<div className="mt-1.5 max-h-40 overflow-auto rounded-md bg-muted/40 px-2 py-1.5 font-mono text-[10px] leading-4 text-text-secondary">
					{props.diffLoading ? (
						<span>{t("common.loading")}</span>
					) : props.diff ? (
						<pre className="whitespace-pre-wrap">{props.diff}</pre>
					) : (
						<span>{t("rewind.diffEmpty")}</span>
					)}
				</div>
			)}
		</div>
	);
}
