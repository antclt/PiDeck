import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { Play, Plus, RefreshCw, Square, Trash2, X } from "lucide-react";
import type { DshPluginView, DshStaticPluginView } from "../../../shared/types";
import { sessionRecordsAtom } from "../atoms";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../components/ui-shadcn/select";
import { Textarea } from "../components/ui-shadcn/textarea";

/**
 * 动态 Cordis 插件管理区（G13 深化）。
 *
 * 语义（与 dsh-tool-cordis 一致，见 src/main/dsh/pideckPluginBridge.ts）：
 * - 动态插件是进程内临时扩展：define 不落盘、重启即失、按会话归属；
 * - 运行/停止/卸载都是面板手势（requestId=null，无需审批）；
 * - Host 源码在 DSH host 进程内执行——运行器明示不是安全边界，仅安装自己编写的代码。
 * 下方另附静态 Loader 条目只读清单（moduleName/enabled/fiberPhase）。
 */
export function DshPluginSection() {
	const records = useAtomValue(sessionRecordsAtom);
	const dshSessions = useMemo(
		() => Object.values(records).filter((record) => record.backend === "dsh" && record.dshSessionId),
		[records],
	);
	const [dynamicPlugins, setDynamicPlugins] = useState<DshPluginView[]>([]);
	const [staticPlugins, setStaticPlugins] = useState<DshStaticPluginView[]>([]);
	const [showInstall, setShowInstall] = useState(false);
	/** 两步确认卸载：第一次点击进入确认态，第二次执行。 */
	const [confirmUninstallId, setConfirmUninstallId] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const loadPlugins = useCallback(async () => {
		try {
			const [dynamic, staticList] = await Promise.all([
				desktopApi.sessions.listDshDynamicPlugins(),
				desktopApi.sessions.listDshStaticPlugins(),
			]);
			setDynamicPlugins(dynamic);
			setStaticPlugins(staticList);
		} catch {
			// host 未装配/未启动：保持空
		}
	}, []);

	useEffect(() => {
		void loadPlugins();
	}, [loadPlugins]);

	const sessionTitle = (agentId: string): string => {
		const record = dshSessions.find((candidate) => candidate.dshSessionId === agentId);
		return record?.title ?? agentId;
	};

	const runPlugin = async (plugin: DshPluginView) => {
		const packageId = plugin.currentPackageId ?? plugin.packages[plugin.packages.length - 1]?.packageId;
		if (!packageId) {
			showNotice(t("config.dsh.pluginNoPackage"), 3000);
			return;
		}
		setBusy(true);
		try {
			await desktopApi.sessions.runDshPlugin({
				sessionId: plugin.agentId,
				pluginId: plugin.pluginId,
				packageId,
				mode: plugin.currentPackageId === packageId ? "run" : "update",
			});
			showNotice(t("config.dsh.pluginRunStarted"), 3000);
			await loadPlugins();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setBusy(false);
		}
	};

	const stopPlugin = async (plugin: DshPluginView) => {
		setBusy(true);
		try {
			await desktopApi.sessions.stopDshPlugin({ sessionId: plugin.agentId, pluginId: plugin.pluginId });
			showNotice(t("config.dsh.pluginStoppedToast"), 3000);
			await loadPlugins();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setBusy(false);
		}
	};

	const uninstallPlugin = async (plugin: DshPluginView) => {
		if (confirmUninstallId !== plugin.pluginId) {
			setConfirmUninstallId(plugin.pluginId);
			return;
		}
		setConfirmUninstallId(null);
		setBusy(true);
		try {
			await desktopApi.sessions.uninstallDshPlugin({ sessionId: plugin.agentId, pluginId: plugin.pluginId });
			showNotice(t("config.dsh.pluginUninstalled"), 3000);
			await loadPlugins();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="grid gap-2">
			<h3 className="text-caption font-semibold text-muted-foreground">{t("config.dsh.dynamicPlugins")}</h3>
			<p className="text-micro text-muted-foreground">{t("config.dsh.dynamicPluginsHint")}</p>
			<div className="flex items-center gap-2">
				<Button type="button" variant="secondary" size="sm" className="h-7" onClick={() => setShowInstall((prev) => !prev)}>
					{showInstall ? <X className="size-3.5" aria-hidden="true" /> : <Plus className="size-3.5" aria-hidden="true" />}
					{t("config.dsh.installPlugin")}
				</Button>
				<Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={() => void loadPlugins()}>
					<RefreshCw className="size-3.5" aria-hidden="true" />
					{t("common.refresh")}
				</Button>
			</div>
			{showInstall && (
				<InstallPluginForm
					sessions={dshSessions.map((record) => ({ sessionId: record.dshSessionId as string, title: record.title }))}
					onInstalled={() => {
						setShowInstall(false);
						void loadPlugins();
					}}
				/>
			)}
			{dynamicPlugins.length === 0 ? (
				<p className="text-micro text-muted-foreground">{t("config.dsh.dynamicPluginsEmpty")}</p>
			) : (
				<div className="grid gap-1.5">
					{dynamicPlugins.map((plugin) => (
						<div
							key={plugin.pluginId}
							className="rounded-md border border-border-subtle bg-bg-panel px-2.5 py-2"
						>
							<div className="flex items-center gap-2">
								<span className="min-w-0 flex-1 truncate text-control font-medium text-foreground">
									{plugin.packages[0]?.name || plugin.pluginId}
								</span>
								<span className={`shrink-0 rounded-full border px-2 py-0.5 text-micro ${plugin.activeRun
									? "border-emerald-300/70 bg-emerald-500/10 text-emerald-700 dark:border-emerald-700/70 dark:text-emerald-300"
									: "border-border-subtle text-muted-foreground"}`}
								>
									{plugin.activeRun ? t("config.dsh.pluginRunning") : t("config.dsh.pluginStopped")}
								</span>
							</div>
							<div className="mt-0.5 flex items-center gap-2 text-caption text-text-secondary">
								<span className="min-w-0 truncate">{plugin.pluginId}</span>
								<span className="shrink-0">·</span>
								<span className="min-w-0 truncate">{t("config.dsh.pluginSession")}: {sessionTitle(plugin.agentId)}</span>
								{plugin.status && (
									<>
										<span className="shrink-0">·</span>
										<span className="shrink-0">{plugin.status}</span>
									</>
								)}
							</div>
							{plugin.error && (
								<p className="mt-1 truncate text-micro text-danger" title={plugin.error}>{plugin.error}</p>
							)}
							<div className="mt-1.5 flex items-center gap-1.5">
								<Button type="button" variant="secondary" size="sm" className="h-6" disabled={busy || Boolean(plugin.activeRun)} onClick={() => void runPlugin(plugin)}>
									<Play className="size-3" aria-hidden="true" />
									{t("config.dsh.pluginRun")}
								</Button>
								<Button type="button" variant="secondary" size="sm" className="h-6" disabled={busy || !plugin.activeRun} onClick={() => void stopPlugin(plugin)}>
									<Square className="size-3" aria-hidden="true" />
									{t("config.dsh.pluginStop")}
								</Button>
								<Button
									type="button"
									variant={confirmUninstallId === plugin.pluginId ? "destructive" : "ghost"}
									size="sm"
									className="h-6 text-muted-foreground"
									disabled={busy}
									onClick={() => void uninstallPlugin(plugin)}
								>
									<Trash2 className="size-3" aria-hidden="true" />
									{t(confirmUninstallId === plugin.pluginId ? "config.dsh.pluginConfirmUninstall" : "config.dsh.pluginUninstall")}
								</Button>
							</div>
						</div>
					))}
				</div>
			)}
			<h3 className="mt-2 text-caption font-semibold text-muted-foreground">{t("config.dsh.staticPlugins")}</h3>
			<p className="text-micro text-muted-foreground">{t("config.dsh.staticPluginsHint")}</p>
			{staticPlugins.length === 0 ? (
				<p className="text-micro text-muted-foreground">{t("config.dsh.staticPluginsEmpty")}</p>
			) : (
				<div className="grid gap-1">
					{staticPlugins.map((entry) => (
						<div key={entry.entryId} className="flex items-center gap-2 text-caption text-text-secondary">
							<span className="min-w-0 flex-1 truncate" title={entry.moduleName}>{entry.moduleName}</span>
							<span className="shrink-0">{entry.enabled ? t("config.dsh.pluginEnabled") : t("config.dsh.pluginDisabled")}</span>
							{entry.fiberPhase && <span className="shrink-0 text-text-tertiary">{entry.fiberPhase}</span>}
						</div>
					))}
				</div>
			)}
		</section>
	);
}

/** 安装表单：选择归属会话 + 语义前缀 + 名称/用途 + Host 源码（define，不运行）。 */
function InstallPluginForm(props: {
	sessions: Array<{ sessionId: string; title: string }>;
	onInstalled: () => void;
}) {
	const [sessionId, setSessionId] = useState(props.sessions[0]?.sessionId ?? "");
	const [idPrefix, setIdPrefix] = useState("");
	const [name, setName] = useState("");
	const [purpose, setPurpose] = useState("");
	const [hostCode, setHostCode] = useState("");
	const [installing, setInstalling] = useState(false);

	if (props.sessions.length === 0) {
		return <p className="text-micro text-muted-foreground">{t("config.dsh.pluginNoSession")}</p>;
	}

	const install = async () => {
		// 与 host 侧校验一致（idPrefix 3-6 个小写字母；至少一侧源码）
		if (!/^[a-z]{3,6}$/.test(idPrefix)) {
			showNotice(t("config.dsh.pluginIdPrefixHint"), 3000);
			return;
		}
		if (!name.trim() || !purpose.trim() || !hostCode.trim()) {
			showNotice(t("config.dsh.pluginFormIncomplete"), 3000);
			return;
		}
		setInstalling(true);
		try {
			await desktopApi.sessions.installDshPlugin({
				sessionId,
				idPrefix,
				name: name.trim(),
				purpose: purpose.trim(),
				hostCode,
			});
			showNotice(t("config.dsh.pluginInstalled"), 3000);
			props.onInstalled();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setInstalling(false);
		}
	};

	return (
		<div className="grid gap-2 rounded-md border border-border-subtle bg-bg-panel p-2.5">
			<div className="grid gap-1.5">
				<label className="text-micro text-muted-foreground">{t("config.dsh.pluginSession")}</label>
				<Select value={sessionId} onValueChange={setSessionId}>
					<SelectTrigger className="h-8">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{props.sessions.map((session) => (
							<SelectItem key={session.sessionId} value={session.sessionId}>{session.title}</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<div className="grid gap-1.5">
				<label className="text-micro text-muted-foreground">{t("config.dsh.pluginIdPrefix")}</label>
				<Input className="h-8" value={idPrefix} onChange={(event) => setIdPrefix(event.target.value)} />
			</div>
			<div className="grid gap-1.5">
				<label className="text-micro text-muted-foreground">{t("config.dsh.pluginName")}</label>
				<Input className="h-8" value={name} onChange={(event) => setName(event.target.value)} />
			</div>
			<div className="grid gap-1.5">
				<label className="text-micro text-muted-foreground">{t("config.dsh.pluginPurpose")}</label>
				<Input className="h-8" value={purpose} onChange={(event) => setPurpose(event.target.value)} />
			</div>
			<div className="grid gap-1.5">
				<label className="text-micro text-muted-foreground">{t("config.dsh.pluginHostCode")}</label>
				<Textarea
					className="min-h-24 font-mono text-caption"
					value={hostCode}
					onChange={(event) => setHostCode(event.target.value)}
					placeholder="export default { apply(ctx) { ... } }"
				/>
				<p className="text-micro text-text-tertiary">{t("config.dsh.pluginClientCodeHint")}</p>
			</div>
			<div className="flex justify-end">
				<Button type="button" variant="secondary" size="sm" className="h-7" disabled={installing} onClick={() => void install()}>
					{t("config.dsh.installPlugin")}
				</Button>
			</div>
		</div>
	);
}
