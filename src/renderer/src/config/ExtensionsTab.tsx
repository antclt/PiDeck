import { Button } from "../components/ui-shadcn/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui-shadcn/table";
import { useEffect, useState, type ReactNode } from "react";
import { Copy, Download, FolderOpen, ToggleLeft, ToggleRight, Trash2 } from "lucide-react";
import type { PiCliUpdateResult, PiExtensionListResult, PiExtensionSummary, PiPackageInfo, ProjectResourceOverrides } from "../../../shared/types";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n/rendererCopy.zh-CN";
import { showNotice } from "../utils/notice";
import { writeClipboard } from "../utils/clipboard";
import type { ResourceScope } from "./ResourceScopeSelector";
import { isProjectDiscoverySource } from "./resourceScopeModel";

type ExtensionsApi = {
	list: () => Promise<PiExtensionListResult>;
	uninstall: (source: string, scope?: "user" | "project" | "unknown") => Promise<void>;
	install: (source: string) => Promise<string>;
	toggle: (source: string, enabled: boolean, scope?: "user" | "project" | "unknown") => Promise<void>;
	setWhitelistDisabled: (enabled: boolean) => Promise<void>;
	removeBuiltIn: (source: string) => Promise<void>;
	restoreBuiltIn: (source: string) => Promise<void>;
	update: () => Promise<PiCliUpdateResult>;
	updateOne: (source: string) => Promise<PiCliUpdateResult>;
};

function getExtensionsApi(): ExtensionsApi {
	const api = (window as unknown as { piDesktop?: { extensions?: ExtensionsApi } })
		.piDesktop?.extensions;
	if (!api) throw new Error("PiDeck extensions API is not available");
	return api;
}

/** 把 IPC/主进程异常转成可读文本，避免内置扩展操作退回原生 alert。 */
function formatExtensionError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** PiDeck 内置扩展名 → source 文件名映射 */
const PIDEK_BUILTIN_SOURCE: Record<string, string> = {
	"pi-deck-todo": "pi-deck-todo.ts",
	"pi-deck-plan-mode": "pi-deck-plan-mode.ts",
	"pi-deck-goal-mode": "pi-deck-goal-mode.ts",
	"pi-deck-ask-question": "pi-deck-ask-question.ts",
	"pi-deck-nul-redirect-fix": "pi-deck-nul-redirect-fix.ts",
};

