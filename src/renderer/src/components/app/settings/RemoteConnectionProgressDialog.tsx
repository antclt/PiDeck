import { useCallback, useEffect, useState } from "react";
import { Check, Circle, LoaderCircle, X } from "lucide-react";
import { desktopApi } from "../../../desktopApi";
import { t, type TranslationKey } from "../../../i18n";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui-shadcn/button";
import type { RemoteHostConnectionState, RemoteHostDiagnosticEntry } from "../../../../../shared/types/remoteHost";
import { isRemoteConnectionInFlight, resolveRemoteConnectionProgress, type RemoteConnectionStepStatus } from "./remoteConnectionProgressState";

const STEP_LABEL: Record<string, TranslationKey> = {
	channel: "settings.connections.progress.step.channel",
	environment: "settings.connections.progress.step.environment",
	helper: "settings.connections.progress.step.helper",
	agent: "settings.connections.progress.step.agent",
};

const STEP_ICON: Record<RemoteConnectionStepStatus, typeof Circle> = {
	pending: Circle,
	active: LoaderCircle,
	complete: Check,
	failed: X,
};

const STEP_TONE: Record<RemoteConnectionStepStatus, string> = {
	pending: "text-muted-foreground/50",
	active: "text-warning",
	complete: "text-success",
	failed: "text-destructive",
};

/**
 * 连接进度对话框（对应 ZCode 的 connecting step）。
 *
 * 不套 Radix Dialog、也不 portal：它嵌在设置 Dialog 里打开，Radix Presence 的退出动画在离屏窗口里
 * 可能等不到 animationend，portal 会在设置关闭后留下点不到的“僵尸”遮罩。这里直接渲染在设置树内，
 * 随设置卸载；fixed 覆盖设置面板，Escape、背景点击与按钮共用同一条 onClose。
 *
 * 数据来源只有主进程：状态走 `onStateChange` 推送（由设置页持有），诊断走只读
 * `remoteHosts.diagnostics`。诊断本身不发请求、不启动 SSH，因此这里可以在连接期间轮询；
 * 连接结束后停止。
 *
 * 「取消」调用 disconnect —— 主进程会在锁外中止本次 attempt，而不是排队等上传结束；
 * 取消不是失败：界面显示已取消并提供重试。
 */
