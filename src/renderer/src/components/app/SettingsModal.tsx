import { Component, Fragment, lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getDefaultStore } from "jotai";
import { settingsFocusAtom, type SettingsTabId } from "../../atoms";
import { useSettingsFocus } from "./settings/useSettingsFocus.ts";
import {
	Settings2,
	Network,
	Wrench,
	PawPrint,
	Trash2,
	Brush,
	Eye,
	ChartColumnBig,
	Activity,
	MessageSquare,
	ImageIcon,
	Globe,
	FileCode2,
	GitBranch,
	X,
} from "lucide-react";
import { t, type TranslationKey } from "../../i18n";
import { applyAppearanceAttributes, type AppearanceSettings } from "../../themeAppearance";
import { Button } from "../ui-shadcn/button";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "../ui-shadcn/tabs";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../ui-shadcn/dialog";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../ui-shadcn/alert-dialog";
import { cn } from "../../lib/utils";
import { buttonVariants } from "../ui-shadcn/button";
import { useVisionBridgeDraft } from "./settings/visionDraft.ts";
import { dirtySettingsTabIds, type SettingsUnsavedTabId } from "./settings/unsavedChangesSummary";
import { SETTINGS_TAB_IDS, SETTINGS_TAB_LAYOUT } from "./settings/settingsTabLayout";
import { useGitModels } from "./settings/gitModels.ts";
import { formatSettingsUnsavedMessage, summarizeSettingsUnsavedChanges } from "./settings/unsavedChangesSummary.ts";
import type { AppSettings, AppInfo, AvailableModel, PiInstallStatus, PiUpdateCheckResult, PiCliUpdateResult } from "../../../../shared/types";

// ── 各 tab 内容 lazy 加载：首开只下载壳 + 当前 tab 的 chunk（qrcode/表格/日志查看器等
//    重依赖随各自 tab 拆包），切换到某 tab 时才加载其 chunk（本地文件，秒级以内）。──
const CommonTab = lazy(() => import("./settings/CommonTab").then((m) => ({ default: m.CommonTab })));
const AppearanceTab = lazy(() => import("./settings/AppearanceTab").then((m) => ({ default: m.AppearanceTab })));
const ProxyTab = lazy(() => import("./settings/ProxyTab").then((m) => ({ default: m.ProxyTab })));
const WebTab = lazy(() => import("./settings/WebTab").then((m) => ({ default: m.WebTab })));
const EditorsTab = lazy(() => import("./settings/EditorsTab").then((m) => ({ default: m.EditorsTab })));
const GitTab = lazy(() => import("./settings/GitTab").then((m) => ({ default: m.GitTab })));
const DevTab = lazy(() => import("./settings/DevTab").then((m) => ({ default: m.DevTab })));
const PetTab = lazy(() => import("./settings/PetTab").then((m) => ({ default: m.PetTab })));
const ImTab = lazy(() => import("./settings/ImTab").then((m) => ({ default: m.ImTab })));
const StorageTab = lazy(() => import("./settings/SettingsStorageTab").then((m) => ({ default: m.StorageTab })));
const ProcessMetricsTab = lazy(() => import("./settings/ProcessMetricsTab").then((m) => ({ default: m.ProcessMetricsTab })));
const UsageStatsTab = lazy(() => import("./settings/UsageStatsTab").then((m) => ({ default: m.UsageStatsTab })));
const VisionBridgeSettingsTab = lazy(() => import("./settings/VisionBridgeSettingsTab").then((m) => ({ default: m.VisionBridgeSettingsTab })));
const ImageGenSettingsTab = lazy(() => import("./settings/ImageGenSettingsTab").then((m) => ({ default: m.ImageGenSettingsTab })));

// DSH 配置（HOME / 审批 / 外部会话）只放配置管理，避免设置页再开一个重复 tab
// SettingsTabId 定义在 atoms，深链与侧栏共用同一套合法 tab；
// 展示顺序与分组分割线统一收敛在 settings/settingsTabLayout.ts。

/** localStorage 键：设置页上次打开的 tab（重开弹窗时恢复位置，跨应用重启保留）。 */
const SETTINGS_LAST_TAB_KEY = "pideck-settings-last-tab";

/**
 * 读取上次打开的设置 tab；localStorage 不可用、无记录或值已失效时回退默认值 "common"。
 * Radix Dialog 关闭会卸载内容，state 在每次打开时重建，因此需要从外部存储恢复。
 */
