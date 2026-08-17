import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useMemo, useState, type ReactNode } from "react";
import {
	ArchiveRestore,
	Blocks,
	ChevronDown,
	ChevronRight,
	Copy,
	Cpu,
	Eye,
	EyeOff,
	FileCode2,
	FolderOpen,
	KeyRound,
	LayoutDashboard,
	LoaderCircle,
	Puzzle,
	RefreshCw,
	ShieldCheck,
	Trash2,
} from "lucide-react";
import { desktopApi } from "../desktopApi";
import { t, type TranslationKey } from "../i18n";
import { showNotice } from "../utils/notice";
import { writeClipboard } from "../utils/clipboard";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Switch } from "../components/ui-shadcn/switch";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../components/ui-shadcn/select";
import { DshLogo } from "../components/session/SessionSourceBadge";
import { DSH_PERMISSION_PRESETS } from "../components/session/DshPermissionMenu";
import { useSaveRegistry } from "../hooks/useSaveRegistry";
import { DshSchemaForm, type DshNamespaceView } from "./DshSchemaForm";
import { isDshPluginNamespace, dshPluginNamespaceTitleKey } from "./dshPluginNamespaces";
import { DshPluginSection } from "./DshPluginSection";
import { DeepseekRouteCard, PiAiProvidersCard } from "./DshProviderCards";
import { collectCredentialRefsWithValue, normalizeDshSchema, type DshSectionApi } from "./dshSchema";
import { presetDisplayDescription, presetDisplayName } from "./dshPresetDisplay";
import { credentialRefFor } from "./dshCredentialRef";

type DshStatus = {
	started: boolean;
	homeDir: string;
};

type CredentialState = {
	configured: boolean;
	source?: string;
	writable: boolean;
};

/** 模型配置相关的 namespace：llm-deepseek（官方 DeepSeek 路由）+ llm-pi-ai（pi-ai providers dict）。 */
const MODEL_NS = new Set(["llm-deepseek", "llm-pi-ai"]);

/** 配置目录 + 文件名 → 平台路径（F9：统一拼接，避免散落的 replace 兜底）。 */
function joinConfigPath(homeDir: string, fileName: string): string {
	return `${homeDir.replace(/[\\/]+$/, "")}/${fileName}`;
}

const NAV_ITEMS: Array<{ id: string; labelKey: TranslationKey; icon: ReactNode }> = [
	{ id: "overview", labelKey: "config.dsh.tab.overview", icon: <LayoutDashboard className="size-3.5" aria-hidden="true" /> },
	{ id: "models", labelKey: "config.dsh.tab.models", icon: <Cpu className="size-3.5" aria-hidden="true" /> },
	{ id: "presets", labelKey: "config.dsh.tab.presets", icon: <Blocks className="size-3.5" aria-hidden="true" /> },
	{ id: "plugins", labelKey: "config.dsh.tab.plugins", icon: <Puzzle className="size-3.5" aria-hidden="true" /> },
	{ id: "security", labelKey: "config.dsh.tab.security", icon: <ShieldCheck className="size-3.5" aria-hidden="true" /> },
	{ id: "auth", labelKey: "config.dsh.tab.auth", icon: <KeyRound className="size-3.5" aria-hidden="true" /> },
	{ id: "raw", labelKey: "config.dsh.tab.raw", icon: <FileCode2 className="size-3.5" aria-hidden="true" /> },
];

/** DSH 配置页统一保存句柄（ConfigModal 顶部保存按钮经 ref 调用）。 */
export type DshConfigTabHandle = {
	/** 保存全部未保存修改；返回是否全部成功。 */
	save: () => Promise<boolean>;
};

/**
 * DSH 配置管理页：左侧竖排导航 + 右侧内容区（与 Pi 管理同款操作逻辑）。
 * 概览 / 模型 / 认证 / 设置 / 源文件；配置读写走 settings.describe（schema 表单）
 * 与 credentials.describe，模型 tab 以 provider 卡片 + 模型行管理 llm-pi-ai。
 *
 * 保存语义与 Pi 管理页一致：各分区不再自带保存按钮，草稿变化上报脏状态，
 * 统一由 ConfigModal 顶部保存按钮保存；关闭弹框时有未保存修改会弹确认。
 */
