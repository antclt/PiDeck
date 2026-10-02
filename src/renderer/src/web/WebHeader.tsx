/**
 * WebHeader — Web 端会话头部（第三批瘦身后）。
 *
 * 左侧：会话标题（截断）；右侧：运行态指示 + 会话/全局动作。
 * 模型与思考档位已迁往 composer 工具行（WebModelSelector/WebThinkingSelector）。
 * 运行态来自 useChat status（submitted/streaming）与轮询的 runtime.status 兜底。
 */
import { Download, History, Menu, Monitor, Moon, MoreHorizontal, PanelRight, Puzzle, Search, ShieldCheck, Sun, Target } from "lucide-react";
import type { AgentBackend } from "../../../shared/types";
import { Button } from "@/components/ui-shadcn/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui-shadcn/select";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { SessionBackendMark } from "@/components/session/SessionSourceBadge";
import { DSH_PERMISSION_PRESETS } from "@/components/session/DshPermissionMenu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui-shadcn/dropdown-menu";
import type { WebContextUsage } from "./webTypes";
import type { ResolvedWebTheme, WebThemePreference } from "./webTheme";

export type WebHeaderStatus = "idle" | "starting" | "running" | "error";

/** P1/P3：溢出菜单 + 头部快捷入口回调（全部可选，缺失即隐藏对应项）。 */
export type WebHeaderActions = {
	onRename?: () => void;
	onDuplicate?: () => void;
	onExportHtml?: () => void;
	onDelete?: () => void;
	onRestart?: () => void;
	onCompact?: () => void;
	onClone?: () => void;
	onCopyMarkdown?: () => void;
	onOpenRewind?: () => void;
	onOpenWorkspace?: () => void;
	onPermissionChange?: (preset: string) => void;
};

