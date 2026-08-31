import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Download, FolderOpen, LoaderCircle, Trash2 } from "lucide-react";
import { t } from "../i18n";
import { Button } from "../components/ui-shadcn/button";
import { ConfirmDialog } from "../components/ui-shadcn/ConfirmDialog";
import { desktopApi } from "../desktopApi";
import { showNotice } from "../utils/notice";
import type {
	DshRuntimeInstallPhase,
	DshRuntimeStatus,
} from "../../../shared/types/dshRuntime";

/** 阶段 → 文案 key（done/error 不在此列，各自单独渲染）。 */
const PHASE_LABEL: Partial<Record<DshRuntimeInstallPhase, string>> = {
	downloading: "dsh.runtime.phase.downloading",
	verifying: "dsh.runtime.phase.verifying",
	extracting: "dsh.runtime.phase.extracting",
	finalizing: "dsh.runtime.phase.finalizing",
};

/**
 * DSH 后端运行时管理区块（DSH 配置 → 概览页）。
 *
 * 状态自适应：
 * - notInstalled / broken：安装引导（安装按钮 + 手动导入），安装成功后主进程
 *   refresh 广播 status-changed，本区块自动切到已安装形态。
 * - installed + managed：版本 / 安装目录（可打开）/ 卸载 / 重新安装 / 手动导入。
 * - installed + builtin：随应用分发，仅展示版本与说明（不可卸载）。
 *
 * 进度走 dsh-runtime:install-progress 推送而不是 install() 的返回值：
 * 下载可能持续数十秒，等 promise 会让按钮一直转圈、用户不知道进展。
 */
export function DshRuntimeSection({
	status,
	onOpenFolder,
}: {
	status: DshRuntimeStatus;
	onOpenFolder: (path: string) => void;
}) {
	const [phase, setPhase] = useState<DshRuntimeInstallPhase | null>(null);
	const [percent, setPercent] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [uninstallOpen, setUninstallOpen] = useState(false);

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

	const handleUninstall = useCallback(async () => {
		setUninstallOpen(false);
		const result = await desktopApi.sessions.uninstallDshRuntime();
		if (result.ok) showNotice(t("settings.dshRuntimeUninstalled"), 3000);
		else showNotice(result.error ?? t("settings.dshRuntimeUninstall"), 4000, "error");
	}, []);

	const broken = status.state === "broken";
	const notInstalled = status.state === "notInstalled";
	const busy = phase !== null && phase !== "done" && phase !== "error";
	const installed = status.state === "installed";

	// 已安装形态：版本 + 目录 + 管理操作（内置只读展示）。
	if (installed) {
		return (
			<section className="grid gap-2">
				<h3 className="text-caption font-semibold text-muted-foreground">{t("settings.dshRuntime")}</h3>
				<div className="grid gap-1.5 rounded-md border border-border-subtle bg-bg-panel p-3">
					<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
						<span className="text-control font-medium text-foreground">
							{status.source === "builtin"
								? t("settings.dshRuntimeBuiltin", { version: status.runtimeVersion ?? "" })
								: t("settings.dshRuntimeManaged", { version: status.runtimeVersion ?? "" })}
						</span>
						<span className="text-micro text-muted-foreground">
							{status.source === "builtin"
								? t("dsh.runtime.builtinHint")
								: t("dsh.runtime.managedHint")}
						</span>
					</div>
					{/* 安装目录：managed 才有独立落盘目录；builtin 在 app.asar 内无意义 */}
					{status.source === "managed" && status.installDir ? (
						<div className="flex items-center gap-2">
							<span className="shrink-0 text-caption text-muted-foreground">{t("dsh.runtime.installDir")}</span>
							<span className="min-w-0 flex-1 truncate font-mono text-micro text-foreground" title={status.installDir}>
								{status.installDir}
							</span>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-7 shrink-0 rounded-md px-2 text-control"
								onClick={() => onOpenFolder(status.installDir ?? "")}
							>
								{t("config.dsh.openFolder")}
							</Button>
						</div>
					) : null}
					<div className="flex flex-wrap items-center gap-2">
						<Button size="sm" className="gap-1.5" onClick={() => void run("online")}>
							<Download className="size-3.5" />
							{t("dsh.runtime.reinstall")}
						</Button>
						{/* 手动导入：镜像不可达 / 离线场景的兜底，对话框由主进程弹出。 */}
						<Button size="sm" variant="outline" className="gap-1.5" onClick={() => void run("local")}>
							<FolderOpen className="size-3.5" />
							{t("dsh.runtime.importLocal")}
						</Button>
						{status.source === "managed" ? (
							<Button size="sm" variant="outline" className="gap-1.5 text-destructive" onClick={() => setUninstallOpen(true)}>
								<Trash2 className="size-3.5" />
								{t("settings.dshRuntimeUninstall")}
							</Button>
						) : null}
					</div>
					{busy ? (
						<div className="mt-1 flex w-full flex-col items-center gap-2">
							<div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
								<LoaderCircle className="size-3.5 animate-spin" />
								{PHASE_LABEL[phase] ? t(PHASE_LABEL[phase] as never) : ""}
							</div>
							<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
								<div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
							</div>
						</div>
					) : null}
					{error ? (
						<div className="mt-1 flex items-start gap-1.5 text-left text-[12px] text-destructive">
							<AlertCircle className="mt-0.5 size-3.5 shrink-0" />
							<span>{t("dsh.runtime.installFailed", { error })}</span>
						</div>
					) : null}
				</div>
				{/* ConfirmDialog 自身恒 open（靠 AlertDialog 内部控制），必须条件渲染。 */}
				{uninstallOpen ? (
					<ConfirmDialog
						title={t("settings.dshRuntimeUninstall")}
						message={t("settings.dshRuntimeUninstallConfirm")}
						confirmLabel={t("settings.dshRuntimeUninstall")}
						danger
						onConfirm={() => void handleUninstall()}
						onCancel={() => setUninstallOpen(false)}
					/>
				) : null}
			</section>
		);
	}

	// 未安装 / 不可用形态：安装引导（入口即安装，装上后本区块自动切已安装形态）。
	return (
		<section className="grid gap-2">
			<h3 className="text-caption font-semibold text-muted-foreground">{t("settings.dshRuntime")}</h3>
			<div className="grid gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3.5 py-3">
				<div className="text-control font-medium text-foreground">
					{t(broken ? "dsh.runtime.brokenTitle" : "dsh.runtime.notInstalledTitle")}
				</div>
				<p className="text-micro leading-relaxed text-muted-foreground">
					{broken
						? t("dsh.runtime.brokenDesc", { version: status.runtimeVersion ?? "" })
						: t("dsh.runtime.notInstalledDesc")}
				</p>
				{busy ? (
					<div className="flex w-full flex-col items-center gap-2">
						<div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
							<LoaderCircle className="size-3.5 animate-spin" />
							{PHASE_LABEL[phase] ? t(PHASE_LABEL[phase] as never) : ""}
						</div>
						<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
							<div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
						</div>
					</div>
				) : (
					<div className="flex flex-wrap items-center gap-2">
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
					<div className="flex items-start gap-1.5 text-left text-[12px] text-destructive">
						<AlertCircle className="mt-0.5 size-3.5 shrink-0" />
						<span>{t("dsh.runtime.installFailed", { error })}</span>
					</div>
				) : (
					<p className="text-[12px] text-muted-foreground/80">{t("dsh.runtime.installHint")}</p>
				)}
			</div>
		</section>
	);
}