export const DshConfigTab = forwardRef<DshConfigTabHandle, {
	onDirtyChange: (dirty: boolean) => void;
}>(function DshConfigTab(props, ref) {
	const [status, setStatus] = useState<DshStatus | null>(null);
	const [namespaces, setNamespaces] = useState<DshNamespaceView[]>([]);
	const [writable, setWritable] = useState(false);
	const [hasDocument, setHasDocument] = useState(false);
	const [credentialRefs, setCredentialRefs] = useState<string[]>([]);
	const [credentials, setCredentials] = useState<Record<string, CredentialState>>({});
	/** 适配器内置模型目录（llm.models 按 provider 分组；行头模型数/继承模型用）。 */
	const [modelCatalog, setModelCatalog] = useState<Record<string, Array<{ id: string; name?: string }>>>({});
	/** 可配置提供方目录（llm.providers）：模型页「添加 provider」的内置候选。 */
	const [providerDirectory, setProviderDirectory] = useState<Array<{
		provider: string;
		displayName: string;
		active: boolean;
		declared?: boolean;
	}>>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [activeTab, setActiveTab] = useState("overview");

	/** 子分区保存注册表（C22：公共 hook，instanceId → save；顶部保存按钮统一遍历调用）。
	 *  脏状态同步维护（isDirty 立即可读），state 仅驱动 UI。 */
	const {
		register: registryRegister,
		unregister: registryUnregister,
		markDirty: registryMarkDirty,
		isDirty: registryIsDirty,
		saveAll: registrySaveAll,
	} = useSaveRegistry();

	const registerSave = useCallback((instanceId: string, save: () => Promise<boolean>) => {
		registryRegister(instanceId, save);
	}, [registryRegister]);

	const unregisterSave = useCallback((instanceId: string) => {
		registryUnregister(instanceId);
	}, [registryUnregister]);

	const onDirtyChange = useCallback((instanceId: string, dirty: boolean) => {
		registryMarkDirty(instanceId, dirty);
		props.onDirtyChange(registryIsDirty());
	}, [props.onDirtyChange, registryIsDirty, registryMarkDirty]);

	const sectionApi: DshSectionApi = useMemo(() => ({
		onDirtyChange,
		registerSave,
		unregisterSave,
	}), [onDirtyChange, registerSave, unregisterSave]);

	/** 统一保存：遍历所有注册的子分区保存函数；全部成功返回 true。
	 *  成功后清除脏标记（含卸载/收起分区的残留）并上报上层。 */
	const saveAll = useCallback(async (): Promise<boolean> => {
		const ok = await registrySaveAll();
		if (ok) props.onDirtyChange(false);
		return ok;
	}, [props.onDirtyChange, registrySaveAll]);

	useImperativeHandle(ref, () => ({ save: saveAll }), [saveAll]);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const settingsResult = await desktopApi.sessions.describeDshSettings();
			setNamespaces(settingsResult.namespaces);
			setWritable(settingsResult.writable);
			setHasDocument(settingsResult.hasDocument);
			const refs = new Set<string>();
			for (const ns of settingsResult.namespaces) {
				const schema = normalizeDshSchema(ns.schema);
				// 同时收集 schema 静态 default 与 value 动态值（llm-pi-ai providers 的 env 名只存在 value 里）
				if (schema) collectCredentialRefsWithValue(schema, schema.refs[schema.uid], ns.value, refs);
				// 模型命名空间补派生 ref（对齐 dsh-web：未显式 apiKeyEnv 时按 <ROUTE>_API_KEY 派生），
				// 否则行头/认证页会漏掉只有派生名的 provider（如 llm-pi-ai 未写 apiKeyEnv 的配置）
				if (ns.ns === "llm-deepseek") {
					refs.add(credentialRefFor((ns.value ?? {}) as Record<string, unknown>, "deepseek"));
				} else if (ns.ns === "llm-pi-ai") {
					const providers = (ns.value as { providers?: Record<string, unknown> } | undefined)?.providers ?? {};
					for (const [key, provider] of Object.entries(providers)) {
						refs.add(credentialRefFor((provider ?? {}) as Record<string, unknown>, key));
					}
				}
			}
			setCredentialRefs([...refs]);
			// host 级模型目录：模型 tab 行头显示生效模型数、未自定义时展示内置目录（dsh-web 继承模型行）
			try {
				const models = await desktopApi.sessions.listDshModels();
				const byProvider: Record<string, Array<{ id: string; name?: string }>> = {};
				for (const model of models) {
					const group = (byProvider[model.provider] ??= []);
					group.push({ id: model.id, ...(typeof model.name === "string" && model.name ? { name: model.name } : {}) });
				}
				setModelCatalog(byProvider);
			} catch {
				setModelCatalog({});
			}
			// 可配置提供方目录：模型页「添加 provider」的内置候选（失败不阻塞页面）
			try {
				const directory = await desktopApi.sessions.listDshProviders();
				setProviderDirectory(directory);
			} catch {
				setProviderDirectory([]);
			}
			setError(null);
			// 返回本次拉到的 namespace 列表（saveNamespace 冲突重试要用最新 revision）
			return settingsResult.namespaces;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return undefined;
		} finally {
			setLoading(false);
		}
	}, []);

	/** 状态（host 是否启动/目录）独立加载：不依赖 settings.describe，
	 * host boot 失败时概览页仍能显示当前目录与重启入口，而不是整页空白。 */
	const loadStatus = useCallback(async () => {
		try {
			const statusResult = await desktopApi.sessions.getDshStatus();
			setStatus(statusResult);
		} catch {
			// 状态查询失败不阻塞页面（无 host 时部分字段为空即可）
		}
	}, []);

	/** 写密钥（credentials.set）+ 刷新认证状态；供模型页/认证页共用。 */
	const setDshKey = useCallback(async (ref: string, value: string) => {
		await desktopApi.sessions.setDshCredential(ref, value);
		await load();
	}, [load]);

	/** 删密钥（credentials.unset）+ 刷新认证状态。 */
	const unsetDshKey = useCallback(async (ref: string) => {
		await desktopApi.sessions.unsetDshCredential(ref);
		await load();
	}, [load]);

	useEffect(() => {
		void load();
		void loadStatus();
	}, [load, loadStatus]);

	useEffect(() => {
		if (credentialRefs.length === 0) return;
		void desktopApi.sessions.describeDshCredentials(credentialRefs).then(setCredentials).catch(() => undefined);
	}, [credentialRefs]);

	const modelNamespaces = useMemo(
		() => namespaces.filter((ns) => MODEL_NS.has(ns.ns)),
		[namespaces],
	);
	// G13：插件分区动态化——DSH 的 settings namespace 即插件短名（dsh-settings 契约），
	// 除 PiDeck 独占管理的保留命名空间（模型/安全/预设）外，host 注册的命名空间全部按插件呈现。
	const pluginNamespaces = useMemo(
		() => namespaces.filter((ns) => isDshPluginNamespace(ns.ns)),
		[namespaces],
	);
	const permissionNamespace = useMemo(
		() => namespaces.find((ns) => ns.ns === "permission"),
		[namespaces],
	);

	const openFolder = (path: string) => {
		if (path) void desktopApi.files.showInFolder(path).catch(() => undefined);
	};

	const saveNamespace = useCallback(async (ns: string, patch: Record<string, unknown>) => {
		const view = namespaces.find((item) => item.ns === ns);
		try {
			await desktopApi.sessions.updateDshSettings(ns, patch, view?.revision);
		} catch (error) {
			// SETTINGS_CONFLICT：并发写入（host 预设/dsh-web/另一 tab）使本页 revision
			// 过期，host 拒绝本次写入。若沿用旧 revision 重试会被永久拒绝——刷新
			// namespace（拿最新 revision 与现值）后重试一次，patch 是部分合并仍安全。
			// 其它错误（schema 拒绝等）原样上抛，由子卡片展示错误并保留草稿。
			const isConflict = error instanceof Error &&
				(error.message.includes("SETTINGS_CONFLICT") || error.message.includes("changed since it was read"));
			if (!isConflict) throw error;
			const fresh = await load();
			const freshView = fresh?.find((item) => item.ns === ns);
			await desktopApi.sessions.updateDshSettings(ns, patch, freshView?.revision);
		}
		// 保存后刷新（revision / 脱敏值更新）
		await load();
	}, [namespaces, load]);

	return (
		<div className="flex min-h-0 min-w-0 flex-1">
			{/* 左侧竖排导航：常驻（loading/error 时不隐藏），与 Pi 管理 config-sidebar 同款密度 */}
			<nav className="flex min-h-0 w-40 shrink-0 flex-col gap-2.5 overflow-y-auto border-r border-border bg-transparent p-2.5" aria-label={t("config.dsh.title")}>
				<div className="grid gap-0.5">
					{NAV_ITEMS.map((item) => (
						<button
							key={item.id}
							type="button"
							className={`config-nav-btn flex h-8 items-center justify-start gap-1.5 rounded-md px-2.5 text-control font-medium ${activeTab === item.id ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
							onClick={() => setActiveTab(item.id)}
						>
							<span className="config-nav-icon">{item.icon}</span>
							{t(item.labelKey)}
						</button>
					))}
				</div>
			</nav>

			{/* 右侧内容区：loading/error 只影响内容，导航与概览保持可用 */}
			<div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
				{loading && (
					<div className="flex min-h-32 items-center justify-center gap-2 text-control text-muted-foreground">
						<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
						{t("common.loading")}
					</div>
				)}
				{!loading && error && (
					<div className="m-4 rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">
						{error}
						<div className="mt-2.5 flex gap-2">
							<Button type="button" variant="secondary" size="sm" className="h-7" onClick={() => void load()}>
								{t("config.dsh.retry")}
							</Button>
						</div>
					</div>
				)}
				{!loading && !error && (
					<>
						{/* tab 切换用 hidden 而非卸载：子分区草稿跨 tab 保留（统一保存语义） */}
						<div hidden={activeTab !== "overview"}>
							<Overview status={status} hasDocument={hasDocument} onOpenFolder={openFolder} onOpenDocument={openDocument} onChanged={() => { void load(); void loadStatus(); }} />
						</div>
						<div hidden={activeTab !== "models"}>
							<div className="p-4">
								<p className="mb-3 text-micro text-muted-foreground">{t("config.dsh.modelsHint")}</p>
								{modelNamespaces.length === 0 ? (
									<Empty text={t("config.dsh.namespacesEmpty")} />
								) : (
									<div className="grid gap-4">
										{modelNamespaces.map((ns) => (
											<section key={ns.ns} className="rounded-md border border-border-subtle bg-bg-panel">
												{ns.ns === "llm-pi-ai" ? (
													<PiAiProvidersCard
														namespace={ns}
														writable={writable}
														ops={{ credentials, setKey: setDshKey, unsetKey: unsetDshKey }}
														catalog={modelCatalog}
														directory={providerDirectory}
														onSave={(patch) => saveNamespace(ns.ns, patch)}
														sectionApi={sectionApi}
													/>
												) : (
													<DeepseekRouteCard
														namespace={ns}
														writable={writable}
														ops={{ credentials, setKey: setDshKey, unsetKey: unsetDshKey }}
														catalog={modelCatalog["deepseek-official"]}
														onSave={(patch) => saveNamespace(ns.ns, patch)}
														sectionApi={sectionApi}
													/>
												)}
											</section>
										))}
									</div>
								)}
							</div>
						</div>
						<div hidden={activeTab !== "presets"}>
							<div className="p-4">
								<PresetsTab
									writable={writable}
									namespace={namespaces.find((ns) => ns.ns === "agent-presets")}
									onSave={async (id) => {
										const view = namespaces.find((ns) => ns.ns === "agent-presets");
										await desktopApi.sessions.updateDshSettings("agent-presets", { default: id }, view?.revision);
										await load();
									}}
									sectionApi={sectionApi}
								/>
							</div>
						</div>
						<div hidden={activeTab !== "plugins"}>
							<div className="grid gap-4 p-4">
								<div className="grid gap-2">
									<p className="text-micro text-muted-foreground">{t("config.dsh.pluginsHint")}</p>
									{pluginNamespaces.length === 0 ? (
										<Empty text={t("config.dsh.namespacesEmpty")} />
									) : (
										<div className="grid gap-2">
											{pluginNamespaces.map((ns) => (
												<PluginCard key={ns.ns} ns={ns} writable={writable} onSave={(patch) => saveNamespace(ns.ns, patch)} sectionApi={sectionApi} />
											))}
										</div>
									)}
								</div>
								{/* G13 深化：动态 Cordis 插件管理（define/run/stop/undefine）+ 静态 Loader 只读清单 */}
								<DshPluginSection />
							</div>
						</div>
						<div hidden={activeTab !== "security"}>
							<div className="p-4">
								<SecurityTab namespace={permissionNamespace} writable={writable} onSave={(patch) => saveNamespace("permission", patch)} onChanged={() => void load()} sectionApi={sectionApi} />
							</div>
						</div>
						<div hidden={activeTab !== "auth"}>
							<div className="p-4">
								<AuthTab refs={credentialRefs} credentials={credentials} onSetKey={setDshKey} onUnsetKey={unsetDshKey} sectionApi={sectionApi} />
							</div>
						</div>
						<div hidden={activeTab !== "raw"}>
							<div className="p-4">
								<RawTab homeDir={status?.homeDir ?? ""} sectionApi={sectionApi} />
							</div>
						</div>
					</>
				)}
			</div>
		</div>
	);
});

function Overview(props: {
	status: DshStatus | null;
	hasDocument: boolean;
	onOpenFolder: (path: string) => void;
	onOpenDocument: () => void;
	onChanged: () => void;
}) {
	const { status } = props;
	const [picking, setPicking] = useState(false);
	const [switching, setSwitching] = useState(false);
	/** 孤儿 DSH 会话数（G3/D11：host 有但 catalog 无映射；加载概览时查询一次）。 */
	const [orphanCount, setOrphanCount] = useState(0);
	/** 外部 DSH 会话（dsh-web 等其他工具创建的 host 根会话；跨工具导入用，2026-12）。 */
	const [foreignSessions, setForeignSessions] = useState<Array<{
		dshSessionId: string;
		title?: string;
		cwd?: string;
		updatedAt?: number;
	}>>([]);
	/** 正在导入的 dshSessionId（按钮转圈防重复点击）。 */
	const [importing, setImporting] = useState<string | null>(null);
	/** 全量同步进行中（「全部导入」按钮转圈防重复触发）。 */
	const [syncing, setSyncing] = useState(false);
	/** G14：归档区 DSH 会话清单（目录已移入 .pideck-archive 的 host 会话；恢复入口用）。 */
	const [archived, setArchived] = useState<Array<{ dshSessionId: string; cwd: string; archivedAt: number }>>([]);
	/** G14：正在恢复的 dshSessionId（按钮转圈防重复点击）。 */
	const [restoring, setRestoring] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void desktopApi.sessions.listDshOrphans().then((ids) => {
			if (!cancelled) setOrphanCount(ids.length);
		}).catch(() => undefined);
		void desktopApi.sessions.listDshForeignSessions().then((items) => {
			if (!cancelled) setForeignSessions(items);
		}).catch(() => undefined);
		void desktopApi.sessions.listArchivedDshSessions().then((items) => {
			if (!cancelled) setArchived(items);
		}).catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	/** 跨工具导入：把外部 DSH 会话映射进 catalog（主进程按 cwd 匹配项目）。 */
	const importForeign = async (dshSessionId: string) => {
		if (importing) return;
		setImporting(dshSessionId);
		try {
			await desktopApi.sessions.importDshForeignSession(dshSessionId);
			showNotice(t("config.dsh.imported"), 3000);
			setForeignSessions((current) => current.filter((item) => item.dshSessionId !== dshSessionId));
			setOrphanCount((current) => Math.max(0, current - 1));
			props.onChanged();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setImporting(null);
		}
	};

	/** 全量同步：把 catalog 尚未映射的外部 DSH 会话一次全部导入（host-ready 也会自动执行）。 */
	const syncAllForeign = async () => {
		if (syncing) return;
		setSyncing(true);
		try {
			const result = await desktopApi.sessions.syncDshForeignSessions();
			showNotice(t("config.dsh.synced", { count: result.imported }), 3000);
			// 已导入的从清单消失（主进程按 catalog 过滤）；孤儿/清单重拉保持最新。
			const [items, orphanIds] = await Promise.all([
				desktopApi.sessions.listDshForeignSessions(),
				desktopApi.sessions.listDshOrphans(),
			]);
			setForeignSessions(items);
			setOrphanCount(orphanIds.length);
			props.onChanged();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setSyncing(false);
		}
	};

	/** G14：恢复归档的 DSH 会话（主进程移回 sessions 树并重建 catalog 记录）。 */
	const restoreArchived = async (dshSessionId: string) => {
		if (restoring) return;
		setRestoring(dshSessionId);
		try {
			await desktopApi.sessions.unarchiveDshSession(dshSessionId);
			showNotice(t("config.dsh.restored"), 3000);
			setArchived((current) => current.filter((item) => item.dshSessionId !== dshSessionId));
			props.onChanged();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setRestoring(null);
		}
	};

	/**
	 * 切换 DSH_HOME 目录：选目录 → 写设置 → 立即重启 host 生效。
	 * 主进程 restartDshHost 会先自动停掉活跃 DSH 会话（catalog 保留，重新打开时 attach）。
	 */
	const pickHomeDir = async () => {
		if (picking) return;
		setPicking(true);
		try {
			const picked = await desktopApi.dialog.pickFiles({ title: t("config.dsh.pickHomeTitle"), includeDirectories: true });
			const dir = picked?.[0];
			if (!dir) return;
			setSwitching(true);
			await desktopApi.settings.update({ dshHomeDir: dir });
			if (status?.started) {
				const restarted = await desktopApi.sessions.restartDshHost();
				if (restarted) {
					showNotice(t("config.dsh.homeChangeApplied"), 4000);
				} else {
					// 兑底：stopAll/restart 异常（正常路径不会走到这里）
					showNotice(t("config.dsh.homeChangeFailed"), 6000);
				}
			} else {
				showNotice(t("config.dsh.homeChangeNextBoot"), 4000);
			}
			props.onChanged();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setPicking(false);
			setSwitching(false);
		}
	};

	/** 恢复默认：清空 dshHomeDir，回到自动解析（~/.dsh 优先，不存在则应用私有目录）。 */
	const resetHomeDir = async () => {
		setSwitching(true);
		try {
			await desktopApi.settings.update({ dshHomeDir: "" });
			if (status?.started) {
				const restarted = await desktopApi.sessions.restartDshHost();
				showNotice(restarted
					? t("config.dsh.homeResetApplied")
					: t("config.dsh.homeChangeFailed"), restarted ? 4000 : 6000);
			} else {
				showNotice(t("config.dsh.homeReset"), 4000);
			}
			props.onChanged();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setSwitching(false);
		}
	};

	return (
		<div className="grid max-w-2xl gap-4 p-4">
			<section className="grid gap-2">
				<h3 className="flex items-center gap-2 text-caption font-semibold text-muted-foreground">
					<DshLogo className="size-4" />
					{t("config.dsh.title")}
				</h3>
				<div className="flex items-center gap-2">
					{status?.started ? (
						<span className="rounded-full border border-emerald-300/70 bg-emerald-500/10 px-2 py-0.5 text-micro font-medium text-emerald-700 dark:border-emerald-700/70 dark:text-emerald-300">
							{t("config.dsh.started")}
						</span>
					) : (
						<span className="rounded-full border border-border-subtle px-2 py-0.5 text-micro text-muted-foreground">
							{t("config.dsh.notStarted")}
						</span>
					)}
					{orphanCount > 0 && (
						<span
							className="rounded-full border border-amber-300/70 bg-amber-500/10 px-2 py-0.5 text-micro font-medium text-amber-700 dark:border-amber-700/70 dark:text-amber-300"
							title={t("config.dsh.orphans", { count: orphanCount })}
						>
							{t("config.dsh.orphans", { count: orphanCount })}
						</span>
					)}
				</div>
			</section>
			{/* 跨工具兼容（2026-12）：dsh-web 等其他工具创建的 host 会话，导入后侧栏可见可加载。
			    host-ready 自动导入默认开启（设置 dshAutoImportSessions 关闭）；此处仅剩手动补漏 */}
			<section className="grid gap-2">
				<div className="flex items-center gap-2">
					<h3 className="text-caption font-semibold text-muted-foreground">{t("config.dsh.foreignSessions")}</h3>
					<Button
						type="button"
						variant="secondary"
						size="sm"
						className="ml-auto h-7 gap-1"
						disabled={syncing}
						onClick={() => void syncAllForeign()}
					>
						{syncing ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="size-3.5" aria-hidden="true" />}
						{t("config.dsh.syncAll")}
					</Button>
				</div>
				{foreignSessions.length === 0 ? (
					<p className="text-micro text-muted-foreground">{t("config.dsh.foreignSessionsEmpty")}</p>
				) : (
					<>
						<p className="text-micro text-muted-foreground">{t("config.dsh.foreignSessionsHint")}</p>
						<div className="grid max-h-56 gap-1.5 overflow-y-auto pr-1">
							{foreignSessions.map((item) => (
								<div
									key={item.dshSessionId}
									className="flex items-center gap-2 rounded-sm border border-border-subtle bg-bg-panel px-2.5 py-1.5"
								>
									<div className="min-w-0 flex-1">
										<div className="truncate text-control text-foreground" title={item.title ?? item.dshSessionId}>
											{item.title ?? item.dshSessionId}
										</div>
										{item.cwd && (
											<div className="truncate font-mono text-micro text-muted-foreground" title={item.cwd}>
												{item.cwd}
											</div>
										)}
									</div>
									<Button
										type="button"
										variant="secondary"
										size="sm"
										className="h-7 shrink-0 gap-1"
										disabled={importing !== null}
										onClick={() => void importForeign(item.dshSessionId)}
									>
										{importing === item.dshSessionId ? (
											<LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
										) : null}
										{t("config.dsh.importSession")}
									</Button>
								</div>
							))}
						</div>
					</>
				)}
			</section>
			<section className="grid gap-2">
				<h3 className="text-caption font-semibold text-muted-foreground">{t("config.dsh.directories")}</h3>
				{/* DSH_HOME 即唯一配置目录：settings.yaml / .credentials.yaml / sessions / storages 全在同一目录 */}
				<DirRow label={t("config.dsh.homeDir")} path={status?.homeDir ?? ""} onOpen={props.onOpenFolder} />
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="secondary"
						size="sm"
						className="h-7"
						disabled={picking || switching}
						onClick={() => void pickHomeDir()}
					>
						{picking ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <FolderOpen className="size-3.5" aria-hidden="true" />}
						{t("config.dsh.changeHome")}
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 text-muted-foreground"
						disabled={switching}
						onClick={() => void resetHomeDir()}
					>
						{t("config.dsh.resetHome")}
					</Button>
				</div>
				<p className="text-micro text-muted-foreground">{t("config.dsh.homeHint")}</p>
			</section>
			{/* G14：DSH 归档区（归档动作在会话列表右键；恢复入口在这里） */}
			<section className="grid gap-2">
				<h3 className="text-caption font-semibold text-muted-foreground">{t("config.dsh.archived")}</h3>
				{archived.length === 0 ? (
					<p className="text-micro text-muted-foreground">{t("config.dsh.archivedEmpty")}</p>
				) : (
					<div className="grid gap-1.5">
						{archived.map((item) => (
							<div
								key={item.dshSessionId}
								className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-panel px-2 py-1.5"
							>
								<span className="min-w-0 flex-1 truncate text-control text-foreground" title={item.cwd}>
									<span className="font-medium">{item.dshSessionId}</span>
									<span className="ml-2 text-caption text-text-secondary">{item.cwd}</span>
								</span>
								<Button
									type="button"
									variant="secondary"
									size="sm"
									className="h-6 shrink-0"
									disabled={restoring === item.dshSessionId}
									onClick={() => void restoreArchived(item.dshSessionId)}
								>
									{restoring === item.dshSessionId
										? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
										: <ArchiveRestore className="size-3.5" aria-hidden="true" />}
									{t("config.dsh.restore")}
								</Button>
							</div>
						))}
					</div>
				)}
				<p className="text-micro text-muted-foreground">{t("config.dsh.archivedHint")}</p>
			</section>
			{props.hasDocument && (
				<section>
					<Button type="button" variant="secondary" size="sm" onClick={props.onOpenDocument}>
						<FolderOpen className="size-3.5" aria-hidden="true" />
						{t("config.dsh.openDocument")}
					</Button>
				</section>
			)}
			<p className="text-micro text-muted-foreground">{t("config.dsh.overviewHint")}</p>
		</div>
	);
}

/** settings.openDocument：让 host 把配置文档交给平台打开。 */
function openDocument() {
	void desktopApi.sessions.openDshDocument?.().catch(() => undefined);
}

type DshAgentPreset = {
	id: string;
	trust: "system" | "user";
	isDefault: boolean;
	name?: string;
	description?: string;
	broken?: string;
};

/**
 * 插件配置卡片（对齐 dsh-web 的插件设置分区）：收起时一行展示插件名称与
 * 生效方式，点击展开后才渲染该插件命名空间的配置表单；避免一进来就是
 * 一堆输入框。卡片持有自己的展开状态与表单草稿（收起再展开不丢草稿）。
 */
function PluginCard(props: {
	ns: DshNamespaceView;
	writable: boolean;
	onSave: (patch: Record<string, unknown>) => Promise<void>;
	sectionApi?: DshSectionApi;
}) {
	const [open, setOpen] = useState(false);
	// G13：已知插件走 i18n 标题；host 新注册的插件命名空间回退显示 ns 原名
	const titleKey = dshPluginNamespaceTitleKey(props.ns.ns);
	return (
		<div className="rounded-md border border-border-subtle bg-bg-panel">
			<button
				type="button"
				className="flex w-full items-center gap-1.5 px-3.5 py-2.5 text-left"
				onClick={() => setOpen((prev) => !prev)}
			>
				{open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
				<span className="min-w-0 flex-1 truncate text-caption font-semibold text-foreground">{titleKey ? t(titleKey) : props.ns.ns}</span>
				<span className="shrink-0 rounded-full border border-border-subtle px-2 py-0.5 text-micro text-muted-foreground">
					{props.ns.applies === "live" ? t("config.dsh.appliesLive") : t("config.dsh.appliesRestart")}
				</span>
			</button>
			{open && (
				<div className="border-t border-border/40">
					<DshSchemaForm namespace={props.ns} writable={props.writable} onSave={props.onSave} sectionApi={props.sectionApi} />
				</div>
			)}
		</div>
	);
}

/**
 * 预设设置 tab（对齐 dsh-web 的 agent preset 选择/管理）：列出 host 可组合的会话
 * Agent 预设（standard/code/minimal/cordis 等），标记当前默认，并支持把任一预设
 * 设为新会话默认（写入 settings 文档的 agent-presets.default，与 dsh-web 的
 * General 设置行同一写入目标；仅对之后新建的会话生效，运行中会话保持原组合）。
 * 保存语义与 Pi 管理页一致：点击「设为默认」只暂存选择，由顶部统一保存提交。
 */
function PresetsTab(props: {
	writable: boolean;
	namespace?: DshNamespaceView;
	onSave: (id: string) => Promise<void>;
	sectionApi?: DshSectionApi;
}) {
	const instanceId = useId();
	const [presets, setPresets] = useState<DshAgentPreset[]>([]);
	const [loading, setLoading] = useState(true);
	/** 暂存的新默认预设 id（未保存；顶部统一保存时提交）。 */
	const [pendingDefault, setPendingDefault] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const reload = useCallback(async () => {
		try {
			const list = await desktopApi.sessions.listDshAgentPresets();
			setPresets(list);
			setLoading(false);
		} catch {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		let cancelled = false;
		void desktopApi.sessions.listDshAgentPresets().then((list) => {
			if (!cancelled) {
				setPresets(list);
				setLoading(false);
			}
		}).catch(() => {
			if (!cancelled) setLoading(false);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const dirty = pendingDefault !== null;
	useEffect(() => {
		props.sectionApi?.onDirtyChange(instanceId, dirty);
		// 卸载时清掉本实例的脏来源，避免收起/切换后残留黄点
		return () => props.sectionApi?.onDirtyChange(instanceId, false);
	}, [props.sectionApi, instanceId, dirty]);

	/** 统一保存：提交暂存的新默认预设（settings 文档，host 热重载）。 */
	const save = useCallback(async (): Promise<boolean> => {
		if (pendingDefault === null) return true;
		setSaving(true);
		try {
			await props.onSave(pendingDefault);
			setPendingDefault(null);
			await reload();
			return true;
		} catch (error) {
			showNotice(error instanceof Error ? error.message : t("config.dsh.presetSetDefaultFailed"), 4000);
			return false;
		} finally {
			setSaving(false);
		}
	}, [pendingDefault, props, reload]);
	useEffect(() => {
		if (!props.sectionApi) return;
		props.sectionApi.registerSave(instanceId, save);
		return () => props.sectionApi?.unregisterSave(instanceId);
	}, [props.sectionApi, instanceId, save]);

	if (loading) {
		return (
			<div className="flex min-h-32 items-center justify-center gap-2 text-control text-muted-foreground">
				<LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
				{t("common.loading")}
			</div>
		);
	}
	return (
		<div className="grid max-w-2xl gap-4">
			<p className="text-micro text-muted-foreground">{t("config.dsh.presetsHint")}</p>
			{presets.length === 0 ? (
				<Empty text={t("config.dsh.presetsEmpty")} />
			) : (
				presets.map((preset) => {
					const name = presetDisplayName(preset, t);
					const description = presetDisplayDescription(preset, t);
					const canSetDefault = props.writable && !preset.broken;
					const isPending = pendingDefault === preset.id;
					const isDefault = preset.isDefault || isPending;
					return (
						<section key={preset.id} className="rounded-md border border-border-subtle bg-bg-panel px-3.5 py-2.5">
							<div className="flex items-center gap-2">
								<span className="min-w-0 flex-1 truncate font-mono text-control font-semibold text-foreground">{name}</span>
								{isDefault && (
									<span className="rounded-full border border-emerald-300/70 bg-emerald-500/10 px-2 py-0.5 text-micro font-medium text-emerald-700 dark:border-emerald-700/70 dark:text-emerald-300">
										{t("config.dsh.presetDefault")}
									</span>
								)}
								<span className={`rounded-full border border-border-subtle px-2 py-0.5 text-micro ${preset.trust === "user" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
									{t(preset.trust === "user" ? "config.dsh.presetUser" : "config.dsh.presetSystem")}
								</span>
								{canSetDefault && (
									<Button
										type="button"
										variant="secondary"
										size="sm"
										className="h-7"
										disabled={saving}
										onClick={() => setPendingDefault(isPending ? null : preset.id)}
									>
										{isPending ? t("config.dsh.presetPending") : t("config.dsh.presetSetDefault")}
									</Button>
								)}
							</div>
							{description && <p className="mt-1 text-micro text-muted-foreground">{description}</p>}
							{preset.broken && <p className="mt-1 text-micro text-danger">{t("config.dsh.presetBroken", { reason: preset.broken })}</p>}
							{!props.writable && !preset.isDefault && (
								<p className="mt-1 text-micro text-muted-foreground">{t("config.dsh.presetNotWritable")}</p>
							)}
						</section>
					);
				})
			)}
		</div>
	);
}