/** 推荐扩展包：描述走 i18n（descriptionKey），不在组件里硬编码中英文案。 */
type RecommendedPackage = Omit<PiPackageInfo, "description"> & { descriptionKey: TranslationKey };
const RECOMMENDED_PACKAGES: RecommendedPackage[] = [
	{
		name: "pi-deck-todo",
		descriptionKey: "config.extRecommended.piDeckTodo",
		installCmd: "npm:@earendil-works/pi-deck-todo",
		tags: ["extension"],
		downloads: "",
		updated: "",
		npmUrl: "",
		repoUrl: "https://github.com/ayuayue/PiDeck",
	},
	{
		name: "pi-deck-plan-mode",
		descriptionKey: "config.extRecommended.piDeckPlanMode",
		installCmd: "npm:@earendil-works/pi-deck-plan-mode",
		tags: ["extension"],
		downloads: "",
		updated: "",
		npmUrl: "",
		repoUrl: "https://github.com/ayuayue/PiDeck",
	},
	{
		name: "pi-deck-goal-mode",
		descriptionKey: "config.extRecommended.piDeckGoalMode",
		installCmd: "npm:@earendil-works/pi-deck-goal-mode",
		tags: ["extension"],
		downloads: "",
		updated: "",
		npmUrl: "",
		repoUrl: "https://github.com/ayuayue/PiDeck",
	},
	{
		name: "pi-deck-ask-question",
		descriptionKey: "config.extRecommended.piDeckAskQuestion",
		installCmd: "npm:@earendil-works/pi-deck-ask-question",
		tags: ["extension"],
		downloads: "",
		updated: "",
		npmUrl: "",
		repoUrl: "https://github.com/ayuayue/PiDeck",
	},
	{
		name: "pi-deck-nul-redirect-fix",
		descriptionKey: "config.extRecommended.piDeckNulRedirectFix",
		installCmd: "npm:@earendil-works/pi-deck-nul-redirect-fix",
		tags: ["extension"],
		downloads: "",
		updated: "",
		npmUrl: "",
		repoUrl: "https://github.com/ayuayue/PiDeck",
	},
	{
		name: "context-mode",
		descriptionKey: "config.extRecommended.contextMode",
		installCmd: "npm:context-mode",
		tags: ["extension"],
		downloads: "107K/mo",
		updated: "",
		npmUrl: "https://www.npmjs.com/package/context-mode",
		repoUrl: "https://github.com/mksglu/context-mode",
	},
	{
		name: "pi-web-access",
		descriptionKey: "config.extRecommended.piWebAccess",
		installCmd: "npm:pi-web-access",
		tags: ["extension"],
		downloads: "99K/mo",
		updated: "",
		npmUrl: "https://www.npmjs.com/package/pi-web-access",
		repoUrl: "https://github.com/nicobailon/pi-web-access",
	},
	{
		name: "pi-mcp-adapter",
		descriptionKey: "config.extRecommended.piMcpAdapter",
		installCmd: "npm:pi-mcp-adapter",
		tags: ["extension"],
		downloads: "99K/mo",
		updated: "",
		npmUrl: "https://www.npmjs.com/package/pi-mcp-adapter",
		repoUrl: "https://github.com/nicobailon/pi-mcp-adapter",
	},
	{
		name: "pi-subagents",
		descriptionKey: "config.extRecommended.piSubagents",
		installCmd: "npm:pi-subagents",
		tags: ["extension"],
		downloads: "92K/mo",
		updated: "",
		npmUrl: "https://www.npmjs.com/package/pi-subagents",
		repoUrl: "https://github.com/nicobailon/pi-subagents",
	},
];