export function RemoteConnectionProgressDialog(props: { open: boolean; hostId: string; hostLabel: string; state: RemoteHostConnectionState | undefined; errorCode: string | null; busy: boolean; onCancel: () => void; onRetry: () => void; onClose: () => void }) {
	const [entries, setEntries] = useState<RemoteHostDiagnosticEntry[]>([]);
	const [cancelled, setCancelled] = useState(false);
	/** 父层状态偶发未及时清空时的本地兜底：用户点完成/关闭后先立即隐藏。 */
	const [dismissed, setDismissed] = useState(false);
	// 每次针对新的主机/新的尝试重新取诊断，旧主机的阶段不能留在新对话框里。
	useEffect(() => {
		setEntries([]);
		setCancelled(false);
		setDismissed(false);
	}, [props.hostId, props.open]);

	const polling = props.open && (props.busy || isRemoteConnectionInFlight(props.state));
	useEffect(() => {
		if (!polling) return;
		let active = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick = async () => {
			try {
				const result = await desktopApi.remoteHosts.diagnostics(props.hostId);
				if (active && result.ok) setEntries(result.entries);
			} catch {
				// 诊断是尽力而为：读不到不影响连接本身，也不编造阶段。
			}
			if (active) timer = setTimeout(tick, 700);
		};
		void tick();
		return () => {
			active = false;
			if (timer !== undefined) clearTimeout(timer);
		};
	}, [polling, props.hostId]);

	const progress = resolveRemoteConnectionProgress({ state: props.state, entries, errorCode: props.errorCode });
	const showCancelled = cancelled && !isRemoteConnectionInFlight(props.state) && progress.phase === "idle";
	// 刚打开对话框、connect() 还没把状态推到 running 的短暂窗口：仍算「正在连接」，给取消入口。
	const starting = props.busy && progress.phase === "idle" && !showCancelled;
	const title = showCancelled
		? t("settings.connections.progress.cancelledTitle")
		: progress.phase === "ready"
			? t("settings.connections.progress.readyTitle", { host: props.hostLabel })
			: progress.phase === "failed"
				? t("settings.connections.progress.failedTitle")
				: t("settings.connections.progress.title", { host: props.hostLabel });
	const description = showCancelled
		? t("settings.connections.progress.cancelledDescription")
		: progress.phase === "failed"
			? progress.code !== null
				? t("settings.connections.progress.failedDescription", { code: progress.code })
				: t("settings.connections.progress.failedNoCode")
			: progress.phase === "ready"
				? t("settings.connections.progress.readyDescription")
				: t("settings.connections.progress.description");

	const cancel = useCallback(() => {
		setCancelled(true);
		props.onCancel();
	}, [props]);
	const close = useCallback(() => {
		setDismissed(true);
		props.onClose();
	}, [props]);

	useEffect(() => {
		if (!props.open || dismissed) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") close();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [props.open, dismissed, close]);

	if (!props.open || dismissed) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center p-4">
			<div className="absolute inset-0 bg-[var(--overlay-backdrop)] backdrop-blur-[2px]" aria-hidden="true" onClick={close} />
			<div role="dialog" aria-modal="true" aria-labelledby="remote-connection-progress-title" className="relative z-10 flex w-full max-w-md flex-col gap-4 rounded-xl border border-border-subtle bg-bg-panel p-6 shadow-[var(--shadow-popover)]">
				<div className="flex flex-wrap items-center gap-2">
					<h2 id="remote-connection-progress-title" className="text-title font-semibold text-foreground">
						{title}
					</h2>
					{progress.phase === "running" ? <LoaderCircle className="size-4 animate-pideck-spin text-warning" aria-hidden="true" /> : null}
					{progress.phase === "ready" ? <span className="size-2 rounded-full bg-success" aria-hidden="true" /> : null}
				</div>
				<p className="text-pretty text-label text-muted-foreground">{description}</p>

				{/* 阶段轨：完成/进行中/待办/失败四态；失败停在具体一步，不整列变红。 */}
				<ol aria-live="polite" className="flex flex-col gap-2">
					{progress.steps.map((step) => {
						const Icon = STEP_ICON[step.status];
						return (
							<li key={step.key} aria-current={step.status === "active" ? "step" : undefined} className="flex min-w-0 items-center gap-2 text-body">
								<Icon className={cn("size-4 shrink-0", STEP_TONE[step.status], step.status === "active" && "animate-pideck-spin motion-reduce:animate-none")} aria-hidden="true" />
								<span className={cn("min-w-0 truncate", step.status === "pending" ? "text-muted-foreground" : "text-foreground")}>{t(STEP_LABEL[step.key])}</span>
								<span className="ml-auto shrink-0 text-label text-muted-foreground">{step.status === "active" ? t("settings.connections.progress.running") : step.status === "complete" ? t("settings.connections.progress.done") : step.status === "failed" ? t("settings.connections.progress.failed") : null}</span>
							</li>
						);
					})}
				</ol>

				<div className="flex items-center justify-end gap-2">
					{progress.phase === "running" || starting ? (
						<>
							<Button variant="ghost" disabled={props.busy} onClick={cancel}>
								{t("settings.connections.progress.cancel")}
							</Button>
							<Button variant="ghost" onClick={close}>
								{t("settings.connections.progress.hide")}
							</Button>
						</>
					) : progress.phase === "failed" || showCancelled ? (
						<>
							<Button variant="ghost" onClick={close}>
								{t("settings.connections.progress.close")}
							</Button>
							<Button disabled={props.busy} onClick={props.onRetry}>
								{t("settings.connections.progress.retry")}
							</Button>
						</>
					) : (
						<Button onClick={close}>{t("settings.connections.progress.doneAction")}</Button>
					)}
				</div>
			</div>
		</div>
	);
}