function loadLastSettingsTab(): SettingsTabId {
	try {
		const raw = localStorage.getItem(SETTINGS_LAST_TAB_KEY);
		if (raw && (SETTINGS_TAB_IDS as readonly string[]).includes(raw)) return raw as SettingsTabId;
	} catch {
		/* localStorage 不可用（隐私模式等）时静默失败 */
	}
	return "common";
}

type SettingsModalProps = {
	settings: AppSettings;
	piStatus: PiInstallStatus | null;
	piChecking: boolean;
	piProxyChecking: boolean;
	piProxyNotice: string;
	piProxyNoticeTone: "info" | "success" | "error";
	webServiceChanging: boolean;
	onRestartWebService: () => void;
	appInfo: AppInfo;
	customPiPath: string;
	customPathValidating: boolean;
	customPathResult: PiInstallStatus | null;
	updateChecking: boolean;
	piUpdating: boolean;
	piUpdateChecking: boolean;
	piUpdateCheck: PiUpdateCheckResult | null;
	piUpdateResult: PiCliUpdateResult | null;
	onCustomPathChange: (path: string) => void;
	onValidateCustomPath: () => void;
	onClearCustomPath: () => void;
	onCheckPi: () => void;
	onTestPiProxy: () => void;
	onCheckUpdate: () => void;
	onCheckPiUpdate: () => void;
	onUpdatePi: () => void;
	onToggleDevTools: () => void;
	onRestartApp: () => void;
	onClearCheckFlag?: () => void;
	onOpenWebService: (port: string) => void;
	onClose: () => void;
	onChange: (patch: Partial<AppSettings>) => void;
};

/**
 * 设置弹框错误边界：渲染异常时保留可关闭的错误面板，避免整页白屏无法退出。
 */
// 小窗口保留外边距，避免设置页完全压住工作区；821px 以上恢复桌面弹框尺寸。
// DialogContent 默认带 sm:max-w-lg，必须显式覆盖它，否则小窗口会变成窄高条。
const settingsModalSizeClass = "w-[80vw] max-w-[80vw] h-[80vh] max-h-[80vh] sm:max-w-[min(1300px,80vw)]";

class SettingsModalErrorBoundary extends Component<
	{ onClose: () => void; children: ReactNode },
	{ error: Error | null }