/**
 * 安全 tab（对齐 dsh-web 的 permission 预设）：新会话默认权限预设
 * （read-only / workspace-write / danger-full-access，sandbox + approval 捆绑）
 * + PiDeck 侧的审批自动放行开关（仅影响本应用内的 DSH 会话）。
 * 默认预设保存与 Pi 管理页一致：草稿暂存，顶部统一保存提交；
 * autoAllow 是 PiDeck 运行时开关，即时生效不入统一保存。
 */
function SecurityTab(props: {
	namespace?: DshNamespaceView;
	writable: boolean;
	onSave: (patch: Record<string, unknown>) => Promise<void>;
	onChanged: () => void;
	sectionApi?: DshSectionApi;
}) {
	const instanceId = useId();
	const [draft, setDraft] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [autoAllow, setAutoAllow] = useState(false);
	const [autoAllowLoaded, setAutoAllowLoaded] = useState(false);

	useEffect(() => {
		void desktopApi.settings
			.get()
			.then((settings) => {
				setAutoAllow(settings.dshApprovalAutoAllow === true);
				setAutoAllowLoaded(true);
			})
			.catch(() => setAutoAllowLoaded(true));
	}, []);

	/** 切换审批自动放行：乐观更新 UI，写设置失败回滚。运行时读取、无需重启 host。 */
	const toggleAutoAllow = async (checked: boolean) => {
		const prev = autoAllow;
		setAutoAllow(checked);
		try {
			await desktopApi.settings.update({ dshApprovalAutoAllow: checked });
			showNotice(t(checked ? "config.dsh.autoAllowOn" : "config.dsh.autoAllowOff"), 3000);
		} catch (saveError) {
			setAutoAllow(prev);
			showNotice(saveError instanceof Error ? saveError.message : String(saveError), 4000);
		}
	};

	const value = props.namespace?.value as { defaultPreset?: unknown } | undefined;
	const currentDefault = typeof value?.defaultPreset === "string" ? value.defaultPreset : undefined;
	const selected = draft ?? currentDefault;

	const dirty = draft !== null;
	useEffect(() => {
		props.sectionApi?.onDirtyChange(instanceId, dirty);
		// 卸载时清掉本实例的脏来源，避免收起/切换后残留黄点
		return () => props.sectionApi?.onDirtyChange(instanceId, false);
	}, [props.sectionApi, instanceId, dirty]);

	/** 统一保存：提交新会话默认权限预设。 */
	const save = useCallback(async (): Promise<boolean> => {
		if (!draft) return true;
		setSaving(true);
		setError(null);
		try {
			await props.onSave({ defaultPreset: draft });
			setDraft(null);
			props.onChanged();
			return true;
		} catch (saveError) {
			setError(saveError instanceof Error ? saveError.message : String(saveError));
			return false;
		} finally {
			setSaving(false);
		}
	}, [draft, props]);
	useEffect(() => {
		if (!props.sectionApi) return;
		props.sectionApi.registerSave(instanceId, save);
		return () => props.sectionApi?.unregisterSave(instanceId);
	}, [props.sectionApi, instanceId, save]);

	return (
		<div className="grid max-w-2xl gap-4">
			<p className="text-micro text-muted-foreground">{t("config.dsh.securityHint")}</p>
			<section className="rounded-md border border-border-subtle bg-bg-panel">
				<div className="flex items-center gap-2 border-b border-border/40 px-4 py-2">
					<span className="text-caption font-semibold text-foreground">{t("config.dsh.securityDefaultPreset")}</span>
					{error && <span className="max-w-64 truncate text-micro text-danger" title={error}>{error}</span>}
					{dirty && <span className="ml-auto text-micro text-amber-500" title={t("config.dirtyTooltip")}>●</span>}
					{saving && <span className="ml-auto text-micro text-muted-foreground">{t("common.saving")}</span>}
				</div>
				<div className="grid gap-3 p-4">
					<Select value={selected ?? ""} disabled={!props.writable} onValueChange={(next) => setDraft(next)}>
						<SelectTrigger size="sm" className="h-8 w-72">
							<SelectValue placeholder={t("config.dsh.selectPlaceholder")} />
						</SelectTrigger>
						<SelectContent>
							{DSH_PERMISSION_PRESETS.map((preset) => (
								<SelectItem key={preset.id} value={preset.id}>
									<span className="font-medium">{t(preset.labelKey)}</span>
									<span className="ml-2 text-micro text-muted-foreground">{t(preset.descriptionKey)}</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<div className="grid gap-1.5">
						{DSH_PERMISSION_PRESETS.map((preset) => (
							<div key={preset.id} className="flex items-baseline gap-2 text-micro text-muted-foreground">
								<span className="w-28 shrink-0 font-mono text-caption text-foreground/80">{t(preset.labelKey)}</span>
								<span>{t(preset.descriptionKey)}</span>
							</div>
						))}
					</div>
				</div>
			</section>
			<section className="rounded-md border border-border-subtle bg-bg-panel px-3.5 py-2.5">
				<div className="flex items-center justify-between gap-4">
					<div className="grid gap-0.5">
						<span className="text-caption font-semibold text-foreground">{t("config.dsh.approvals")}</span>
						<p className="text-micro text-muted-foreground">{t("config.dsh.autoAllowApprovalHint")}</p>
					</div>
					<Switch checked={autoAllow} disabled={!autoAllowLoaded} onCheckedChange={(checked) => void toggleAutoAllow(checked)} />
				</div>
			</section>
		</div>
	);
}

function AuthTab(props: {
	refs: string[];
	credentials: Record<string, CredentialState>;
	onSetKey: (ref: string, value: string) => Promise<void>;
	onUnsetKey: (ref: string) => Promise<void>;
	sectionApi?: DshSectionApi;
}) {
	const instanceId = useId();
	const [values, setValues] = useState<Record<string, string>>({});
	/** 待清除的凭证 ref 集合（顶部统一保存时执行 unset）。 */
	const [pendingUnsets, setPendingUnsets] = useState<Set<string>>(new Set());
	const [revealed, setRevealed] = useState<Record<string, boolean>>({});
	const [busyRef, setBusyRef] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	/** 脏状态：任一凭证草稿非空或存在待清除项。 */
	const dirty = Object.values(values).some((value) => value.trim()) || pendingUnsets.size > 0;
	useEffect(() => {
		props.sectionApi?.onDirtyChange(instanceId, dirty);
		// 卸载时清掉本实例的脏来源，避免收起/切换后残留黄点
		return () => props.sectionApi?.onDirtyChange(instanceId, false);
	}, [props.sectionApi, instanceId, dirty]);

	/** 统一保存：先逐条 set 草稿密钥，再逐条 unset 待清除项；全部成功返回 true。 */
	const save = useCallback(async (): Promise<boolean> => {
		if (!dirty) return true;
		setSaving(true);
		setError(null);
		try {
			for (const [ref, value] of Object.entries(values)) {
				const trimmed = value.trim();
				if (trimmed) await props.onSetKey(ref, trimmed);
			}
			for (const ref of pendingUnsets) {
				await props.onUnsetKey(ref);
			}
			setValues({});
			setPendingUnsets(new Set());
			setRevealed({});
			return true;
		} catch (saveError) {
			setError(saveError instanceof Error ? saveError.message : String(saveError));
			return false;
		} finally {
			setSaving(false);
		}
	}, [dirty, values, pendingUnsets, props]);
	useEffect(() => {
		if (!props.sectionApi) return;
		props.sectionApi.registerSave(instanceId, save);
		return () => props.sectionApi?.unregisterSave(instanceId);
	}, [props.sectionApi, instanceId, save]);

	/** 眼睛切换：显示时按 ref 取回明文（无值则仅切换输入框类型），隐藏时清空输入。 */
	const toggleReveal = async (ref: string, configured: boolean) => {
		if (revealed[ref]) {
			setRevealed((prev) => ({ ...prev, [ref]: false }));
			setValues((prev) => ({ ...prev, [ref]: "" }));
			return;
		}
		if (!values[ref] && configured) {
			setBusyRef(ref);
			try {
				const stored = await desktopApi.sessions.readDshCredential(ref);
				if (stored !== undefined) setValues((prev) => ({ ...prev, [ref]: stored }));
			} catch {
				// 读取失败：仅切换输入框类型，不阻断
			} finally {
				setBusyRef(null);
			}
		}
		setRevealed((prev) => ({ ...prev, [ref]: true }));
	};

	/** 复制明文到剪贴板（草稿优先，否则读存储值）。 */
	const copyValue = async (ref: string, configured: boolean) => {
		setBusyRef(ref);
		try {
			let plain = values[ref]?.trim();
			if (!plain && configured) {
				plain = (await desktopApi.sessions.readDshCredential(ref))?.trim() ?? "";
			}
			if (plain) {
				await writeClipboard(plain);
				showNotice(t("config.dsh.keyCopied"), 2000);
			}
		} catch {
			// 复制失败静默（writeClipboard 内部已有兜底）
		} finally {
			setBusyRef(null);
		}
	};

	/** 切换待清除标记（顶部统一保存时 unset）。 */
	const toggleUnset = (ref: string) => {
		setPendingUnsets((prev) => {
			const next = new Set(prev);
			if (next.has(ref)) next.delete(ref);
			else next.add(ref);
			return next;
		});
	};

	if (props.refs.length === 0) {
		return <Empty text={t("config.dsh.credentialsEmpty")} />;
	}

	return (
		<div className="grid max-w-2xl gap-2">
			<p className="mb-1 text-micro text-muted-foreground">{t("config.dsh.authHint")}</p>
			{error && <p className="text-micro text-danger">{error}</p>}
			{dirty && <p className="text-micro text-amber-500">{t("config.dsh.unsavedHint")}</p>}
			{props.refs.map((ref) => {
				const state = props.credentials[ref];
				const isRevealed = revealed[ref] ?? false;
				const pendingUnset = pendingUnsets.has(ref);
				return (
					<div key={ref} className={`rounded-sm border bg-bg-panel px-3 py-2.5 ${pendingUnset ? "border-danger/40" : "border-border-subtle"}`}>
						<div className="flex items-center gap-2">
							<span className="min-w-0 flex-1 truncate font-mono text-control font-medium text-foreground">{ref}</span>
							{pendingUnset && (
								<span className="rounded-full border border-danger/40 bg-danger/10 px-1.5 py-px text-micro text-danger">
									{t("config.dsh.credentialPendingUnset")}
								</span>
							)}
							{state?.configured ? (
								<span className="rounded-full border border-emerald-300/70 bg-emerald-500/10 px-1.5 py-px text-micro text-emerald-700 dark:border-emerald-700/70 dark:text-emerald-300">
									{t("config.dsh.credentialConfigured", { source: state.source ?? "file" })}
								</span>
							) : (
								<span className="rounded-full border border-border-subtle px-1.5 py-px text-micro text-muted-foreground">
									{t("config.dsh.credentialUnset")}
								</span>
							)}
						</div>
						<div className="mt-2 flex items-center gap-2">
							<div className="relative max-w-sm flex-1">
								<Input
									className="h-8 w-full pr-16 font-mono"
									type={isRevealed ? "text" : "password"}
									placeholder={t("config.dsh.credentialValuePlaceholder")}
									value={values[ref] ?? ""}
									disabled={state?.writable === false || busyRef === ref || saving}
									onChange={(event) => setValues((prev) => ({ ...prev, [ref]: event.target.value }))}
								/>
								<div className="absolute inset-y-0 right-0.5 my-auto flex items-center gap-0.5">
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										className="size-7 text-muted-foreground"
										title={t("config.dsh.keyCopy")}
										aria-label={t("config.dsh.keyCopy")}
										disabled={!state?.configured || busyRef === ref}
										onClick={() => void copyValue(ref, state?.configured === true)}
									>
										<Copy className="size-3.5" aria-hidden="true" />
									</Button>
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										className="size-7 text-muted-foreground"
										title={isRevealed ? t("config.dsh.keyHide") : t("config.dsh.keyReveal")}
										aria-label={isRevealed ? t("config.dsh.keyHide") : t("config.dsh.keyReveal")}
										disabled={!state?.configured || busyRef === ref}
										onClick={() => void toggleReveal(ref, state?.configured === true)}
									>
										{isRevealed ? <EyeOff className="size-3.5" aria-hidden="true" /> : <Eye className="size-3.5" aria-hidden="true" />}
									</Button>
								</div>
							</div>
							{state?.configured && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className={`h-8 shrink-0 ${pendingUnset ? "text-danger" : "text-muted-foreground hover:text-danger"}`}
									title={t("config.dsh.credentialUnset")}
									disabled={state?.writable === false || busyRef === ref || saving}
									onClick={() => toggleUnset(ref)}
								>
									{pendingUnset ? t("config.dsh.credentialPendingUnset") : t("config.dsh.keyUnset")}
								</Button>
							)}
						</div>
					</div>
				);
			})}
		</div>
	);
}

const RAW_FILES = ["settings.yaml", ".credentials.yaml"];

/** 源文件 tab：与 Pi 管理 RawTab 同款——顶部文件下拉 + 编辑器。
 *  保存语义与 Pi 管理页一致：草稿变化上报脏状态，顶部统一保存提交。 */
function RawTab(props: { homeDir: string; sectionApi?: DshSectionApi }) {
	const instanceId = useId();
	const [fileName, setFileName] = useState(RAW_FILES[0]);
	const [content, setContent] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);

	// 脏状态上报（顶部统一保存/关闭确认）
	useEffect(() => {
		props.sectionApi?.onDirtyChange(instanceId, dirty);
		// 卸载时清掉本实例的脏来源，避免收起/切换后残留黄点
		return () => props.sectionApi?.onDirtyChange(instanceId, false);
	}, [props.sectionApi, instanceId, dirty]);

	/** 统一保存：写当前文件；成功返回 true。 */
	const save = useCallback(async (): Promise<boolean> => {
		if (!dirty) return true;
		setSaving(true);
		try {
			const filePath = joinConfigPath(props.homeDir, fileName);
			await desktopApi.files.writeContent(filePath, content);
			setDirty(false);
			return true;
		} catch (error) {
			console.error(`[dsh-config] write ${fileName} failed:`, error);
			return false;
		} finally {
			setSaving(false);
		}
	}, [dirty, content, fileName, props.homeDir]);
	useEffect(() => {
		if (!props.sectionApi) return;
		props.sectionApi.registerSave(instanceId, save);
		return () => props.sectionApi?.unregisterSave(instanceId);
	}, [props.sectionApi, instanceId, save]);

	// 切换文件/目录时重新加载
	useEffect(() => {
		if (!props.homeDir) return;
		let cancelled = false;
		setLoaded(false);
		setDirty(false);
		const filePath = joinConfigPath(props.homeDir, fileName);
		void desktopApi.files.readContent(filePath)
			.then((next) => {
				if (!cancelled) {
					setContent(next);
					setLoaded(true);
				}
			})
			.catch(() => {
				// 文件不存在时保持空编辑器
				if (!cancelled) {
					setContent("");
					setLoaded(true);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [props.homeDir, fileName]);

	return (
		<div className="grid max-w-3xl gap-3">
			<div className="flex items-center gap-2">
				<Select value={fileName} onValueChange={setFileName}>
					<SelectTrigger size="sm" className="h-8 w-48 font-mono">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{RAW_FILES.map((name) => (
							<SelectItem key={name} value={name} className="font-mono">{name}</SelectItem>
						))}
					</SelectContent>
				</Select>
				{dirty && <span className="size-2 rounded-full bg-amber-400" aria-hidden="true" />}
				{saving && <span className="text-micro text-muted-foreground">{t("common.saving")}</span>}
			</div>
			{loaded ? (
				<textarea
					className="h-[480px] w-full resize-y rounded-md border border-border-subtle bg-bg-panel p-3 font-mono text-micro text-foreground outline-none"
					value={content}
					spellCheck={false}
					onChange={(event) => {
						setContent(event.target.value);
						setDirty(true);
					}}
				/>
			) : (
				<div className="flex h-72 items-center justify-center text-control text-muted-foreground">
					{t("common.loading")}
				</div>
			)}
			<div className="text-micro text-muted-foreground">
				{t("config.dsh.rawHint", { dir: props.homeDir })}
			</div>
		</div>
	);
}

function DirRow(props: { label: string; path: string; onOpen: (path: string) => void }) {
	return (
		<div className="flex items-center gap-2 rounded-sm border border-border-subtle bg-bg-panel px-3 py-2">
			<span className="shrink-0 text-caption text-muted-foreground">{props.label}</span>
			<span className="min-w-0 flex-1 truncate font-mono text-micro text-foreground" title={props.path}>
				{props.path || "—"}
			</span>
			{props.path && (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-7 shrink-0 rounded-md px-2 text-control"
					onClick={() => props.onOpen(props.path)}
				>
					{t("config.dsh.openFolder")}
				</Button>
			)}
		</div>
	);
}

function Empty(props: { text: string }) {
	return (
		<div className="rounded-sm border border-border-subtle bg-bg-panel px-3.5 py-8 text-center text-control text-muted-foreground">
			{props.text}
		</div>
	);
}