/** 从扩展来源提取简短描述名 */
function shortName(source: string): string {
	return source
		.replace(/^(?:npm|file|github|git|https?):/i, "")
		.replace(/\.ts$/, "")
		.replace(/@[^/]+\//, "");
}

export function ExtensionsTab(props: {
	scope: ResourceScope;
	scopeSelector?: ReactNode;
	projectId?: string;
	projectOverrides: ProjectResourceOverrides;
	discoveryExtensions: Array<{
		source: string;
		path: string;
		sourceId: string;
		sourceLabel: string;
		physicalScope: "user" | "project";
		enabled: boolean;
		managed: boolean;
	}>;
	data: PiExtensionListResult;
	loading: boolean;
	uninstallingSource: string | null;
	onRefresh: () => void;
	onToggle?: (extension: PiExtensionSummary, enabled: boolean) => void | Promise<void>;
	onUninstall: (extension: PiExtensionSummary) => void;
	onShowInFolder: (extension: PiExtensionSummary) => void;
}) {
	const [installingSources, setInstallingSources] = useState<Set<string>>(() => new Set());
	const [togglingSource, setTogglingSource] = useState<string | null>(null);
	// 白名单总开关（「禁用 -e 参数」）：true = 不注入 --no-extensions/-e，pi 默认加载全部扩展。
	// 从 PiDeck settings 读取默认状态；切换写入后本地同步，供 RPC 下次启动生效。
	const [whitelistDisabled, setWhitelistDisabled] = useState(false);
	const [togglingWhitelist, setTogglingWhitelist] = useState(false);

	// 首次挂载读取白名单总开关状态（读取失败保持默认关闭，不影响禁用列表功能）
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const settings = await window.piDesktop.settings.get();
				if (!cancelled) setWhitelistDisabled(Boolean(settings.disableExtensionWhitelist));
			} catch {
				// 读取失败时保持默认值，不阻塞扩展列表展示
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// 首次加载或列表刷新时展示扩展冲突通知
	useEffect(() => {
		if (!props.data.conflicts || props.data.conflicts.length === 0) return;
		for (const c of props.data.conflicts) {
			showNotice(
				t("config.extensionConflict", {
					builtIn: shortName(c.builtIn),
					thirdParty: shortName(c.thirdParty),
				}),
				8000,
				"warning",
			);
		}
	}, [props.data.conflicts]);

	/** 禁用/启用非内置扩展：写入 PiDeck settings 的 scoped 禁用列表，重启 RPC 时以白名单模式生效。 */
	const handleToggle = async (extension: PiExtensionSummary, nextEnabled?: boolean) => {
		if (togglingSource) return;
		const enabled = nextEnabled ?? extension.enabled === false;
		setTogglingSource(extension.source);
		try {
			if (props.onToggle) {
				await props.onToggle(extension, enabled);
			} else {
				await getExtensionsApi().toggle(extension.source, enabled, extension.scope);
			}
			props.onRefresh();
			showNotice(
				t(
					enabled
						? "config.extensionEnabledToast"
						: "config.extensionDisabledToast",
					{ name: shortName(extension.source) },
				),
				3500,
			);
		} catch (e) {
			showNotice(
				t("config.extensionOperationFailed", { error: formatExtensionError(e) }),
				4500,
				"error",
			);
		} finally {
			setTogglingSource(null);
		}
	};
	const [updating, setUpdating] = useState<string | null>(null);
	const [updateResult, setUpdateResult] = useState<PiCliUpdateResult | null>(null);
	const [showUpdateDialog, setShowUpdateDialog] = useState(false);
	// 单扩展更新进行中的 source（与批量更新互斥，同一时间只跑一个 pi update）
	const [updatingOne, setUpdatingOne] = useState<string | null>(null);

	/**
	 * 切换白名单总开关（「禁用 -e 参数」）：开启后 PiProcess 不再注入 --no-extensions/-e，
	 * pi 默认加载全部扩展，禁用列表暂不生效——防御个别扩展的 -e 注入导致 RPC 启动失败。
	 * 写入 PiDeck settings，下次 RPC 启动生效；列表本身不变化，无需刷新。
	 */
	const handleToggleWhitelist = async () => {
		if (togglingWhitelist) return;
		setTogglingWhitelist(true);
		const next = !whitelistDisabled;
		try {
			await getExtensionsApi().setWhitelistDisabled(next);
			setWhitelistDisabled(next);
			showNotice(t(next ? "config.extensionWhitelistOnToast" : "config.extensionWhitelistOffToast"), 3500);
		} catch (e) {
			showNotice(
				t("config.extensionWhitelistToggleFailed", { error: formatExtensionError(e) }),
				4500,
				"error",
			);
		} finally {
			setTogglingWhitelist(false);
		}
	};

	const handleInstall = async (pkg: Pick<PiPackageInfo, "name" | "installCmd">) => {
		setInstallingSources((current) => new Set(current).add(pkg.installCmd));
		try {
			// 对已移除的内置扩展，走恢复流程而非 npm 安装
			const builtInSource = pkg.name.startsWith("pi-deck-") ? PIDEK_BUILTIN_SOURCE[pkg.name] : undefined;
			if (builtInSource) {
				await getExtensionsApi().restoreBuiltIn(builtInSource);
			} else {
				await getExtensionsApi().install(pkg.installCmd);
			}
			props.onRefresh();
		} catch (e) {
			showNotice(
				t("config.extensionOperationFailed", { error: formatExtensionError(e) }),
				4500,
				"error",
			);
		} finally {
			setInstallingSources((current) => {
				const next = new Set(current);
				next.delete(pkg.installCmd);
				return next;
			});
		}
	};

	const handleUpdateExtensions = async () => {
		setUpdating("all");
		setUpdateResult(null);
		setShowUpdateDialog(true);
		try {
			const result = await getExtensionsApi().update();
			setUpdateResult(result);
		} catch (e) {
			showNotice(
				t("config.extensionOperationFailed", { error: formatExtensionError(e) }),
				4500,
				"error",
			);
		} finally {
			setUpdating(null);
		}
	};

	/** 更新单个扩展（`pi update <source>`），完成后强制刷新列表拿新版本。 */
	const handleUpdateOne = async (extension: PiExtensionSummary) => {
		if (updatingOne) return;
		setUpdatingOne(extension.source);
		try {
			await getExtensionsApi().updateOne(extension.source);
			props.onRefresh();
			showNotice(t("config.extensionUpdatedToast", { name: shortName(extension.source) }), 3000);
		} catch (e) {
			showNotice(
				t("config.extensionOperationFailed", { error: formatExtensionError(e) }),
				4500,
				"error",
			);
		} finally {
			setUpdatingOne(null);
		}
	};

	/** 复制单扩展更新指令到剪贴板，用户可在终端手动执行。 */
	const handleCopyUpdateCommand = (extension: PiExtensionSummary) => {
		const command = `pi update ${extension.source}`;
		void writeClipboard(command);
		showNotice(t("config.extensionUpdateCommandCopied", { command }), 2500);
	};

	const projectExtensions = props.data.extensions.filter((extension) => extension.scope === "project");
	const globalExtensions = props.data.extensions.filter((extension) => extension.scope !== "project");
	const visibleExtensions = props.scope === "project"
		? [...projectExtensions, ...globalExtensions]
		: globalExtensions;
	const disabledGlobalSources = new Set(props.projectOverrides.disabledGlobalExtensions);
	const renderExtensionRows = (extensions: PiExtensionSummary[], inherited: boolean) =>
		extensions.map((extension) => {
			const disabledHere = inherited && disabledGlobalSources.has(extension.source);
			return (
				<ExtensionTableRow
					key={`${extension.scope}:${extension.id}`}
					projectId={props.projectId}
					extension={extension}
					effectiveEnabled={extension.enabled !== false && !disabledHere}
					inherited={inherited}
					uninstalling={props.uninstallingSource === extension.source}
					onDelete={props.onUninstall}
					onShowInFolder={props.onShowInFolder}
					toggling={togglingSource === extension.source}
					onToggle={handleToggle}
					updatingOne={updatingOne === extension.source}
					onUpdateOne={handleUpdateOne}
					onCopyUpdateCommand={handleCopyUpdateCommand}
				/>
			);
		});

	return (
		<div className="extensions-tab">
			{showUpdateDialog && (
				<div className="config-update-dialog-backdrop" role="dialog" aria-modal="true">
					<div className="config-update-dialog">
						<div className="config-update-dialog-header">
							<strong>{t("settings.updateExtensionsAll")}</strong>
							<Button variant="ghost" size="icon-sm" className="size-7"
								onClick={() => {
									setShowUpdateDialog(false);
									props.onRefresh();
								}}
								disabled={Boolean(updating)}
							>
								×
							</Button>
						</div>
						<p className="config-im-form-hint">
							{updating ? t("settings.extensionsUpdatingDesc") : t("settings.extensionsUpdateResultHint")}
						</p>
						<pre className="setting-update-output">
							{updateResult ? `${updateResult.command}\n${updateResult.output}` : t("settings.extensionsUpdating")}
						</pre>
						<div className="config-update-dialog-actions">
							<Button variant="default"
								size="sm"
								onClick={() => {
									setShowUpdateDialog(false);
									props.onRefresh();
								}}
								disabled={Boolean(updating)}
							>
								{t("common.close")}
							</Button>
						</div>
					</div>
				</div>
			)}
			{false && (
			<div className="config-section mb-5">
				<div className="mb-3 flex items-center justify-between">
					{/* 与设置弹窗分区标题同级：text-sm，避免 title 字号偏大 */}
					<h3 className="extensions-installed-title text-sm font-semibold tracking-tight text-foreground">
						{t("config.recommendedPackages")}
					</h3>
				</div>
				<p className="config-im-form-hint mb-3 text-caption text-muted-foreground">
					{t("config.recommendedPackagesHint")}
				</p>
				<div className="extensions-recommended-list">
					{RECOMMENDED_PACKAGES.map((pkg) => {
						// 内置扩展按 source 文件名匹配，npm 扩展按 installCmd 匹配
						const builtInSource = pkg.name.startsWith("pi-deck-") ? PIDEK_BUILTIN_SOURCE[pkg.name] : undefined;
						const builtInExt = builtInSource
							? props.data.extensions.find((ext) => ext.builtIn && ext.source === builtInSource)
							: undefined;
						// 已部署（非移除状态）视为已安装；已移除的内置扩展允许恢复安装
						const alreadyInstalled = builtInExt
							? builtInExt.enabled !== false
							: props.data.extensions.some((ext) => ext.source === pkg.installCmd);
						const installing = installingSources.has(pkg.installCmd);
						return (
						<div
							key={pkg.name}
							className="extensions-recommended-row"
							onClick={() => {
								// pi.dev 的详情路由使用 npm 包名,但查询参数可能是扩展内部展示名。
								const packageName = pkg.piPackageName ?? pkg.name;
								// 弹框内链接强制系统浏览器：window.open 会走 setWindowOpenHandler → 跟随 linkOpenMode，
								// internal 时内置浏览器在 Dialog 下层不可见同样被遮挡（与 openDocsInSystemBrowser 同规则）
								window.piDesktop.app.openExternal(
									`https://pi.dev/packages/${pkg.name}?name=${packageName}`,
									true
								);
							}}
							title={`${t("config.openPackageDetail")}: ${pkg.name}`}
						>
							<div className="extensions-recommended-info">
								<div className="extensions-recommended-name">
									<strong>{pkg.name}</strong>
									{alreadyInstalled && <span className="config-im-connected-badge" style={{ marginLeft: 8 }}>{t("config.installed")}</span>}
								</div>
								<div className="extensions-recommended-desc">
									{t(pkg.descriptionKey)}
								</div>
							</div>
							<div className="extensions-recommended-action" onClick={(e) => e.stopPropagation()}>
								{/* 安装中保持与图标按钮同尺寸，避免 config-btn 文本把操作区撑开错位 */}
								<Button variant="ghost" size="icon-sm" className="size-7"
									title={installing ? t("config.installing") : alreadyInstalled ? t("config.installed") : t("config.install")}
									onClick={() => handleInstall(pkg)}
									disabled={alreadyInstalled || installing}
									aria-busy={installing}
								>
									{installing ? (
										<span className="skillhub-installing-dot animate-pideck-spin" aria-hidden="true" />
									) : (
										<Download size={15} strokeWidth={1.8} aria-hidden="true" />
									)}
								</Button>
								<Button variant="ghost" size="icon-sm" className="size-7"
									title={t("common.copy")}
									onClick={(e) => {
										e.stopPropagation();
										const cmd = `pi install ${pkg.installCmd}`;
										writeClipboard(cmd);
										showNotice(t("app.codeCopied"), 1200);
									}}
								>
									<Copy size={14} strokeWidth={1.8} />
								</Button>
							</div>
						</div>
					);
					})}
				</div>
			</div>
			)}

			{/* 已安装扩展列表 */}
			<div className="config-section">
				<h3 className="extensions-installed-title mb-2 text-sm font-semibold tracking-tight text-foreground">
					{t("config.installedExtensions")}
				</h3>
				<div className="mb-3 mt-2 flex items-center justify-between gap-3">
					<div className="min-w-0">
						<span className="font-mono text-xs tabular-nums text-muted-foreground">
							{t("config.count.extensions", { count: visibleExtensions.length })}
						</span>
						<small className="skills-restart-hint block text-caption text-muted-foreground">
							{t("config.extensionRestartHint")}
						</small>
					</div>
					<div className="skills-toolbar-actions flex shrink-0 items-center gap-1.5">
						{props.scopeSelector}
						{props.scope === "global" ? (
							<>
								{/* 白名单总开关只属于全局设置。 */}
								<Button
									variant={whitelistDisabled ? "default" : "outline"}
									size="sm"
									onClick={() => void handleToggleWhitelist()}
									disabled={props.loading || togglingWhitelist}
									title={t("config.extensionWhitelistHint")}
								>
									{whitelistDisabled
										? <ToggleRight size={18} strokeWidth={1.8} className="mr-1.5" aria-hidden="true" />
										: <ToggleLeft size={18} strokeWidth={1.8} className="mr-1.5" aria-hidden="true" />}
									{t(whitelistDisabled ? "config.extensionWhitelistOn" : "config.extensionWhitelistOff")}
								</Button>
								<Button variant="outline" size="sm" onClick={handleUpdateExtensions} disabled={props.loading || Boolean(updating)}>
									{updating ? t("settings.updating") : t("settings.updateExtensionsAll")}
								</Button>
							</>
						) : null}
						<Button variant="outline" size="sm" onClick={props.onRefresh} disabled={props.loading}>
							{t("common.refresh")}
						</Button>
					</div>
				</div>
				<div className="overflow-hidden rounded-lg border border-border-subtle bg-bg-panel">
					{props.loading ? (
						<div className="py-12 text-center text-control text-muted-foreground">{t("config.loadingExtensions")}</div>
					) : visibleExtensions.length === 0 ? (
						<div className="py-12 text-center text-control text-muted-foreground">{t("config.emptyExtensions")}</div>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("config.extension")}</TableHead>
									<TableHead>{t("config.extensionVersion")}</TableHead>
									<TableHead className="w-28 text-right">{t("config.actions")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{props.scope === "project" && projectExtensions.length > 0 ? (
									<TableRow>
										<TableCell colSpan={3} className="bg-bg-hover px-3 py-1.5 text-caption font-semibold text-foreground">
											{t("config.resourceGroup.project")}
										</TableCell>
									</TableRow>
								) : null}
								{props.scope === "project" ? renderExtensionRows(projectExtensions, false) : null}
								{props.scope === "project" &&
									props.discoveryExtensions
										.filter((item) => isProjectDiscoverySource(item.sourceId))
										.map((item) => <DiscoveredExtensionRow key={`discovered:${item.path}`} item={item} />)}
								{props.scope === "project" && globalExtensions.length > 0 ? (
									<TableRow>
										<TableCell colSpan={3} className="bg-bg-hover px-3 py-1.5 text-caption font-semibold text-foreground">
											{t("config.resourceGroup.global")}
										</TableCell>
									</TableRow>
								) : null}
								{renderExtensionRows(globalExtensions, props.scope === "project")}
								{props.scope === "project" &&
									props.discoveryExtensions
										.filter((item) => !isProjectDiscoverySource(item.sourceId))
										.map((item) => <DiscoveredExtensionRow key={`discovered:${item.path}`} item={item} />)}
							</TableBody>
						</Table>
					)}
				</div>
			</div>
		</div>
	);
}

function DiscoveredExtensionRow(props: {
	item: {
		source: string;
		path: string;
		sourceId: string;
		sourceLabel: string;
		physicalScope: "user" | "project";
		enabled: boolean;
		managed: boolean;
	};
}) {
	const { item } = props;
	const name = item.source
		.replace(/^(?:npm|file|github|git):/i, "")
		.replace(/\.ts$/i, "");
	return (
		<TableRow>
			<TableCell className="min-w-0">
				<div className="flex min-w-0 flex-col gap-0.5">
					<div className="flex min-w-0 items-center gap-2">
						<strong className="truncate text-control font-medium text-foreground">{name}</strong>
						<span className="text-micro" title={t("config.resourceManagedHint")}>
							{t("config.resourceManaged")}
						</span>
					</div>
					<span className="truncate font-mono text-caption text-muted-foreground">{item.sourceLabel}</span>
				</div>
			</TableCell>
			<TableCell className="whitespace-nowrap text-caption text-muted-foreground">-</TableCell>
			<TableCell className="text-right" />
		</TableRow>
	);
}

function ExtensionTableRow(props: {
	projectId?: string;
	extension: PiExtensionSummary;
	effectiveEnabled: boolean;
	inherited: boolean;
	uninstalling: boolean;
	onDelete: (extension: PiExtensionSummary) => void;
	onShowInFolder: (extension: PiExtensionSummary) => void;
	toggling?: boolean;
	onToggle: (extension: PiExtensionSummary, nextEnabled?: boolean) => void;
	updatingOne: boolean;
	onUpdateOne: (extension: PiExtensionSummary) => void;
	onCopyUpdateCommand: (extension: PiExtensionSummary) => void;
}) {
	const { extension, effectiveEnabled, inherited } = props;
	const name = extension.source
		.replace(/^(?:npm|file|github|git):/i, "")
		.replace(/\.ts$/i, "");
	return (
		<TableRow aria-busy={props.uninstalling}>
			<TableCell className="min-w-0">
				<div className="flex min-w-0 flex-col gap-0.5">
					<div className="flex min-w-0 items-center gap-2">
						<strong className={`truncate text-control font-medium text-foreground${effectiveEnabled ? "" : " opacity-50"}`}>{name}</strong>
						{extension.builtIn && <span className="text-micro text-muted-foreground">{t("common.builtIn")}</span>}
						{extension.filtered && <span className="text-micro text-muted-foreground">{t("config.extensionFiltered")}</span>}
						{!effectiveEnabled && (
							<span className="text-micro text-muted-foreground">{t("config.extensionDisabledBadge")}</span>
						)}
					</div>
					<span className="truncate font-mono text-caption text-muted-foreground">{extension.source}</span>
				</div>
			</TableCell>
			<TableCell className="whitespace-nowrap text-caption text-muted-foreground">
				{extension.builtIn ? "-" : t("config.extensionVersions", {
					current: extension.currentVersion ?? "-",
					latest: extension.latestVersion ?? "-",
				})}
				{extension.hasUpdate && <span className="ml-1 text-text-primary">{t("config.extensionUpdateAvailable")}</span>}
				{extension.hasUpdate && !extension.builtIn && !inherited && (
					<div className="mt-1.5 flex items-center gap-1.5">
						<Button
							size="xs"
							variant="outline"
							onClick={() => props.onUpdateOne(extension)}
							disabled={props.updatingOne}
							aria-busy={props.updatingOne}
						>
							{props.updatingOne ? t("config.extensionUpdatingOne") : t("config.extensionUpdateOne")}
						</Button>
						<Button size="xs" variant="ghost" onClick={() => props.onCopyUpdateCommand(extension)}>
							<Copy size={13} strokeWidth={1.8} className="mr-1" aria-hidden="true" />
							{t("config.extensionCopyUpdateCommand")}
						</Button>
					</div>
				)}
				{extension.updateError && <div className="text-destructive">{extension.updateError}</div>}
			</TableCell>
			<TableCell className="text-right">
				<div className="flex justify-end gap-1">
										<Button
											variant="ghost"
											size="icon-sm"
											className="size-7"
											disabled={!extension.path}
											onClick={() => props.onShowInFolder(extension)}
											title={t("config.openExtensionLocation")}
										>
											<FolderOpen size={14} strokeWidth={1.8} />
										</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						className={`size-7${effectiveEnabled ? " text-primary" : ""}`}
						disabled={props.toggling || props.uninstalling || (inherited && extension.enabled === false)}
						onClick={() => props.onToggle(extension, !effectiveEnabled)}
						title={effectiveEnabled ? t("config.extensionDisable") : t("config.extensionEnable")}
						aria-busy={props.toggling}
					>
						{effectiveEnabled
							? <ToggleRight size={18} strokeWidth={1.8} />
							: <ToggleLeft size={18} strokeWidth={1.8} />}
					</Button>
					{!inherited && (!extension.builtIn || extension.enabled !== false) && (
						<Button
							variant="ghost"
							size="icon-sm"
							className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
							disabled={props.uninstalling}
							onClick={() => props.onDelete(extension)}
							title={props.uninstalling ? t("config.uninstalling") : t("config.uninstall")}
						>
							<Trash2 size={14} strokeWidth={1.8} />
						</Button>
					)}
				</div>
			</TableCell>
		</TableRow>
	);
}
