import { useState } from "react";
import { useAtomValue } from "jotai";
import {
	History,
	ExternalLink,
	StopCircle,
	CheckCircle2,
	XCircle,
	AlertCircle,
	Clock,
	Coins,
	Wrench,
	FileCode,
} from "lucide-react";
import { automationRunsAtom } from "../../atoms/automation-atoms";
import { projectInventoryAtom } from "../../atoms/project-atoms";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { Badge } from "../ui-shadcn/badge";
import { Button } from "../ui-shadcn/button";
import type { AutomationRun } from "../../../../shared/types";

interface AutomationHistoryListProps {
	/** 点击查看执行会话时的回调 */
	onViewSession?: (projectId: string, sessionId: string) => void;
}

function formatDuration(ms?: number) {
	if (!ms || ms <= 0) return "-";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSec = seconds % 60;
	return `${minutes}m ${remainingSec}s`;
}

function formatTime(timestamp?: number) {
	if (!timestamp) return "-";
	const date = new Date(timestamp);
	return date.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

/**
 * 历史执行记录与实时运行看板。
 */
export function AutomationHistoryList({
	onViewSession,
}: AutomationHistoryListProps) {
	const runs = useAtomValue(automationRunsAtom);
	const projects = useAtomValue(projectInventoryAtom);

	const [abortingRunIds, setAbortingRunIds] = useState<Set<string>>(new Set());

	const projectMap = new Map<string, string>();
	for (const p of projects) {
		projectMap.set(p.id, p.name);
	}

	const handleAbort = async (run: AutomationRun) => {
		try {
			setAbortingRunIds((prev) => new Set(prev).add(run.id));
			await desktopApi.automation.abortRun(run.id);
			showNotice(t("automation.runAborted"), 2500);
		} catch (error) {
			showNotice(
				error instanceof Error ? error.message : String(error),
				3500,
			);
		} finally {
			setAbortingRunIds((prev) => {
				const next = new Set(prev);
				next.delete(run.id);
				return next;
			});
		}
	};

	const renderStatusBadge = (status: AutomationRun["status"]) => {
		switch (status) {
			case "queued":
			case "starting":
			case "running":
				return (
					<Badge className="h-5 bg-sky-500/15 text-sky-500 border-sky-500/30 px-1.5 text-[11px] font-normal animate-pulse">
						{status === "queued"
							? t("automation.status.queued")
							: status === "starting"
								? t("automation.status.starting")
								: t("automation.status.running")}
					</Badge>
				);
			case "succeeded":
				return (
					<Badge className="h-5 bg-emerald-500/15 text-emerald-500 border-emerald-500/30 px-1.5 text-[11px] font-normal">
						<CheckCircle2 className="size-3 mr-1" />
						{t("automation.status.succeeded")}
					</Badge>
				);
			case "failed":
			case "timed-out":
			case "budget-exhausted":
			case "interrupted":
				return (
					<Badge className="h-5 bg-destructive/15 text-destructive border-destructive/30 px-1.5 text-[11px] font-normal">
						<XCircle className="size-3 mr-1" />
						{status === "timed-out"
							? t("automation.status.timedOut")
							: status === "interrupted"
								? t("automation.status.interrupted")
								: t("automation.status.failed")}
					</Badge>
				);
			case "aborted":
				return (
					<Badge className="h-5 bg-amber-500/15 text-amber-500 border-amber-500/30 px-1.5 text-[11px] font-normal">
						<AlertCircle className="size-3 mr-1" />
						{t("automation.status.aborted")}
					</Badge>
				);
			case "skipped":
				return (
					<Badge
						variant="outline"
						className="h-5 px-1.5 text-[11px] font-normal text-muted-foreground"
					>
						{t("automation.status.skipped")}
					</Badge>
				);
			default:
				return null;
		}
	};

	if (runs.length === 0) {
		return (
			<div className="flex h-64 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
				<History className="size-8 opacity-40" />
				<span className="text-xs">暂无历史执行记录</span>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-2.5">
			<div className="text-xs text-muted-foreground pb-0.5">
				{t("automation.historyTab")} ({runs.length})
			</div>

			<div className="flex flex-col gap-2">
				{runs.map((run) => {
					const projectName = projectMap.get(run.projectId) || run.projectId;
					const isRunning =
						run.status === "queued" ||
						run.status === "starting" ||
						run.status === "running";
					const isAborting = abortingRunIds.has(run.id);
					const totalTokens = (run.inputTokens || 0) + (run.outputTokens || 0);

					return (
						<div
							key={run.id}
							className="flex flex-col gap-2 rounded-lg border border-border/50 bg-bg-panel/30 p-2.5 transition-colors hover:border-border"
						>
							<div className="flex items-center justify-between gap-2">
								<div className="flex items-center gap-2 min-w-0">
									<span className="text-xs font-medium text-foreground truncate">
										{run.taskName}
									</span>
									<Badge
										variant="outline"
										className="h-4 px-1 text-[10px] font-normal text-muted-foreground"
									>
										{projectName}
									</Badge>
									{renderStatusBadge(run.status)}
									<span className="text-[11px] text-muted-foreground font-mono">
										{run.trigger}
									</span>
								</div>

								{/* 操作 */}
								<div className="flex items-center gap-1.5 shrink-0">
									{isRunning && (
										<Button
											variant="destructive"
											size="sm"
											className="h-6 px-2 text-[11px] gap-1"
											disabled={isAborting}
											onClick={() => handleAbort(run)}
										>
											<StopCircle className="size-3" />
											{t("automation.abortRun")}
										</Button>
									)}
									{run.sessionId && onViewSession && (
										<Button
											variant="outline"
											size="sm"
											className="h-6 px-2 text-[11px] gap-1"
											onClick={() => onViewSession(run.projectId, run.sessionId!)}
										>
											<ExternalLink className="size-3" />
											{t("automation.viewSession")}
										</Button>
									)}
								</div>
							</div>

							{/* 失败原因 / 报错信息 */}
							{run.error && (
								<div className="text-[11px] text-destructive bg-destructive/10 px-2 py-1 rounded font-mono break-all">
									{run.error}
								</div>
							)}

							{/* 底部指标栏 */}
							<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground border-t border-border/20 pt-1.5">
								<span className="flex items-center gap-1">
									<Clock className="size-3 opacity-70" />
									{formatTime(run.startedAt ?? run.queuedAt)}
								</span>
								{run.durationMs != null && (
									<span>
										{t("automation.duration", {
											duration: formatDuration(run.durationMs),
										})}
									</span>
								)}
								{totalTokens > 0 && (
									<span className="flex items-center gap-0.5">
										<Coins className="size-3 opacity-70" />
										{t("automation.tokensUsed", {
											tokens: totalTokens.toLocaleString(),
										})}
									</span>
								)}
								{run.costUsd > 0 && (
									<span>
										{t("automation.costUsed", {
											cost: run.costUsd.toFixed(4),
										})}
									</span>
								)}
								{run.stepCount > 0 && (
									<span className="flex items-center gap-0.5">
										<Wrench className="size-3 opacity-70" />
										{t("automation.stepsCount", {
											steps: String(run.stepCount),
										})}
									</span>
								)}
								{run.changedFiles != null && run.changedFiles > 0 && (
									<span className="flex items-center gap-0.5 text-foreground/80">
										<FileCode className="size-3 opacity-70" />
										{t("automation.changedFiles", {
											count: String(run.changedFiles),
										})}
									</span>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
