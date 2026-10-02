/**
 * WebHeader — Web 端会话头部（与桌面 SessionHeader 同布局）。
 *
 * 左侧：会话标题（截断）；右侧：运行态指示和模型/思考控制。
 * 运行态来自 useChat status（submitted/streaming）与轮询的 runtime.status 兜底。
 */
import { useState } from "react";
import { Check, ChevronsUpDown, History, Menu, MoreHorizontal, PanelRight, RefreshCw, ShieldCheck, Target } from "lucide-react";
import type { AgentBackend, AvailableModel, SessionModelPreference } from "../../../shared/types";
import { resolveModelDisplayName } from "../../../shared/modelDisplayName";
import { Button } from "@/components/ui-shadcn/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui-shadcn/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui-shadcn/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui-shadcn/select";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { SessionBackendMark } from "@/components/session/SessionSourceBadge";
import { DSH_PERMISSION_PRESETS } from "@/components/session/DshPermissionMenu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui-shadcn/dropdown-menu";
import type { WebContextUsage } from "./webTypes";

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
	model?: SessionModelPreference;
	thinkingLevel?: string;
	models: AvailableModel[];
	backend?: AgentBackend;
	refreshingModels?: boolean;
	/** P2：上下文用量环数据（由 WebChatApp 随轮询拉取；无 runtime 时不渲染）。 */
	contextUsage?: WebContextUsage;
	/** P1：DSH 当前权限预设。 */
	permissionPreset?: string;
	/** P0-P3：会话/runtime/workspace 操作回调。 */
	actions?: WebHeaderActions;
	onRefreshModels?: () => void;
	onModelChange: (model: AvailableModel) => void;
	onThinkingChange: (level: string) => void;
	onOpenDshTools?: () => void;
}) {
	const { title, status, onOpenSidebar, model, thinkingLevel, models, backend, refreshingModels, contextUsage, permissionPreset, actions, onRefreshModels, onModelChange, onThinkingChange, onOpenDshTools } = props;
	// 允许窄屏换行：标题保留可用宽度，控制项在下一行展开，避免手机上相互挤压。
	return (
		<header className="chat-header flex min-w-0 flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-2">
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
				<ModelPicker model={model} models={models} refreshing={refreshingModels} onRefresh={onRefreshModels} onChange={onModelChange} />
				<Select value={thinkingLevel ?? "off"} onValueChange={onThinkingChange}>
					<SelectTrigger size="sm" className="w-24 border-transparent bg-transparent px-2 text-caption text-muted-foreground hover:bg-muted/60" aria-label={t("web.thinking")} title={t("web.thinking")}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{thinkingLevels.map((level) => (
							<SelectItem key={level} value={level}>
								{thinkingLabel(level)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
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

function ModelPicker(props: { model?: SessionModelPreference; models: AvailableModel[]; refreshing?: boolean; onRefresh?: () => void; onChange: (model: AvailableModel) => void }) {
	const [open, setOpen] = useState(false);
	const { model, models, onChange } = props;
	const currentValue = model ? `${model.provider}::${model.modelId}` : "";
	const selectedName = model ? resolveModelDisplayName(model.modelName, model.modelId) : undefined;
	const selectedLabel = model && selectedName ? `${model.provider}/${selectedName}` : t("web.model");
	const selectedTooltip = model && selectedName ? `${selectedName} · ${model.provider}/${model.modelId}` : t("web.model");

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button type="button" variant="ghost" size="sm" className="h-8 max-w-52 min-w-0 justify-between gap-1 px-2 text-caption text-muted-foreground hover:bg-muted/60 hover:text-foreground" aria-label={t("web.model")} title={selectedTooltip}>
					<span className="min-w-0 truncate">{selectedLabel}</span>
					<ChevronsUpDown className="size-3.5 shrink-0" aria-hidden="true" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-[min(360px,calc(100vw-24px))] p-0">
				<Command>
					{/* 刷新按钮与搜索框同行：绕过缓存重新拉取模型（失败时列表保持不动） */}
					<div className="relative">
						<CommandInput placeholder={t("web.modelSearch")} className="pr-9" />
						{props.onRefresh && (
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="absolute right-1 top-1.5 shrink-0 text-muted-foreground hover:text-foreground"
								aria-label={props.refreshing ? t("app.modelPickerRefreshing") : t("app.modelPickerRefresh")}
								title={props.refreshing ? t("app.modelPickerRefreshing") : t("app.modelPickerRefresh")}
								disabled={props.refreshing}
								onClick={() => props.onRefresh?.()}
							>
								<RefreshCw size={14} className={props.refreshing ? "animate-pideck-spin" : ""} aria-hidden="true" />
							</Button>
						)}
					</div>
					<CommandList className="max-h-[min(360px,55vh)]">
						<CommandEmpty>{t("web.modelEmpty")}</CommandEmpty>
						{models.map((item) => {
							const value = `${item.provider}::${item.id}`;
							const name = resolveModelDisplayName(item.name, item.id);
							const label = `${item.provider}/${name}`;
							return (
								<CommandItem
									key={value}
									value={`${item.provider} ${name} ${item.id}`}
									title={`${name} · ${item.provider}/${item.id}`}
									onSelect={() => {
										onChange(item);
										setOpen(false);
									}}
								>
									<Check className={cn("mr-2 size-4", currentValue === value ? "opacity-100" : "opacity-0")} aria-hidden="true" />
									<span className="min-w-0 flex-1 truncate">{label}</span>
								</CommandItem>
							);
						})}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function thinkingLabel(level: string) {
	switch (level) {
		case "minimal":
			return t("thinking.levelLabel.minimal");
		case "low":
			return t("thinking.levelLabel.low");
		case "medium":
			return t("thinking.levelLabel.medium");
		case "high":
			return t("thinking.levelLabel.high");
		case "xhigh":
			return t("thinking.levelLabel.xhigh");
		case "max":
			return t("thinking.levelLabel.max");
		default:
			return t("thinking.levelLabel.off");
	}
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
