import { useAtomValue } from "jotai";
import { useCallback, useRef, useState } from "react";
import { Pause, Play, Target, Trash2 } from "lucide-react";
import { sessionRuntimeBySessionIdAtomFamily } from "../../atoms";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { Button } from "../ui-shadcn/button";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";

/**
 * composer 上方的 goal 常驻条（移植自 dsh-web GoalBar）。
 *
 * 形态：与 todo / queue 同列同宽的独立 36px 卡（图标 + 阶段 + 截断目标 + 操作）。
 * 数据来自 DSH runtime.state.goal 投影。无目标、加载中、已完成都不渲染
 * （完成态由工具面板查看，避免输入区上方长期占一条已结束目标）。
 *
 * 创建入口仍是 /goal 与 DSH 工具面板，本条只负责进行中目标的暂停/恢复/清除。
 */
export function SessionGoalStrip(props: { sessionId: string }) {
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(props.sessionId));
	const goal = runtime?.state?.goal;
	const agentId = runtime?.agentId;
	const [busy, setBusy] = useState(false);
	const [confirmClear, setConfirmClear] = useState(false);
	const pendingRef = useRef(false);

	const runAction = useCallback(async (action: "pause" | "resume" | "clear") => {
		if (!agentId || pendingRef.current) return;
		pendingRef.current = true;
		setBusy(true);
		try {
			await desktopApi.sessions.runDshGoalAction(agentId, action);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			pendingRef.current = false;
			setBusy(false);
		}
	}, [agentId]);

	// 无投影 / 已完成：不占输入区。blocked 仍展示，否则用户看不到卡住原因。
	if (!goal || goal.phase === "complete") return null;

	const phaseLabel =
		goal.phase === "paused"
			? t("dshTools.goalPhase.paused")
			: goal.phase === "blocked"
				? t("dshTools.goalPhase.blocked")
				: t("dshTools.goalPhase.active");

	return (
		<section
			className="w-full shrink-0 overflow-hidden rounded-xl border border-border bg-card"
			data-testid="session-goal-strip"
			aria-label={t("sessionGoal.aria")}
		>
			<div className="flex h-9 w-full items-center gap-2.5 px-3">
				<Target size={14} aria-hidden="true" className="shrink-0 text-text-tertiary" />
				<span className="shrink-0 text-[13px] font-medium leading-6 text-foreground">
					{phaseLabel}
				</span>
				<span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-text-tertiary">
					{goal.objective}
				</span>
				<div className="flex shrink-0 items-center gap-0.5">
					{goal.phase === "active" ? (
						<Button
							variant="ghost"
							size="icon-xs"
							className="size-7 rounded-full text-text-tertiary"
							aria-label={t("dshTools.goalPause")}
							title={t("dshTools.goalPause")}
							disabled={busy || !agentId}
							onClick={() => { void runAction("pause"); }}
						>
							<Pause size={14} aria-hidden="true" />
						</Button>
					) : null}
					{/* paused 与 blocked 都给出恢复：blocked 若只能清除，条上就没有纠错入口。 */}
					{goal.phase === "paused" || goal.phase === "blocked" ? (
						<Button
							variant="ghost"
							size="icon-xs"
							className="size-7 rounded-full text-text-tertiary"
							aria-label={t("dshTools.goalResume")}
							title={t("dshTools.goalResume")}
							disabled={busy || !agentId}
							onClick={() => { void runAction("resume"); }}
						>
							<Play size={14} aria-hidden="true" />
						</Button>
					) : null}
					<Button
						variant="ghost"
						size="icon-xs"
						className="size-7 rounded-full text-text-tertiary hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)]"
						aria-label={t("dshTools.goalClear")}
						title={t("dshTools.goalClear")}
						disabled={busy || !agentId}
						onClick={() => { setConfirmClear(true); }}
					>
						<Trash2 size={14} aria-hidden="true" />
					</Button>
				</div>
			</div>
			{confirmClear ? (
				<ConfirmDialog
					title={t("dshTools.goalClearConfirmTitle")}
					message={t("dshTools.goalClearConfirmMessage")}
					danger
					confirmLabel={t("dshTools.goalClear")}
					onConfirm={() => {
						setConfirmClear(false);
						void runAction("clear");
					}}
					onCancel={() => { setConfirmClear(false); }}
				/>
			) : null}
		</section>
	);
}