export function WebHeader(props: {
	title: string;
	status: WebHeaderStatus;
	onOpenSidebar: () => void;
	backend?: AgentBackend;
	/** P2：上下文用量环数据（由 WebChatApp 随轮询拉取；无 runtime 时不渲染）。 */
	contextUsage?: WebContextUsage;
	/** P1：DSH 当前权限预设。 */
	permissionPreset?: string;
	/** P0-P3：会话/runtime/workspace 操作回调。 */
	actions?: WebHeaderActions;
	/** 第三批：模型/思考已迁 composer，不再由头部渲染。 */
	onOpenDshTools?: () => void;
	/** 第二批：全局入口（搜索/主题/PWA 安装/技能扩展面板）。 */
	onOpenSearch?: () => void;
	themePreference?: WebThemePreference;
	resolvedTheme?: ResolvedWebTheme;
	onCycleTheme?: () => void;
	canInstall?: boolean;
	onInstall?: () => void;
	onOpenAssets?: () => void;
}) {
	const { title, status, onOpenSidebar, backend, contextUsage, permissionPreset, actions, onOpenDshTools, onOpenSearch, themePreference, resolvedTheme, onCycleTheme, canInstall, onInstall, onOpenAssets } = props;
	// 允许窄屏换行：标题保留可用宽度，控制项在下一行展开，避免手机上相互挤压。
	return (
		<header className="chat-header flex min-w-0 flex-wrap items-center gap-2 border-b border-border/60 bg-background px-3 py-2">
			<Button type="button" variant="ghost" size="icon" className="mobile-sidebar-toggle size-8 shrink-0" onClick={onOpenSidebar} aria-label={t("web.openProjects")} title={t("web.openProjects")}>
				<Menu className="size-4" aria-hidden="true" />
			</Button>
			<div className="chat-title-block min-w-0 flex-1">
				<strong className="flex min-w-0 items-center gap-1.5 truncate text-sm font-semibold tracking-tight text-foreground" title={title}>
					{/* 后端徽标（C18 同源）：与侧栏会话行一致，头部可辨 pi/dsh */}
					{backend && <SessionBackendMark backend={backend} className="size-4 shrink-0 rounded" />}
					<span className="min-w-0 truncate">{title}</span>
				</strong>
			</div>
			<div className="chat-header-actions flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1.5">
				{/* P2：上下文用量环（无窗口数据时隐藏；超限变红） */}
				{contextUsage && (contextUsage.contextWindow ?? 0) > 0 ? <ContextRing usage={contextUsage} /> : null}
				{/* S6.3：DSH 会话的 goals/subagents/skills 工具面板入口（仅 dsh 后端显示） */}
				{backend === "dsh" && onOpenDshTools && (
					<Button type="button" variant="ghost" size="sm" className="h-8 gap-1 px-2 text-caption text-muted-foreground hover:bg-muted/60 hover:text-foreground" onClick={onOpenDshTools} aria-label={t("web.dshTools")} title={t("web.dshTools")}>
						<Target size={14} aria-hidden="true" />
						<span className="hidden sm:inline">{t("web.dshTools")}</span>
					</Button>
				)}
				{/* P1：DSH 权限预设（read-only / workspace-write / danger-full-access） */}
				{backend === "dsh" && actions?.onPermissionChange ? (
					<Select value={permissionPreset ?? ""} onValueChange={(preset) => actions?.onPermissionChange?.(preset)}>
						<SelectTrigger size="sm" className="h-8 w-36 border-transparent bg-transparent px-2 text-caption text-muted-foreground hover:bg-muted/60" aria-label={t("web.permission")} title={t("web.permission")}>
							<ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
							<SelectValue placeholder={t("dshPermission.unknown")} />
						</SelectTrigger>
						<SelectContent>
							{DSH_PERMISSION_PRESETS.map((preset) => (
								<SelectItem key={preset.id} value={preset.id}>
									{t(preset.labelKey)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				) : null}
				{/* 运行态指示：复用桌面 agent-status-indicator 视觉 */}
				<span className="flex items-center gap-2">
					<span className={cn("agent-status-indicator", status === "running" && "status-running", status === "starting" && "status-starting", status === "error" && "status-error", status === "idle" && "status-idle")}>{t(statusLabelKey(status))}</span>
				</span>
				{/* P1：rewind 检查点入口（需活跃 runtime） */}
				{actions?.onOpenRewind ? (
					<Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground hover:bg-muted/60 hover:text-foreground" onClick={actions.onOpenRewind} aria-label={t("web.rewind")} title={t("web.rewind")}>
						<History className="size-4" aria-hidden="true" />
					</Button>
				) : null}
				{/* P3：工作区抽屉（Git / 文件）入口 */}
				{actions?.onOpenWorkspace ? (
					<Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground hover:bg-muted/60 hover:text-foreground" onClick={actions.onOpenWorkspace} aria-label={t("web.workspaceDrawer")} title={t("web.workspaceDrawer")}>
						<PanelRight className="size-4" aria-hidden="true" />
					</Button>
				) : null}
				{/* P1/P3：会话与 runtime 操作溢出菜单（任一回调存在才渲染） */}
				{actions && (actions.onRename || actions.onRestart || actions.onCompact || actions.onClone || actions.onCopyMarkdown || actions.onExportHtml || actions.onDuplicate || actions.onDelete) ? (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground hover:bg-muted/60 hover:text-foreground" aria-label={t("web.sessionMenu")} title={t("web.sessionMenu")}>
								<MoreHorizontal className="size-4" aria-hidden="true" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-52">
							{actions.onRename ? <DropdownMenuItem onClick={actions.onRename}>{t("web.rename")}</DropdownMenuItem> : null}
							{actions.onDuplicate ? <DropdownMenuItem onClick={actions.onDuplicate}>{t("web.duplicate")}</DropdownMenuItem> : null}
							{actions.onExportHtml ? <DropdownMenuItem onClick={actions.onExportHtml}>{t("web.exportHtml")}</DropdownMenuItem> : null}
							{actions.onCopyMarkdown ? <DropdownMenuItem onClick={actions.onCopyMarkdown}>{t("web.copyMarkdown")}</DropdownMenuItem> : null}
							{actions.onRestart || actions.onCompact || actions.onClone ? <DropdownMenuSeparator /> : null}
							{actions.onRestart ? <DropdownMenuItem onClick={actions.onRestart}>{t("web.restartRuntime")}</DropdownMenuItem> : null}
							{actions.onCompact ? <DropdownMenuItem onClick={actions.onCompact}>{t("web.compactContext")}</DropdownMenuItem> : null}
							{actions.onClone ? <DropdownMenuItem onClick={actions.onClone}>{t("web.cloneSession")}</DropdownMenuItem> : null}
							{actions.onDelete ? (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuItem className="text-danger focus:text-danger" onClick={actions.onDelete}>
										{t("web.deleteSession")}
									</DropdownMenuItem>
								</>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
				) : null}
				{/* 第二批：全局入口组（与会话级 actions 分开；均可选，缺失即隐藏） */}
				{onOpenSearch ? (
					<Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground hover:bg-muted/60 hover:text-foreground" onClick={onOpenSearch} aria-label={t("web.searchTitle")} title={t("web.searchTitle")}>
						<Search className="size-4" aria-hidden="true" />
					</Button>
				) : null}
				{onCycleTheme ? (
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="size-8 shrink-0 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
						onClick={onCycleTheme}
						aria-label={t("web.themeToggle")}
						title={`${t("web.themeToggle")} · ${t(themePreference === "light" ? "web.themeLight" : themePreference === "dark" ? "web.themeDark" : "web.themeSystem")}`}
					>
						{/* system 模式统一 Monitor 图标：避免系统亮暗切换时按钮闪烁换图标 */}
						{themePreference === "light" ? <Sun className="size-4" aria-hidden="true" /> : themePreference === "dark" ? <Moon className="size-4" aria-hidden="true" /> : <Monitor className="size-4" aria-hidden="true" />}
					</Button>
				) : null}
				{canInstall && onInstall ? (
					<Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground hover:bg-muted/60 hover:text-foreground" onClick={onInstall} aria-label={t("web.installApp")} title={t("web.installApp")}>
						<Download className="size-4" aria-hidden="true" />
					</Button>
				) : null}
				{onOpenAssets ? (
					<Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground hover:bg-muted/60 hover:text-foreground" onClick={onOpenAssets} aria-label={t("web.assetsTitle")} title={t("web.assetsTitle")}>
						<Puzzle className="size-4" aria-hidden="true" />
					</Button>
				) : null}
			</div>
		</header>
	);
}

/** P2：上下文用量环 — 与桌面 ContextMeter 同语义的迷你版（无 jotai 依赖）。 */
function ContextRing(props: { usage: WebContextUsage }) {
	const window = props.usage.contextWindow ?? 0;
	const tokens = props.usage.contextTokens ?? 0;
	const percent = props.usage.contextPercent ?? (window > 0 ? Math.min(100, Math.round((tokens / window) * 100)) : 0);
	const overflow = props.usage.contextOverflow === true || percent >= 100;
	// 12px 环 + 2px 描边，SVG 圆弧按 percent 扫过（-90° 起笔）
	const radius = 5;
	const circumference = 2 * Math.PI * radius;
	const dash = (Math.min(100, Math.max(0, percent)) / 100) * circumference;
	const tooltip = `${t("web.contextUsage")} ${percent}% · ${tokens.toLocaleString()} / ${window.toLocaleString()}${overflow ? ` · ${t("web.contextOverflow")}` : ""}`;
	return (
		<span className="flex size-4 shrink-0 items-center justify-center" title={tooltip} aria-label={tooltip} role="img">
			<svg viewBox="0 0 14 14" className="size-4">
				<circle cx="7" cy="7" r={radius} fill="none" strokeWidth="2" className="stroke-border" />
				<circle cx="7" cy="7" r={radius} fill="none" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${dash} ${circumference - dash}`} transform="rotate(-90 7 7)" className={overflow ? "stroke-danger" : "stroke-primary"} />
			</svg>
		</span>
	);
}

function statusLabelKey(status: WebHeaderStatus) {
	switch (status) {
		case "running":
			return "app.statusRunning" as const;
		case "starting":
			return "app.statusStarting" as const;
		case "error":
			return "app.statusError" as const;
		default:
			return "app.statusIdle" as const;
	}
}
