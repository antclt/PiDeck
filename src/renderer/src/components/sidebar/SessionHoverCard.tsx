import { type ReactNode } from "react";
import { Calendar, Folder, Laptop } from "lucide-react";
import type { SessionRecord, SessionSummary } from "../../../../shared/types";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { formatFullDateTime } from "../../utils/relativeTime";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui-shadcn/hover-card";
import { SessionBackendMark, SessionSourceBadge } from "../session/SessionSourceBadge";

export interface SessionHoverCardProps {
	children: ReactNode;
	/** 会话摘要或记录数据（含 preview、updatedAt、source、backend 等） */
	session?: SessionSummary | SessionRecord;
	/** 所属项目/工作区名称（对应截图中的「所属空间」） */
	projectName?: string;
	/** 当前运行态状态（idle / running / error 等） */
	status?: string | null;
	/** 是否禁用浮层（例如右键菜单打开、正在拖拽或处于草稿编辑期） */
	disabled?: boolean;
	/** 移入延迟展示时间（毫秒），默认 1500ms（1.5 秒）以消除误划竞态 */
	openDelay?: number;
	/** 移出关闭延迟时间（毫秒），默认 200ms 允许鼠标平滑移入卡片复制文字 */
	closeDelay?: number;
}

/**
 * 侧栏会话悬浮预览卡片（SessionHoverCard）
 *
 * 核心交互与业务规则：
 * 1. 延迟触发：默认设置 openDelay=1500ms（1.5 秒）。鼠标快速划过侧栏列表时不会频繁触发浮层挂载
 *    与竞态渲染，只有光标在某一行停留超过 1.5 秒后才弹出卡片。
 * 2. 位置朝向：默认朝右侧弹出（side="right"），利用右侧主视口充裕空间展示，不遮挡侧栏下方的其他会话。
 * 3. 丰富信息：展示会话首轮/摘要预览文本、本地任务/来源后端标记、所属项目空间、精准更新时间。
 * 4. 状态互斥：支持 disabled 属性，在右键上下文菜单激活或拖拽时禁止浮层激活。
 */
export function SessionHoverCard({
	children,
	session,
	projectName,
	status,
	disabled = false,
	openDelay = 1500,
	closeDelay = 200,
}: SessionHoverCardProps) {
	// 没有会话数据或显式禁用时，直接渲染子元素，不挂载 HoverCard 行为
	if (!session || disabled) {
		return <>{children}</>;
	}

	const previewText = session.preview?.trim() || t("sidebar.hoverCard.emptyPreview");
	const formattedTime = session.updatedAt ? formatFullDateTime(session.updatedAt) : "";

	return (
		<HoverCard openDelay={openDelay} closeDelay={closeDelay}>
			<HoverCardTrigger asChild>{children}</HoverCardTrigger>
			<HoverCardContent
				side="right"
				align="start"
				sideOffset={10}
				className="w-84 max-w-[calc(100vw-320px)] p-3.5 shadow-xl select-text"
				onPointerDownOutside={(e) => {
					// 避免外部点击事件被误吞
					e.preventDefault();
				}}
			>
				{/* 1. 会话预览正文区 */}
				<div className="max-h-48 overflow-y-auto text-xs leading-relaxed text-foreground whitespace-pre-wrap break-words font-mono">
					{previewText}
				</div>

				{/* 2. 会话属性与标签区 */}
				<div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/50 pt-2.5 text-micro text-muted-foreground">
					{/* 本地任务 / 来源标识 */}
					<span className="inline-flex items-center gap-1 rounded bg-muted/80 px-1.5 py-0.5 text-foreground/80">
						<Laptop size={11} className="shrink-0 text-muted-foreground" aria-hidden="true" />
						<span>{t("sidebar.hoverCard.localTask")}</span>
					</span>

					{/* 后端标识（dsh / imagegen） */}
					{session.backend && session.backend !== "pi" && (
						<SessionBackendMark backend={session.backend} />
					)}

					{/* 外部导入来源（codex / claude / workbuddy 等） */}
					{session.source && session.source !== "pi" && (
						<SessionSourceBadge source={session.source} />
					)}

					{/* 运行状态（若有） */}
					{status && (
						<span
							className={cn(
								"rounded px-1.5 py-0.5 font-medium",
								status === "running" && "bg-warning/15 text-warning",
								status === "error" && "bg-danger/15 text-danger",
								status === "idle" && "bg-info/15 text-info",
							)}
						>
							{status === "running"
								? t("app.statusRunning")
								: status === "error"
									? t("app.statusError")
									: t("app.statusIdle")}
						</span>
					)}
				</div>

				{/* 3. 所属空间与项目 */}
				{projectName && (
					<div className="mt-1.5 flex items-center gap-1.5 text-micro text-muted-foreground">
						<Folder size={11} className="shrink-0 text-muted-foreground/80" aria-hidden="true" />
						<span className="truncate">
							{t("sidebar.hoverCard.workspace", { name: projectName })}
						</span>
					</div>
				)}

				{/* 4. 精确更新时间 */}
				{formattedTime && (
					<div className="mt-1 flex items-center gap-1.5 text-micro text-muted-foreground/80 tabular-nums">
						<Calendar size={11} className="shrink-0 text-muted-foreground/70" aria-hidden="true" />
						<span>{t("sidebar.hoverCard.updatedAt", { time: formattedTime })}</span>
					</div>
				)}
			</HoverCardContent>
		</HoverCard>
	);
}
