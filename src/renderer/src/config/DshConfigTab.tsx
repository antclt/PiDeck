import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
	Blocks,
	Cpu,
	FileCode2,
	FolderOpen,
	KeyRound,
	LayoutDashboard,
	LoaderCircle,
	Puzzle,
	Settings2,
	ShieldCheck,
	Trash2,
} from "lucide-react";
import { desktopApi } from "../desktopApi";
import { t, type TranslationKey } from "../i18n";
import { showNotice } from "../utils/notice";
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
import { DshSchemaForm, type DshNamespaceView } from "./DshSchemaForm";
import { DeepseekRouteCard, PiAiProvidersCard } from "./DshProviderCards";
import { collectCredentialRefsWithValue, normalizeDshSchema } from "./dshSchema";

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

/** 插件配置相关的 namespace（与 dsh-web 插件配置页同源的 host 平面分节）。 */
const PLUGIN_NS: Array<{ ns: string; titleKey: TranslationKey }> = [
	{ ns: "agent-loop", titleKey: "config.dsh.pluginAgentLoop" },
	{ ns: "shell", titleKey: "config.dsh.pluginShell" },
	{ ns: "web-search-deepseek", titleKey: "config.dsh.pluginWebSearch" },
];

const NAV_ITEMS: Array<{ id: string; labelKey: TranslationKey; icon: ReactNode }> = [
	{ id: "overview", labelKey: "config.dsh.tab.overview", icon: <LayoutDashboard className="size-3.5" aria-hidden="true" /> },
	{ id: "models", labelKey: "config.dsh.tab.models", icon: <Cpu className="size-3.5" aria-hidden="true" /> },
	{ id: "presets", labelKey: "config.dsh.tab.presets", icon: <Blocks className="size-3.5" aria-hidden="true" /> },
	{ id: "plugins", labelKey: "config.dsh.tab.plugins", icon: <Puzzle className="size-3.5" aria-hidden="true" /> },
	{ id: "security", labelKey: "config.dsh.tab.security", icon: <ShieldCheck className="size-3.5" aria-hidden="true" /> },
	{ id: "auth", labelKey: "config.dsh.tab.auth", icon: <KeyRound className="size-3.5" aria-hidden="true" /> },
	{ id: "settings", labelKey: "config.dsh.tab.settings", icon: <Settings2 className="size-3.5" aria-hidden="true" /> },
	{ id: "raw", labelKey: "config.dsh.tab.raw", icon: <FileCode2 className="size-3.5" aria-hidden="true" /> },
];

/**
 * DSH 配置管理页：左侧竖排导航 + 右侧内容区（与 Pi 管理同款操作逻辑）。
 * 概览 / 模型 / 认证 / 设置 / 源文件；配置读写走 settings.describe（schema 表单）
 * 与 credentials.describe，模型 tab 以 provider 卡片 + 模型行管理 llm-pi-ai。
 */