> {
	override state = { error: null as Error | null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	override render() {
		if (!this.state.error) return this.props.children;
		// #115：错误兜底直接走 shadcn Dialog 外壳
		return (
			<Dialog open onOpenChange={(next) => !next && this.props.onClose()}>
			<DialogContent showCloseButton={false} className={cn("flex flex-col gap-0 overflow-hidden p-0", settingsModalSizeClass, "settings-modal")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle>{t("settings.loadFailed")}</DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>
				<div className="settings-layout">
					<div className="settings-content" style={{ padding: "var(--space-5)" }}>
						<div className="config-diagnostic-card">
							<div>
								<strong>{t("settings.renderCrashed")}</strong>
								<span>{this.state.error.message}</span>
								<small>{t("settings.renderCrashedHelp")}</small>
							</div>
							<pre>{this.state.error.stack ?? this.state.error.message}</pre>
						</div>
					</div>
				</div>
			</DialogContent>
			</Dialog>
		);
	}
}

/** tab chunk 加载占位：轻量居中提示，避免首次切到某 tab 时空白闪烁 */
function SettingsTabLoading() {
	return (
		<div className="settings-panel grid min-w-0 min-h-40 place-items-center text-caption text-text-tertiary">
			{t("common.loading")}
		</div>
	);
}

/**
 * 设置弹框。memo + SettingsFeatureRoot 内稳定 props：
 * App 根组件重渲染（如 agent 流式输出）不会连带重渲染整个设置页。
 */
export const SettingsModal = memo(function SettingsModal(props: SettingsModalProps) {
	return (
		<SettingsModalErrorBoundary onClose={props.onClose}>
			<SettingsModalContent {...props} />
		</SettingsModalErrorBoundary>
	);
});

/**
 * 各 tab 的图标与文案 key 元数据：label 渲染时经 t() 取当前语言文案（不能模块级求值，
 * 否则语言切换后不生效）；展示顺序与分割线由 SETTINGS_TAB_LAYOUT 决定（settingsTabLayout.ts）。
 */
const TAB_META: Record<SettingsTabId, { labelKey: TranslationKey; icon: ReactNode }> = {
	common: { labelKey: "settings.tabs.common", icon: <Settings2 size={16} /> },
	appearance: { labelKey: "settings.tabs.appearance", icon: <Brush size={16} /> },
	proxy: { labelKey: "settings.tabs.proxy", icon: <Network size={16} /> },
	web: { labelKey: "settings.tabs.web", icon: <Globe size={16} /> },
	editors: { labelKey: "settings.tabs.editors", icon: <FileCode2 size={16} /> },
	git: { labelKey: "settings.tabs.git", icon: <GitBranch size={16} /> },
	dev: { labelKey: "settings.tabs.dev", icon: <Wrench size={16} /> },
	im: { labelKey: "settings.tabs.im", icon: <MessageSquare size={16} /> },
	pet: { labelKey: "settings.tabs.pet", icon: <PawPrint size={16} /> },
	storage: { labelKey: "settings.tabs.storage", icon: <Trash2 size={16} /> },
	usage: { labelKey: "settings.tabs.usage", icon: <ChartColumnBig size={16} /> },
	process: { labelKey: "settings.tabs.process", icon: <Activity size={16} /> },
	vision: { labelKey: "settings.tabs.vision", icon: <Eye size={16} /> },
	imagegen: { labelKey: "settings.tabs.imagegen", icon: <ImageIcon size={16} /> },
};

/**
 * 设置弹框壳：只持有跨 tab 共享状态（草稿/脏标记/视觉桥/重置信号）与 Tabs 导航，
 * 各 tab 内容拆为独立 memo 组件（settings/*Tab.tsx），切换 tab 只挂载目标 tab。
 */
function SettingsModalContent(props: SettingsModalProps) {
	// 弹窗每次打开都会重新挂载（Radix Dialog 关闭即卸载内容）。
	// 深链（如 Git「去设置」）优先于上次记住的 tab，否则会停在外观/开发等其它页。
	const [activeTab, setActiveTab] = useState<SettingsTabId>(
		() => getDefaultStore().get(settingsFocusAtom)?.tab ?? loadLastSettingsTab(),
	);
	const persistTab = useCallback((tab: SettingsTabId) => {
		try {
			localStorage.setItem(SETTINGS_LAST_TAB_KEY, tab);
		} catch {
			/* localStorage 不可用时只影响本次记忆 */
		}
	}, []);
	useSettingsFocus(activeTab, setActiveTab, persistTab);
	// ── 全局设置草稿：进入弹框时快照 props.settings，所有修改在 draft 上操作，保存时统一提交 ──
	const [draftSettings, setDraftSettings] = useState<AppSettings>(() => ({ ...props.settings }));
	const [dirtyFields, setDirtyFields] = useState<Set<string>>(new Set());
	/** 打开弹框时的原始设置快照，用于取消时回退 */
	const baseSnapshotRef = useRef<AppSettings>({ ...props.settings });
	// ── 视觉桥草稿：独立于全局设置（写 pi-deck-vision.json，走独立 IPC），脏标记/保存/取消由弹框统一管理 ──
	const visionDraft = useVisionBridgeDraft();
	// ── 生图草稿：独立文件 userData/imagegen.json，不属于 pi/dsh，放在设置页统一管理 ──
	const imageGenRef = useRef<{ save: () => Promise<boolean> } | null>(null);
	const [imageGenDirty, setImageGenDirty] = useState(false);
	const handleImageGenDirtyChange = useCallback((dirty: boolean) => setImageGenDirty(dirty), []);
	// 左侧导航黄点来源：与关闭确认同一套字段目录，避免两处口径不一致
	const dirtyTabIds = useMemo(
		() => dirtySettingsTabIds({ dirtyFields, visionDirty: visionDraft.dirty, imageGenDirty }),
		[dirtyFields, visionDraft.dirty, imageGenDirty],
	);
	/** 各 tab 的局部编辑态（WSL 输入/Web 端口/宠物预览模式）在取消时通过递增信号重置 */
	const [devTabResetKey, setDevTabResetKey] = useState(0);
	const [webTabResetKey, setWebTabResetKey] = useState(0);
	const [petTabResetKey, setPetTabResetKey] = useState(0);

	/** 更新草稿并标记对应字段为已修改。调用方传入的 patch 中的每个 key 都会追加到 dirtyFields。 */
	const updateDraft = useCallback((patch: Partial<AppSettings>) => {
		setDraftSettings((prev) => ({ ...prev, ...patch }));
		setDirtyFields((prev) => {
			const next = new Set(prev);
			for (const key of Object.keys(patch)) {
				next.add(key);
			}
			return next;
		});
	}, []);

	// 外观实时预览：草稿中明暗/外观主题/主色变化时立即写入 <html> 的 data-* 属性，
	// 与 App.tsx 的持久化应用共用 applyAppearanceAttributes（见 themeAppearance.ts）。
	// 保存后由 App 的 settings effect 接管；取消时在 cancelAll 里回滚回 baseSnapshot。
	useEffect(() => {
		const media = window.matchMedia?.("(prefers-color-scheme: dark)");
		applyAppearanceAttributes(
			document.documentElement,
			draftSettings as AppearanceSettings,
			Boolean(media?.matches),
		);
	}, [
		draftSettings.theme,
		draftSettings.themeScheduleLightStart,
		draftSettings.themeScheduleDarkStart,
		draftSettings.themeSkin,
		draftSettings.accent,
	]);

	/** 检查指定字段在草稿中是否已被修改（与初始快照比较） */
	const isDirty = useCallback((field: keyof AppSettings): boolean => {
		// keyof 含 number/symbol 成员，Set 按 string 存储，统一转字符串比较
		return dirtyFields.has(String(field));
	}, [dirtyFields]);

	/** 把 <html> 的 data-* 外观属性还原为打开弹窗时的快照（App 的 settings effect
	 *  只在 settings 实际变化时重跑，取消/放弃不触发，必须在这里显式恢复预览）。 */
	const restoreAppearanceFromSnapshot = useCallback(() => {
		const media = window.matchMedia?.("(prefers-color-scheme: dark)");
		applyAppearanceAttributes(
			document.documentElement,
			baseSnapshotRef.current as AppearanceSettings,
			Boolean(media?.matches),
		);
	}, []);

	/** 保存全部已修改内容：全局设置差异提交 + 视觉桥/生图草稿（若有改动）；返回是否全部成功 */
	const saveAll = async (): Promise<boolean> => {
		let ok = true;
		if (dirtyFields.size > 0) {
			const patch: Partial<AppSettings> = {};
			for (const key of dirtyFields) {
				(patch as Record<string, unknown>)[key] = (draftSettings as Record<string, unknown>)[key];
			}
			props.onChange(patch);
			// 更新快照基准为当前草稿值，并清除修改标记
			baseSnapshotRef.current = { ...baseSnapshotRef.current, ...patch };
			setDirtyFields(new Set());
		}
		if (visionDraft.dirty) {
			// 视觉桥保存失败（如 API Key 缺失/接口不可达）时保留脏标记，头部按钮可重试
			const visionOk = await visionDraft.save();
			ok = ok && visionOk;
		}
		if (imageGenDirty) {
			const imageGenOk = (await imageGenRef.current?.save()) ?? false;
			ok = ok && imageGenOk;
			// 保存成功后脏标记由子组件通过 onDirtyChange 自动清掉
		}
		return ok;
	};

	/** 取消全部修改：将草稿回退到初始快照，丢弃所有未保存变更（含视觉桥/生图草稿与各 tab 局部编辑态） */
	const cancelAll = () => {
		setDraftSettings({ ...baseSnapshotRef.current });
		setDirtyFields(new Set());
		restoreAppearanceFromSnapshot();
		visionDraft.reset();
		setPerAreaFontSize(
			baseSnapshotRef.current.uiFontSize !== null ||
				baseSnapshotRef.current.chatFontSize !== null ||
				baseSnapshotRef.current.inputFontSize !== null,
		);
		// tab 局部编辑态（WSL 输入、Web 端口、宠物预览）由各自 tab 监听信号重置
		setDevTabResetKey((k) => k + 1);
		setWebTabResetKey((k) => k + 1);
		setPetTabResetKey((k) => k + 1);
	};

	// 生图 tab 的取消：脏标记由子组件内部管理，取消时不主动重置（下次打开重新加载）；
	// 若需强制重置可在子组件暴露 reset 方法，这里仅确保关闭流程不遗漏生图脏检查

	/** 关闭弹框：有未保存变更（全局设置/视觉桥/生图草稿）时弹出确认对话框，无变更时直接关闭 */
	const handleClose = () => {
		if (dirtyFields.size > 0 || visionDraft.dirty || imageGenDirty) {
			setCloseConfirmOpen(true);
		} else {
			props.onClose();
		}
	};

	/** 关闭确认弹框时选择保存并关闭：视觉桥保存失败则留在弹框内（脏标记保留，可重试） */
	const handleSaveAndClose = async () => {
		setCloseConfirmOpen(false);
		const ok = await saveAll();
		if (ok) {
			props.onClose();
		}
	};

	/** 关闭确认弹框时选择放弃更改 */
	const handleDiscardAndClose = () => {
		setCloseConfirmOpen(false);
		// 放弃修改：草稿被丢弃，但外观实时预览已写入 <html>，需显式回滚为快照值
		restoreAppearanceFromSnapshot();
		props.onClose();
	};

	const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);

	const [perAreaFontSize, setPerAreaFontSize] = useState(
		draftSettings.uiFontSize !== null ||
			draftSettings.chatFontSize !== null ||
			draftSettings.inputFontSize !== null,
	);

	// Git 摘要模型列表与会话 Command 选择器共用 pi --list-models 数据源。
	const { gitModels, report: gitModelsReport, refreshing: gitModelsRefreshing, reload: reloadGitModels, gitModelPickerOpen, openPicker: openGitModelPicker, closePicker: closeGitModelPicker } = useGitModels();

	/** 选择提交信息模型：写入草稿并关闭选择器 */
	const handlePickGitModel = useCallback((model: AvailableModel) => {
		updateDraft({
			gitCommitMessageProvider: model.provider,
			gitCommitMessageModel: model.id,
		});
		closeGitModelPicker();
	}, [updateDraft, closeGitModelPicker]);

	/** 收藏/取消收藏提交信息模型 */
	const handleToggleGitModelFavorite = useCallback((provider: string, modelId: string) => {
		const key = `${provider}/${modelId}`;
		const favorites = draftSettings.favoriteModels ?? [];
		updateDraft({
			favoriteModels: favorites.includes(key)
				? favorites.filter((item) => item !== key)
				: [...favorites, key],
		});
	}, [draftSettings.favoriteModels, updateDraft]);

	// 侧栏条目 = 布局模块定义的顺序/分组边界 + 上面的图标文案元数据
	const tabs = SETTINGS_TAB_LAYOUT.map((entry) => ({
		id: entry.id,
		dividerBefore: entry.dividerBefore ?? false,
		label: t(TAB_META[entry.id].labelKey),
		icon: TAB_META[entry.id].icon,
	}));

	const hasDirtyChanges = dirtyFields.size > 0;
	// 视觉桥/生图草稿有未保存改动时，头部保存/取消按钮同样点亮（与全局设置脏标记合并判定）
	const hasAnyDirtyChanges = hasDirtyChanges || visionDraft.dirty || imageGenDirty;
	// 关闭确认只点名第一条（按设置页 tab/字段顺序），多项用 count 提示还有别的。
	const unsavedCloseMessage = useMemo(
		() =>
			formatSettingsUnsavedMessage(
				summarizeSettingsUnsavedChanges({
					dirtyFields,
					visionDirty: visionDraft.dirty,
					imageGenDirty,
				}),
				t,
			),
		[dirtyFields, visionDraft.dirty, imageGenDirty],
	);

	return (
		<Dialog open onOpenChange={(next) => !next && handleClose()}>
			<DialogContent showCloseButton={false} stagger className={cn("flex flex-col gap-0 overflow-hidden p-0", settingsModalSizeClass, "settings-modal", "[--wallpaper-dialog-alpha:var(--wallpaper-panel-alpha,30%)]")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle>{t("settings.title")}</DialogTitle>
					<div className="flex items-center gap-2">
						{/* 保存按钮常驻：无未保存改动时禁用，避免用户改完直接关窗丢改动；视觉桥保存中禁用防重复提交 */}
						<Button variant="default" size="sm" onClick={saveAll} disabled={!hasAnyDirtyChanges || visionDraft.saving}>
							{t("common.save")}
						</Button>
						{hasAnyDirtyChanges ? (
							/* 放弃更改用 outline（白底描边）而非灰底 secondary：与黑色主按钮形成
							    清晰的主次层级（shadcn dialog 的 confirm/cancel 惯例），避免一对按钮
							    都是灰色填充分不出哪个是提交。 */
							<Button variant="outline" size="sm" onClick={cancelAll}>
								{t("common.cancel")}
							</Button>
						) : undefined}
						<DialogClose asChild>
							<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
								<X size={18} strokeWidth={2.2} aria-hidden="true" />
							</Button>
						</DialogClose>
					</div>
				</DialogHeader>
			<Tabs orientation="vertical" value={activeTab} onValueChange={(v) => { const match = tabs.find((t) => t.id === v); if (!match) return; setActiveTab(match.id); persistTab(match.id); }} className="settings-layout flex min-h-0 flex-1 flex-row gap-0 bg-transparent">
					<TabsList className="settings-tabs flex min-h-0 shrink-0 flex-col items-stretch gap-2.5 overflow-auto border-0 border-r border-border rounded-none bg-transparent p-2.5 data-[orientation=vertical]:w-[196px]" aria-label={t("settings.title")}>
						{tabs.map((tab) => (
							<Fragment key={tab.id}>
								{/* 分组分割线（纯视觉）：竖排侧栏为横线；≤820px 横排时变竖线，
								    与 surfaces.css 里 .settings-tabs 转横向布局的媒体查询同条件 */}
								{tab.dividerBefore ? (
									<div
										aria-hidden="true"
										className="my-1.5 h-px w-auto shrink-0 bg-border-subtle max-[820px]:mx-1 max-[820px]:my-0 max-[820px]:h-auto max-[820px]:w-px"
									/>
								) : null}
								<TabsTrigger value={tab.id} className="config-nav-btn h-8 justify-start gap-1.5 px-2.5 text-control font-medium">
									<span className="settings-tab-icon">{tab.icon}</span>
									<strong>{tab.label}</strong>
								{/* 未保存黄点：按字段目录归并到所属 tab，视觉桥草稿算 vision */}
								{dirtyTabIds.has(tab.id as SettingsUnsavedTabId) ? <span className="ml-auto size-1.5 rounded-full bg-amber-500" aria-hidden="true" /> : null}
								</TabsTrigger>
							</Fragment>
						))}
					</TabsList>
					{/* ── 常用设置 tab ── */}
					{activeTab === "common" && (
						<TabsContent value="common" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<CommonTab
								draft={draftSettings}
								updateDraft={updateDraft}
								isDirty={isDirty}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── 外观设置 tab ── */}
					{activeTab === "appearance" && (
						<TabsContent value="appearance" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<AppearanceTab
								draft={draftSettings}
								updateDraft={updateDraft}
								isDirty={isDirty}
								perAreaFontSize={perAreaFontSize}
								setPerAreaFontSize={setPerAreaFontSize}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── 代理设置 tab ── */}
					{activeTab === "proxy" && (
						<TabsContent value="proxy" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<ProxyTab
								draft={draftSettings}
								updateDraft={updateDraft}
								isDirty={isDirty}
								piProxyChecking={props.piProxyChecking}
								piProxyNotice={props.piProxyNotice}
								piProxyNoticeTone={props.piProxyNoticeTone}
								onTestPiProxy={props.onTestPiProxy}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── 局域网 Web 服务 tab（原为开发设置内区块） ── */}
					{activeTab === "web" && (
						<TabsContent value="web" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<WebTab
								draft={draftSettings}
								updateDraft={updateDraft}
								webServiceChanging={props.webServiceChanging}
								onOpenWebService={props.onOpenWebService}
								onRestartWebService={props.onRestartWebService}
								resetKey={webTabResetKey}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── 外部编辑器 tab（由 Pi 管理界面迁入，原为开发设置内区块） ── */}
					{activeTab === "editors" && (
						<TabsContent value="editors" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<EditorsTab
								draft={draftSettings}
								updateDraft={updateDraft}
								isDirty={isDirty}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── Git 设置 tab（原为常用设置内区块，由 Git 面板深链直达） ── */}
					{activeTab === "git" && (
						<TabsContent value="git" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<GitTab
								draft={draftSettings}
								updateDraft={updateDraft}
								isDirty={isDirty}
								gitModels={gitModels}
								gitModelsReport={gitModelsReport}
								gitModelsRefreshing={gitModelsRefreshing}
								onRefreshGitModels={() => reloadGitModels(true)}
								gitModelPickerOpen={gitModelPickerOpen}
								onOpenGitModelPicker={openGitModelPicker}
								onCloseGitModelPicker={closeGitModelPicker}
								onPickGitModel={handlePickGitModel}
								onToggleGitModelFavorite={handleToggleGitModelFavorite}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── 开发设置 tab（环境/版本/运行/调试；Web 与外部编辑器已拆独立 tab） ── */}
					{activeTab === "dev" && (
						<TabsContent value="dev" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<DevTab
								draft={draftSettings}
								updateDraft={updateDraft}
								isDirty={isDirty}
								appInfo={props.appInfo}
								piStatus={props.piStatus}
								piChecking={props.piChecking}
								customPiPath={props.customPiPath}
								customPathValidating={props.customPathValidating}
								customPathResult={props.customPathResult}
								onCustomPathChange={props.onCustomPathChange}
								onValidateCustomPath={props.onValidateCustomPath}
								onClearCustomPath={props.onClearCustomPath}
								onCheckPi={props.onCheckPi}
								onClearCheckFlag={props.onClearCheckFlag}
								piUpdateChecking={props.piUpdateChecking}
								onCheckPiUpdate={props.onCheckPiUpdate}
								piUpdating={props.piUpdating}
								onUpdatePi={props.onUpdatePi}
								piUpdateCheck={props.piUpdateCheck}
								piUpdateResult={props.piUpdateResult}
								updateChecking={props.updateChecking}
								onCheckUpdate={props.onCheckUpdate}
								onToggleDevTools={props.onToggleDevTools}
								onRestartApp={props.onRestartApp}
								resetKey={devTabResetKey}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── 外部连接 tab（飞书机器人，由 Pi 管理界面迁入） ── */}
					{activeTab === "im" && (
						<TabsContent value="im" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<ImTab />
							</Suspense>
						</TabsContent>
					)}

					{/* ── 桌面宠物 tab ── */}
					{activeTab === "pet" && (
						<TabsContent value="pet" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<PetTab
								draft={draftSettings}
								updateDraft={updateDraft}
								isDirty={isDirty}
								resetKey={petTabResetKey}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── 进程监控 tab（由 Pi 管理界面迁入） ── */}
					{activeTab === "process" && (
						<TabsContent value="process" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<ProcessMetricsTab />
							</Suspense>
						</TabsContent>
					)}
					{/* ── 存储与日志 tab ── */}
					{activeTab === "storage" && (
						<TabsContent value="storage" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<StorageTab
								settings={draftSettings}
								onChange={updateDraft}
							/>
							</Suspense>
						</TabsContent>
					)}
					{/* ── 用量统计 tab ── */}
					{activeTab === "usage" && (
						<TabsContent value="usage" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<UsageStatsTab />
							</Suspense>
						</TabsContent>
					)}
					{/* ── 视觉桥 tab：草稿/脏标记/保存由弹框统一管理，本组件只呈现表单 */}
					{activeTab === "vision" && (
						<TabsContent value="vision" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<VisionBridgeSettingsTab
								draft={visionDraft.draft}
								saving={visionDraft.saving}
								configDir={visionDraft.configDir}
								notice={visionDraft.notice}
								onChange={visionDraft.updateDraft}
							/>
							</Suspense>
						</TabsContent>
					)}
					{/* ── 生图 tab：独立 imagegen.json，不属于 pi/dsh，放在设置页统一管理。
					    草稿保存在 ImageGenSection 内部，切换 tab 时保持挂载（hidden 而非卸载）以免丢失未保存修改。 */}
					<TabsContent value="imagegen" className="settings-panel min-w-0" hidden={activeTab !== "imagegen"}>
						<Suspense fallback={<SettingsTabLoading />}>
							<ImageGenSettingsTab ref={imageGenRef} onDirtyChange={handleImageGenDirtyChange} />
						</Suspense>
					</TabsContent>
				</Tabs>
			{/* 未保存变更确认对话框 */}
			{closeConfirmOpen && (
				<AlertDialog open onOpenChange={(open) => { if (!open) setCloseConfirmOpen(false); }}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>{t("settings.unsavedTitle")}</AlertDialogTitle>
							<AlertDialogDescription>{unsavedCloseMessage}</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
							<AlertDialogAction className={buttonVariants({ variant: "destructive" })} onClick={handleDiscardAndClose}>
								{t("settings.discardChanges")}
							</AlertDialogAction>
							<AlertDialogAction onClick={handleSaveAndClose}>
								{t("settings.saveAndClose")}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}
			</DialogContent>
		</Dialog>
	);
}
