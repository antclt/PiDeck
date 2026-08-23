import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, Files } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { FileDiff } from "../agents/file-diff";
import { collectRunFileChanges, fileChangeToDiffLines } from "./TimelineFormat";
import type { AgentRunItem } from "./timeline/types";
import type { DiffFileHandler } from "./ToolCallComponents";
import { MAX_VISIBLE_FILES, visibleFileCount } from "./turn/fileChangesUiState";
import {
	ComposerWidgetFrame,
	useComposerWidgetCollapsed,
} from "./ComposerWidgetLayout";

type ModifiedFileEntry = ReturnType<typeof collectRunFileChanges>[number];

/** A controlled diff disclosure keeps its height change in the composer layout transaction. */
function SessionModifiedFileEntry(props: {
	sessionId: string;
	runId: string;
	entry: ModifiedFileEntry;
	onDiffFile?: DiffFileHandler;
}) {
	const { collapsed, setCollapsed } = useComposerWidgetCollapsed(
		`modified-file-diff:${props.sessionId}:${props.runId}:${props.entry.path}`,
		true,
	);

	return (
		<div className="flex min-w-0 items-center gap-1">
			<FileDiff
				className="min-w-0 flex-1"
				file={`${props.entry.path}${props.entry.count > 1 ? ` ×${props.entry.count}` : ""}`}
				lines={fileChangeToDiffLines(props.entry)}
				status="complete"
				open={!collapsed}
				onOpenChange={(open) => { setCollapsed(!open); }}
				maxHeight={200}
				language="diff"
			/>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				className="size-7 shrink-0 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
				title={t("session.openInDiffViewer", { path: props.entry.path })}
				onClick={() => props.onDiffFile?.(
					props.entry.path,
					props.entry.originalContent,
					props.entry.content,
				)}
			>
				<ExternalLink size={13} />
			</Button>
		</div>
	);
}

/**
 * Shows the latest run's file changes above the composer.
 *
 * This is intentionally a session-level strip rather than a TurnRow child:
 * keeping the diff card beside the input prevents a large completed turn from
 * pushing the conversation viewport away. A new run resets the strip to its
 * compact, collapsed state so old diffs never dominate the next turn.
 */
export function SessionModifiedFilesStrip(props: {
	sessionId: string;
	run?: AgentRunItem;
	onDiffFile?: DiffFileHandler;
}) {
	const [showAll, setShowAll] = useState(false);
	const files = useMemo(
		() => (props.run ? collectRunFileChanges(props.run) : []),
		[props.run],
	);
	const runId = String(props.run?.id ?? "pending");
	const { collapsed, toggleCollapsed } = useComposerWidgetCollapsed(
		`modified-files:${props.sessionId}:${runId}`,
		true,
	);

	useEffect(() => {
		setShowAll(false);
	}, [props.run?.id]);

	if (files.length === 0) return null;

	const visibleFiles = files.slice(0, visibleFileCount(files.length, showAll));
	return (
		<ComposerWidgetFrame
			data-testid="session-modified-files-strip"
			aria-label={t("session.turnFileChangesTitle")}
		>
			<button
				type="button"
				className="flex h-9 w-full items-center gap-2.5 px-3 text-left"
				aria-expanded={!collapsed}
				onClick={toggleCollapsed}
			>
				<Files size={14} aria-hidden="true" className="shrink-0 text-text-tertiary" />
				<span className="shrink-0 text-[13px] font-medium leading-6 text-foreground">
					{t("session.turnFileChangesTitle")}
				</span>
				<span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-text-tertiary">
					{t("session.modifiedFilesCount", { count: files.length })}
				</span>
				<span className="shrink-0 text-text-tertiary" aria-hidden="true">
					{collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
				</span>
			</button>
			{!collapsed && (
				<div className="mb-2 flex max-h-[220px] flex-col gap-0.5 overflow-y-auto overscroll-contain px-3 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-100 motion-reduce:animate-none">
					{visibleFiles.map((entry) => (
						<SessionModifiedFileEntry
							key={entry.path}
							sessionId={props.sessionId}
							runId={runId}
							entry={entry}
							onDiffFile={props.onDiffFile}
						/>
					))}
					{files.length > MAX_VISIBLE_FILES && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="mt-0.5 h-6 self-start gap-1 px-1.5 text-micro text-muted-foreground hover:bg-muted hover:text-foreground"
							onClick={() => { setShowAll((value) => !value); }}
						>
							{showAll
								? t("session.turnFileChangesShowLess")
								: t("session.turnFileChangesShowAll", { count: files.length })}
						</Button>
					)}
				</div>
			)}
		</ComposerWidgetFrame>
	);
}