export function DshConfigTab() {
	const [status, setStatus] = useState<DshStatus | null>(null);
	const [namespaces, setNamespaces] = useState<DshNamespaceView[]>([]);
	const [writable, setWritable] = useState(false);
	const [hasDocument, setHasDocument] = useState(false);
	const [credentialRefs, setCredentialRefs] = useState<string[]>([]);
	const [credentials, setCredentials] = useState<Record<string, CredentialState>>({});
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [activeTab, setActiveTab] = useState("overview");

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
			}
			setCredentialRefs([...refs]);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
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
	// 插件分区：agent-loop / shell / web-search-deepseek（host 平面插件分节）
	const pluginNamespaces = useMemo(
		() => PLUGIN_NS
			.map((entry) => ({ entry, ns: namespaces.find((item) => item.ns === entry.ns) }))
			.filter((item): item is { entry: typeof PLUGIN_NS[number]; ns: NonNullable<typeof item.ns> } => Boolean(item.ns)),
		[namespaces],
	);
	const permissionNamespace = useMemo(
		() => namespaces.find((ns) => ns.ns === "permission"),
		[namespaces],
	);
	// 其余命名空间（目前为空；保留给未来新增的 host 设置）
	const settingNamespaces = useMemo(
		() => namespaces.filter((ns) => !MODEL_NS.has(ns.ns) && ns.ns !== "permission" && !PLUGIN_NS.some((entry) => entry.ns === ns.ns)),
		[namespaces],
	);

	const openFolder = (path: string) => {
		if (path) void desktopApi.files.showInFolder(path).catch(() => undefined);
	};

	const saveNamespace = useCallback(async (ns: string, patch: Record<string, unknown>) => {
		const view = namespaces.find((item) => item.ns === ns);
		await desktopApi.sessions.updateDshSettings(ns, patch, view?.revision);
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
						{activeTab === "overview" && (
							<Overview status={status} hasDocument={hasDocument} onOpenFolder={openFolder} onOpenDocument={openDocument} onChanged={() => { void load(); void loadStatus(); }} />
						)}
						{activeTab === "models" && (
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
														onSave={(patch) => saveNamespace(ns.ns, patch)}
													/>
												) : (
													<DeepseekRouteCard
														namespace={ns}
														writable={writable}
														onSave={(patch) => saveNamespace(ns.ns, patch)}
													/>
												)}
											</section>
										))}
									</div>
								)}
							</div>
						)}
						{activeTab === "presets" && (
							<div className="p-4">
								<PresetsTab />
							</div>
						)}
						{activeTab === "plugins" && (
							<div className="p-4">
								<p className="mb-3 text-micro text-muted-foreground">{t("config.dsh.pluginsHint")}</p>
								{pluginNamespaces.length === 0 ? (
									<Empty text={t("config.dsh.namespacesEmpty")} />
								) : (
									<div className="grid gap-4">
										{pluginNamespaces.map(({ entry, ns }) => (
											<section key={ns.ns} className="rounded-md border border-border-subtle bg-bg-panel">
												<div className="border-b border-border/40 px-4 py-2 text-caption font-semibold text-foreground">
													{t("config.dsh.pluginTitle", { name: t(entry.titleKey) })}
												</div>
												<DshSchemaForm namespace={ns} writable={writable} onSave={(patch) => saveNamespace(ns.ns, patch)} />
											</section>
										))}
									</div>
								)}
							</div>
						)}
						{activeTab === "security" && (
							<div className="p-4">
								<SecurityTab namespace={permissionNamespace} writable={writable} onSave={(patch) => saveNamespace("permission", patch)} onChanged={() => void load()} />
							</div>
						)}
						{activeTab === "auth" && (
							<div className="p-4">
								<AuthTab refs={credentialRefs} credentials={credentials} onChanged={load} />
							</div>
						)}
						{activeTab === "settings" && (
							<div className="p-4">
								<p className="mb-3 text-micro text-muted-foreground">{t("config.dsh.settingsHint")}</p>
								{settingNamespaces.length === 0 ? (
									<Empty text={t("config.dsh.namespacesEmpty")} />
								) : (
									<div className="grid gap-4">
										{settingNamespaces.map((ns) => (
											<section key={ns.ns} className="rounded-md border border-border-subtle bg-bg-panel">
												<DshSchemaForm namespace={ns} writable={writable} onSave={(patch) => saveNamespace(ns.ns, patch)} />
											</section>
										))}
									</div>
								)}
							</div>
						)}
						{activeTab === "raw" && (
							<div className="p-4">
								<RawTab homeDir={status?.homeDir ?? ""} />
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}

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
				</div>
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
 * 预设设置 tab（对齐 dsh-web 的 agent preset 选择）：列出 host 可组合的会话
 * Agent 预设（standard/code/…），标记当前默认（settings.yaml 的 agent-presets.default）。
 * 只读展示——预设的默认选择在 settings.yaml 中（「源文件」tab 可直接编辑）。
 */
function PresetsTab() {
	const [presets, setPresets] = useState<DshAgentPreset[]>([]);
	const [loading, setLoading] = useState(true);

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
				presets.map((preset) => (
					<section key={preset.id} className="rounded-md border border-border-subtle bg-bg-panel px-3.5 py-2.5">
						<div className="flex items-center gap-2">
							<span className="min-w-0 flex-1 truncate font-mono text-control font-semibold text-foreground">{preset.name ?? preset.id}</span>
							{preset.isDefault && (
								<span className="rounded-full border border-emerald-300/70 bg-emerald-500/10 px-2 py-0.5 text-micro font-medium text-emerald-700 dark:border-emerald-700/70 dark:text-emerald-300">
									{t("config.dsh.presetDefault")}
								</span>
							)}
							<span className={`rounded-full border border-border-subtle px-2 py-0.5 text-micro ${preset.trust === "user" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>
								{t(preset.trust === "user" ? "config.dsh.presetUser" : "config.dsh.presetSystem")}
							</span>
						</div>
						{preset.description && <p className="mt-1 text-micro text-muted-foreground">{preset.description}</p>}
						{preset.broken && <p className="mt-1 text-micro text-danger">{t("config.dsh.presetBroken", { reason: preset.broken })}</p>}
					</section>
				))
			)}
		</div>
	);
}

/**
 * 安全 tab（对齐 dsh-web 的 permission 预设）：新会话默认权限预设
 * （read-only / workspace-write / danger-full-access，sandbox + approval 捆绑）
 * + PiDeck 侧的审批自动放行开关（仅影响本应用内的 DSH 会话）。
 */
function SecurityTab(props: {
	namespace?: DshNamespaceView;
	writable: boolean;
	onSave: (patch: Record<string, unknown>) => Promise<void>;
	onChanged: () => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [savedAt, setSavedAt] = useState<number | null>(null);
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

	const handleSave = async () => {
		if (!draft) return;
		setSaving(true);
		setError(null);
		try {
			await props.onSave({ defaultPreset: draft });
			setDraft(null);
			setSavedAt(Date.now());
			props.onChanged();
		} catch (saveError) {
			setError(saveError instanceof Error ? saveError.message : String(saveError));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="grid max-w-2xl gap-4">
			<p className="text-micro text-muted-foreground">{t("config.dsh.securityHint")}</p>
			<section className="rounded-md border border-border-subtle bg-bg-panel">
				<div className="flex items-center gap-2 border-b border-border/40 px-4 py-2">
					<span className="text-caption font-semibold text-foreground">{t("config.dsh.securityDefaultPreset")}</span>
					{savedAt && <span className="text-micro text-emerald-600 dark:text-emerald-400">{t("config.dsh.saved")}</span>}
					{error && <span className="max-w-64 truncate text-micro text-danger" title={error}>{error}</span>}
					<div className="ml-auto flex items-center gap-2">
						<Button
							type="button"
							variant="default"
							size="sm"
							className="h-7"
							disabled={!props.writable || !draft || saving}
							onClick={() => void handleSave()}
						>
							{saving ? t("common.saving") : t("common.save")}
						</Button>
					</div>
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
	onChanged: () => void;
}) {
	const [values, setValues] = useState<Record<string, string>>({});
	const [busyRef, setBusyRef] = useState<string | null>(null);

	const setRef = async (ref: string) => {
		const value = values[ref];
		if (!value) return;
		setBusyRef(ref);
		try {
			await desktopApi.sessions.setDshCredential(ref, value);
			setValues((prev) => ({ ...prev, [ref]: "" }));
			props.onChanged();
		} catch (error) {
			console.error(`[dsh-config] credentials.set ${ref} failed:`, error);
		} finally {
			setBusyRef(null);
		}
	};

	const unsetRef = async (ref: string) => {
		setBusyRef(ref);
		try {
			await desktopApi.sessions.unsetDshCredential(ref);
			props.onChanged();
		} catch (error) {
			console.error(`[dsh-config] credentials.unset ${ref} failed:`, error);
		} finally {
			setBusyRef(null);
		}
	};

	if (props.refs.length === 0) {
		return <Empty text={t("config.dsh.credentialsEmpty")} />;
	}

	return (
		<div className="grid max-w-2xl gap-2">
			<p className="mb-1 text-micro text-muted-foreground">{t("config.dsh.authHint")}</p>
			{props.refs.map((ref) => {
				const state = props.credentials[ref];
				return (
					<div key={ref} className="rounded-sm border border-border-subtle bg-bg-panel px-3 py-2.5">
						<div className="flex items-center gap-2">
							<span className="min-w-0 flex-1 truncate font-mono text-control font-medium text-foreground">{ref}</span>
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
							<Input
								className="h-8 font-mono"
								type="password"
								placeholder={t("config.dsh.credentialValuePlaceholder")}
								value={values[ref] ?? ""}
								disabled={state?.writable === false}
								onChange={(event) => setValues((prev) => ({ ...prev, [ref]: event.target.value }))}
							/>
							<Button
								type="button"
								variant="default"
								size="sm"
								className="h-8 shrink-0"
								disabled={!values[ref] || state?.writable === false || busyRef === ref}
								onClick={() => void setRef(ref)}
							>
								{busyRef === ref ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : t("common.save")}
							</Button>
							{state?.configured && (
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									className="size-8 shrink-0 text-muted-foreground hover:text-danger"
									title={t("config.dsh.credentialUnset")}
									aria-label={t("config.dsh.credentialUnset")}
									disabled={state?.writable === false || busyRef === ref}
									onClick={() => void unsetRef(ref)}
								>
									<Trash2 className="size-3.5" aria-hidden="true" />
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

/** 源文件 tab：与 Pi 管理 RawTab 同款——顶部文件下拉 + 编辑器 + 保存。 */
function RawTab(props: { homeDir: string }) {
	const [fileName, setFileName] = useState(RAW_FILES[0]);
	const [content, setContent] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);

	// 切换文件/目录时重新加载
	useEffect(() => {
		if (!props.homeDir) return;
		let cancelled = false;
		setLoaded(false);
		setDirty(false);
		const filePath = `${props.homeDir.replace(/[\\/]+$/, "")}/${fileName}`;
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

	const saveFile = async () => {
		setSaving(true);
		try {
			const filePath = `${props.homeDir.replace(/[\\/]+$/, "")}/${fileName}`;
			await desktopApi.files.writeContent(filePath, content);
			setDirty(false);
		} catch (error) {
			console.error(`[dsh-config] write ${fileName} failed:`, error);
		} finally {
			setSaving(false);
		}
	};

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
				<div className="ml-auto flex items-center gap-2">
					<Button
						type="button"
						variant="default"
						size="sm"
						className="h-8"
						disabled={!loaded || !dirty || saving}
						onClick={() => void saveFile()}
					>
						{saving ? t("common.saving") : t("common.save")}
					</Button>
				</div>
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
