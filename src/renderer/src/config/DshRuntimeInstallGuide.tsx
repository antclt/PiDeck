import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Download, FolderOpen, LoaderCircle } from "lucide-react";
import { t } from "../i18n";
import { Button } from "../components/ui-shadcn/button";
import { DshLogo } from "../components/session/SessionSourceBadge";
import { desktopApi } from "../desktopApi";
import type {
	DshRuntimeInstallPhase,
	DshRuntimeStatus,
} from "../../../shared/types/dshRuntime";

type DshRuntimeInstallGuideProps = {
	/** 主进程探测到的 runtime 状态；checking 由调用方跳过（本组件只处理已确定的不可用态）。 */
	status: DshRuntimeStatus;
};

/** 阶段 → 文案 key（done/error 不在此列，各自单独渲染）。 */
const PHASE_LABEL: Partial<Record<DshRuntimeInstallPhase, string>> = {
	downloading: "dsh.runtime.phase.downloading",
	verifying: "dsh.runtime.phase.verifying",
	extracting: "dsh.runtime.phase.extracting",
	finalizing: "dsh.runtime.phase.finalizing",
};

/**
 * DSH runtime 未安装 / 不可用时的整页空态（AgentRuntimeProvider 阶段 2）。
 *
 * 之所以是「整页替换」而不是在配置表单上叠遮罩：runtime 不在时 host 连 fork 都做不到，
 * 表单里每一项（供应商、模型、插件、凭据）都会失败，露出半成品表单比不给表单更糟。
 *
 * 安装成功后不需要本地跳转：主进程 refresh 会经 dsh-runtime:status-changed 广播
 * 新状态，ConfigModal 据此自动切回 DshConfigTab。
 */
export function DshRuntimeInstallGuide({ status }: DshRuntimeInstallGuideProps) {
	const [phase, setPhase] = useState<DshRuntimeInstallPhase | null>(null);
	const [percent, setPercent] = useState(0);
	const [error, setError] = useState<string | null>(null);

	// 进度走推送而不是 install() 的返回值：下载可能持续数十秒，
	// 等 promise 会让按钮一直转圈、用户不知道进展。
	useEffect(
		() =>
			desktopApi.sessions.onDshRuntimeInstallProgress((progress) => {
				setPhase(progress.phase);
				setPercent(progress.percent);
				if (progress.phase === "error") setError(progress.error ?? null);
				if (progress.phase === "done") {
					setPhase(null);
					setPercent(0);
				}
			}),
		[],
	);

	const run = useCallback(async (kind: "online" | "local") => {
		setError(null);
		setPhase(kind === "online" ? "downloading" : "verifying");
		setPercent(0);
		const result =
			kind === "online"
				? await desktopApi.sessions.installDshRuntime()
				: await desktopApi.sessions.importDshRuntimeFile();
		// 用户取消不是错误，静默回到初始态即可。
		if (!result.ok && result.error !== "cancelled") {
			setError(result.error ?? "unknown error");
			setPhase(null);
		} else if (!result.ok) {
			setPhase(null);
		}
	}, []);

	const broken = status.state === "broken";
	const busy = phase !== null && phase !== "done" && phase !== "error";

	return (
		<div className="flex min-h-0 flex-1 items-center justify-center p-6">
			<div className="flex w-full max-w-md flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-muted/30 px-6 py-8 text-center">
				<DshLogo className="size-8 shrink-0 opacity-70" />
				<div className="text-[15px] font-medium">
					{t(broken ? "dsh.runtime.brokenTitle" : "dsh.runtime.notInstalledTitle")}
				</div>
				<p className="text-[13px] leading-relaxed text-muted-foreground">
					{broken
						? t("dsh.runtime.brokenDesc", { version: status.runtimeVersion ?? "" })
						: t("dsh.runtime.notInstalledDesc")}
				</p>

				{busy ? (
					<div className="mt-1 flex w-full flex-col items-center gap-2">
						<div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
							<LoaderCircle className="size-3.5 animate-spin" />
							{PHASE_LABEL[phase] ? t(PHASE_LABEL[phase] as never) : ""}
						</div>
						<div
							className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
							role="progressbar"
							aria-valuenow={percent}
							aria-valuemin={0}
							aria-valuemax={100}
						>
							<div
								className="h-full rounded-full bg-primary transition-[width] duration-200"
								style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
							/>
						</div>
					</div>
				) : (
					<div className="mt-1 flex flex-wrap items-center justify-center gap-2">
						<Button size="sm" className="gap-1.5" onClick={() => void run("online")}>
							<Download className="size-3.5" />
							{t(broken ? "dsh.runtime.reinstall" : "dsh.runtime.install")}
						</Button>
						{/* 手动导入：镜像不可达 / 离线场景的兜底，对话框由主进程弹出。 */}
						<Button size="sm" variant="outline" className="gap-1.5" onClick={() => void run("local")}>
							<FolderOpen className="size-3.5" />
							{t("dsh.runtime.importLocal")}
						</Button>
					</div>
				)}

				{error ? (
					<div className="mt-1 flex items-start gap-1.5 text-left text-[12px] text-destructive">
						<AlertCircle className="mt-0.5 size-3.5 shrink-0" />
						<span>{t("dsh.runtime.installFailed", { error })}</span>
					</div>
				) : (
					<p className="text-[12px] text-muted-foreground/80">{t("dsh.runtime.installHint")}</p>
				)}
			</div>
		</div>
	);
}
