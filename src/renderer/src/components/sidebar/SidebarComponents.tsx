import { useState, useRef, useEffect, useMemo, type ReactNode } from "react";
import { Archive, Check, CircleAlert, CircleDot, Folder, LoaderCircle, MessageCircle } from "lucide-react";
import { t } from "../../i18n";
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
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui-shadcn/dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui-shadcn/dropdown-menu";
import { Button } from "../ui-shadcn/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui-shadcn/table";
import type { SessionSummary, Project, AgentTab } from "../../../../shared/types";
import { SessionSourceBadge, SessionBackendMark, DshSourceBadge } from "../session/SessionSourceBadge";
import { Checkbox } from "../ui-shadcn/checkbox";
import { Input } from "../ui-shadcn/input";
import { Label } from "../../components/ui-shadcn/label";
import {
	SESSION_FILTER_PILLS,
	filterSessionsByPills,
	type SessionFilterPill,
} from "../../sessionFilterPills";
import {
	mergeManagerArchived,
	sessionManagerRowKey,
	type ManagerArchivedRow,
} from "../../sessionManagerModel";

export function SessionManagerModal(props: {
	sessions: SessionSummary[];
	onClose: () => void;
	onRename: (session: SessionSummary) => void;
	onExport: (session: SessionSummary) => void;
	onDelete: (sessions: SessionSummary[]) => void;
	/** 归档会话（可恢复）；运行中的会话由主进程拒绝并抛错 */
	onArchive: (sessions: SessionSummary[]) => void;
	/** 恢复归档会话 */
	onUnarchive: (session: SessionSummary) => Promise<void>;
	/** 列出已归档会话 */
	listArchived: () => Promise<SessionSummary[]>;
	/** 列出 DSH 归档会话（归档视图用；host 目录已移入 .pideck-archive） */
	listArchivedDsh: () => Promise<Array<{ dshSessionId: string; cwd: string; archivedAt: number }>>;
	/** 恢复 DSH 归档会话（主进程移回 sessions 树并重建 catalog 记录） */
	onUnarchiveDsh: (dshSessionId: string) => Promise<void>;
}) {
	// 过滤 pill 集合：来源（pi/codex/claude/opencode）+ DSH 后端。
	// DSH 会话 source 恒为 "pi"，归属判定必须按 backend 优先（见 sessionFilterPills）。
	const [activePills, setActivePills] = useState<Set<SessionFilterPill>>(new Set(SESSION_FILTER_PILLS));
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [selectAll, setSelectAll] = useState(false);
	// 已归档视图：true 时展示归档会话并提供恢复；数据打开弹窗时按需拉取。
	const [showArchived, setShowArchived] = useState(false);
	const [archivedRows, setArchivedRows] = useState<ManagerArchivedRow[] | null>(null);

	// 按 pill 过滤（一个会话只归属一个 pill，DSH 不与 Pi 重复计数）
	const filteredSessions = useMemo(
		() => filterSessionsByPills(props.sessions, activePills),
		[props.sessions, activePills],
	);

	const togglePill = (pill: SessionFilterPill) => {
		setActivePills((prev) => {
			const next = new Set(prev);
			if (next.has(pill)) {
				next.delete(pill);
			} else {
				next.add(pill);
			}
			return next;
		});
		setSelected(new Set());
		setSelectAll(false);
	};

	// 全选/取消全选（只在当前过滤后的范围内；行身份用稳定记录 id，DSH 无 filePath 不冲突）
	const handleToggleAll = () => {
		if (selectAll) {
			setSelected(new Set());
		} else {
			setSelected(new Set(filteredSessions.map((s) => s.id)));
		}
		setSelectAll(!selectAll);
	};

	const handleToggle = (sessionId: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(sessionId)) {
				next.delete(sessionId);
			} else {
				next.add(sessionId);
			}
			setSelectAll(next.size === filteredSessions.length);
			return next;
		});
	};

	const handleDeleteSelected = () => {
		const toDelete = props.sessions.filter((s) => selected.has(s.id));
		if (toDelete.length === 0) return;
		props.onDelete(toDelete);
	};

	// 归档视图数据：pi（文件归档）+ DSH（host 目录归档）合并加载，恢复后重新拉取。
	const loadArchivedRows = () => {
		void Promise.all([props.listArchived(), props.listArchivedDsh()])
			.then(([piSessions, dshItems]) => setArchivedRows(mergeManagerArchived(piSessions, dshItems)))
			.catch(() => setArchivedRows([]));
	};

	return (
		<Dialog open onOpenChange={(next) => !next && props.onClose()}>
			<DialogContent showCloseButton={false} size="xl" className={cn("flex flex-col gap-0 overflow-hidden p-0")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle>{t("menu.manageSessions")}</DialogTitle>
					<div className="flex items-center gap-2">
						<small className="text-muted-foreground">
							{filteredSessions.length} / {props.sessions.length} sessions
						</small>
						<DialogClose asChild>
							<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
								<X size={18} strokeWidth={2.2} aria-hidden="true" />
							</Button>
						</DialogClose>
					</div>
				</DialogHeader>
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden border-none bg-transparent shadow-none">
				<div className="flex shrink-0 items-center justify-between border-b border-border-subtle bg-bg-muted px-5 py-2.5">
					<div className="flex items-center gap-3.5">
						{!showArchived && (
							<>
								<Label className="flex cursor-pointer items-center gap-2 text-control text-text-secondary select-none">
									<Checkbox
										checked={selectAll}
										onCheckedChange={handleToggleAll}
									className="m-0 size-[15px] cursor-pointer accent-[var(--color-accent)]" />
									{t("common.selectAll")}
								</Label>
								<div className="flex items-center gap-1">
									{SESSION_FILTER_PILLS.map((pill) => (
										<Button
											key={pill}
											variant="outline"
											size="sm"
											className={`h-auto rounded-full border border-border-subtle bg-transparent px-3 py-1 text-caption font-medium text-text-tertiary transition-all duration-150 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]${activePills.has(pill) ? " border-[var(--color-accent)] bg-bg-active font-semibold text-[var(--color-accent)]" : ""}`}
											onClick={() => togglePill(pill)}
										>
											{t(pill === "dsh" ? "sessionBackend.dsh" : `sessionSource.${pill}`)}
										</Button>
									))}
								</div>
							</>
						)}
					</div>
					<div className="flex items-center gap-2">
						{!showArchived && selected.size > 0 && (
							<Button
								variant="outline" size="sm" className="h-auto gap-1 border border-border-subtle px-3 py-1 text-caption font-medium text-text-tertiary transition-all duration-150 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
								onClick={() => {
									// 批量归档选中行（与删除同粒度）；运行中会话由主进程拒绝并提示
									const toArchive = props.sessions.filter((s) => selected.has(s.id));
									if (toArchive.length > 0) props.onArchive(toArchive);
								}}
							>
								{t("sessionManager.archiveSelected", { count: selected.size })}
							</Button>
						)}
						{!showArchived && selected.size > 0 && (
							<Button
								variant="outline" size="sm" className="h-auto gap-1 border border-[color-mix(in_srgb,var(--color-danger)_28%,transparent)] px-3 py-1 text-caption font-medium text-[var(--color-danger)] shadow-none transition-all duration-150 hover:border-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
								onClick={handleDeleteSelected}
							>
								{t("common.deleteSelected", { count: selected.size })}
							</Button>
						)}
						<Button
							variant="outline"
							size="sm"
							className={`h-auto gap-1 rounded-full border border-border-subtle bg-transparent px-3 py-1 text-caption font-medium transition-all duration-150 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]${showArchived ? " border-[var(--color-accent)] bg-bg-active font-semibold text-[var(--color-accent)]" : " text-text-tertiary"}`}
							onClick={() => {
								if (showArchived) {
									setShowArchived(false);
								} else {
									// 打开归档视图时懒加载归档列表（pi 文件归档 + DSH host 目录归档）
									if (archivedRows === null) loadArchivedRows();
									setShowArchived(true);
								}
							}}
						>
							<Archive size={13} aria-hidden="true" />
							{t("sessionManager.archived")}
						</Button>
					</div>
				</div>

				<div className="flex-1 overflow-y-auto bg-bg-muted [scrollbar-gutter:stable]">
					{showArchived ? (
						<Table>
							<TableHeader>
								<TableRow className="bg-bg-muted hover:bg-bg-muted">
									<TableHead className="w-full">{t("sessionManager.session")}</TableHead>
									<TableHead className="w-40 text-right">{t("sessionManager.actions")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{archivedRows === null ? (
									<TableRow><TableCell colSpan={2} className="py-6 text-center text-caption text-muted-foreground">…</TableCell></TableRow>
								) : archivedRows.length === 0 ? (
									<TableRow><TableCell colSpan={2} className="py-6 text-center text-caption text-muted-foreground">{t("sessionManager.archivedEmpty")}</TableCell></TableRow>
								) : archivedRows.map((row) => (
									<TableRow key={row.kind === "pi" ? sessionManagerRowKey(row.session) : row.dshSessionId} className="bg-bg-panel">
										<TableCell className="w-full max-w-0">
											{row.kind === "pi" ? (
												<div className="flex min-w-0 items-center gap-2">
													<span className="truncate text-control text-text-primary">
														{row.session.name || row.session.preview?.slice(0, 60) || t("common.untitled")}
													</span>
													{row.session.source && row.session.source !== "pi" && <SessionSourceBadge source={row.session.source} />}
												</div>
											) : (
												// DSH 归档行：manifest 只存 host id 与原 cwd，展示与配置页归档区一致
												<div className="flex min-w-0 items-center gap-2">
													<span className="truncate text-control text-text-primary" title={row.cwd}>
														<span className="font-medium">{row.dshSessionId}</span>
														{row.cwd && <span className="ml-2 text-caption text-text-secondary">{row.cwd}</span>}
													</span>
													<SessionBackendMark backend="dsh" />
												</div>
											)}
										</TableCell>
										<TableCell className="w-40 text-right">
											<div className="flex items-center justify-end gap-0.5">
												<Button
														variant="ghost" size="sm" className="h-auto gap-[3px] rounded-[4px] px-2 text-caption text-text-tertiary transition-all duration-150 hover:bg-bg-hover hover:text-[var(--color-accent)]"
														onClick={() => {
														// 恢复后重新拉取归档列表（主列表由 catalog refresh 自动更新）
														const restored = row.kind === "pi"
															? props.onUnarchive(row.session)
															: props.onUnarchiveDsh(row.dshSessionId);
														void restored.then(loadArchivedRows);
													}}
														title={t("sessionManager.restore")}
													>
														{t("sessionManager.restore")}
													</Button>
											</div>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					) : (
						<Table>
						<TableHeader>
							<TableRow className="bg-bg-muted hover:bg-bg-muted">
								<TableHead className="w-10" />
								<TableHead className="w-full">{t("sessionManager.session")}</TableHead>
								<TableHead className="w-40 text-right">{t("sessionManager.actions")}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{filteredSessions.map((session) => {
								const isChecked = selected.has(session.id);
								return (
									<TableRow
										key={sessionManagerRowKey(session)}
										className="group bg-bg-panel"
										data-state={isChecked ? "selected" : undefined}
									>
										<TableCell className="w-10">
											<Label className="flex shrink-0 cursor-pointer items-center">
												<Checkbox
													checked={isChecked}
													onCheckedChange={() => handleToggle(session.id)}
													className="m-0 size-[15px] cursor-pointer accent-[var(--color-accent)]"
												/>
											</Label>
										</TableCell>
										<TableCell className="w-full max-w-0">
											<div
												className="flex min-w-0 cursor-pointer items-center gap-2"
												onClick={() => handleToggle(session.id)}
											>
												<span className="truncate text-control text-text-primary">
													{session.name || session.preview?.slice(0, 60) || t("common.untitled")}
												</span>
												{session.backend === "dsh" ? (
													// DSH 会话无来源徽标（source 恒为 pi），用后端徽标区分（与侧栏树一致）
													<SessionBackendMark backend="dsh" />
												) : session.source && session.source !== "pi" && (
													<SessionSourceBadge source={session.source} />
												)}
											</div>
										</TableCell>
										<TableCell className="w-40 text-right">
											<div className="flex items-center justify-end gap-0.5">
												<Button
													variant="ghost" size="sm" className="h-auto gap-[3px] rounded-[4px] px-2 text-caption text-text-tertiary transition-all duration-150 hover:bg-bg-hover hover:text-[var(--color-accent)]"
													onClick={() => props.onRename(session)}
													title={t("common.rename")}
												>
													{t("common.rename")}
												</Button>
												<Button
													variant="ghost" size="sm" className="h-auto gap-[3px] rounded-[4px] px-2 text-caption text-text-tertiary transition-all duration-150 hover:bg-bg-hover hover:text-[var(--color-accent)]"
													onClick={() => props.onExport(session)}
													title={t("menu.exportHtml")}
												>
													{t("menu.exportHtml")}
												</Button>
												<Button
													variant="ghost" size="sm" className="h-auto gap-[3px] rounded-[4px] px-2 text-caption text-text-tertiary transition-all duration-150 hover:bg-bg-hover hover:text-[var(--color-accent)]"
													onClick={() => props.onArchive([session])}
													title={t("sessionManager.archiveAction")}
												>
													<Archive size={12} aria-hidden="true" />
													{t("sessionManager.archiveAction")}
												</Button>
												<Button
													variant="ghost" size="sm" className="h-auto gap-[3px] rounded-[4px] px-2 text-caption text-text-tertiary transition-all duration-150 hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)]"
													onClick={() => props.onDelete([session])}
													title={t("common.delete")}
												>
													{t("common.delete")}
												</Button>
											</div>
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
						</Table>
					)}
				</div>
			</div>
			</DialogContent>
		</Dialog>
	);
}

/**
 * 右键菜单外壳（#115 U5）：统一 Radix DropdownMenu + 虚拟坐标 Trigger。
 * 视口碰撞翻转/焦点圈定/ESC 关闭全部由 Radix 负责；旧 useMenuPosition
 * 手写测尺寸翻转逻辑与 context-backdrop 遮罩已删除。
 * 触发器不可见但提供定位矩形（Radix dropdown-menu 无独立 Anchor 部件）。
 */
function MenuShell(props: { x: number; y: number; onClose: () => void; className?: string; children: ReactNode }) {
	return (
		<DropdownMenu open onOpenChange={(open) => { if (!open) props.onClose(); }}>
			<DropdownMenuTrigger
				aria-hidden
				tabIndex={-1}
				style={{ position: "fixed", left: props.x, top: props.y, width: 0, height: 0, padding: 0, border: 0, background: "transparent", pointerEvents: "none" }}
			/>
			<DropdownMenuContent align="start" side="bottom" className={props.className}>
				{props.children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function SessionSourceFilterMenu(props: {
	menu: { projectId: string; x: number; y: number };
	filter: ReadonlySet<SessionFilterPill> | null;
	onToggleSource: (source: SessionFilterPill) => void;
	onClear: () => void;
	onClose: () => void;
}) {
	// 过滤类别 = 来源 + DSH 后端（DSH 会话 source 恒为 pi，必须按 backend 独立归类，
	// 否则「只选 Pi」会继续显示 DSH 会话，用户无法单独过滤）。
	const sources = SESSION_FILTER_PILLS;
	// 过滤菜单需要连续勾选，onSelect preventDefault 保持菜单打开
	return (
		<MenuShell x={props.menu.x} y={props.menu.y} onClose={props.onClose} className="min-w-44">
			<DropdownMenuLabel>{t("menu.filterSessions")}</DropdownMenuLabel>
			<DropdownMenuCheckboxItem
				checked={props.filter === null}
				onSelect={(event) => event.preventDefault()}
				onCheckedChange={(checked) => { if (checked) props.onClear(); }}
			>
				{t("menu.filterSourceAll")}
			</DropdownMenuCheckboxItem>
			<DropdownMenuSeparator />
			{sources.map((pill) => (
				<DropdownMenuCheckboxItem
					key={pill}
					checked={props.filter !== null && props.filter.has(pill)}
					onSelect={(event) => event.preventDefault()}
					onCheckedChange={() => props.onToggleSource(pill)}
				>
					{pill === "dsh" ? <DshSourceBadge /> : <SessionSourceBadge source={pill} />}
				</DropdownMenuCheckboxItem>
			))}
		</MenuShell>
	);
}

export function ProjectContextMenu(props: {
	menu: { x: number; y: number; project: Project };
	onClose: () => void;
	onRevealProject: () => void;
	onOpenWithEditor: () => void;
	onImportCodexSessions: () => void;
	onImportClaudeSessions: () => void;
	onImportOpenCodeSessions: () => void;
	onManageProjectResources: () => void;
	onManageSessions: () => void;
	onFilterSessions: () => void;
	onToggleWorktree: () => void;
	onRefreshProject: () => void;
	onCopyProjectPath: () => void;
	onRemoveProject: () => void;
}) {
	const isWorktreeEnabled = props.menu.project.worktreeEnabled ?? false;
	return (
		<MenuShell x={props.menu.x} y={props.menu.y} onClose={props.onClose}>
			<DropdownMenuItem onSelect={props.onRevealProject}>{t("menu.revealProject")}</DropdownMenuItem>
			<DropdownMenuItem onSelect={props.onOpenWithEditor}>{t("app.openWithEditor")}</DropdownMenuItem>
			<DropdownMenuItem onSelect={props.onImportCodexSessions}>{t("menu.importCodex")}</DropdownMenuItem>
			<DropdownMenuItem onSelect={props.onImportClaudeSessions}>{t("menu.importClaude")}</DropdownMenuItem>
			<DropdownMenuItem onSelect={props.onImportOpenCodeSessions}>{t("menu.importOpenCode")}</DropdownMenuItem>
			<DropdownMenuSeparator />
			<DropdownMenuItem onSelect={props.onManageProjectResources}>{t("menu.projectResources")}</DropdownMenuItem>
			<DropdownMenuItem onSelect={props.onManageSessions}>{t("menu.manageSessions")}</DropdownMenuItem>
			<DropdownMenuSeparator />
			<DropdownMenuItem onSelect={props.onFilterSessions}>{t("menu.filterSessions")}</DropdownMenuItem>
			<DropdownMenuSeparator />
			<DropdownMenuItem onSelect={props.onToggleWorktree}>
				{isWorktreeEnabled ? t("menu.disableWorktree") : t("menu.enableWorktree")}
			</DropdownMenuItem>
			<DropdownMenuSeparator />
			<DropdownMenuItem onSelect={props.onCopyProjectPath}>{t("menu.copyProjectPath")}</DropdownMenuItem>
			<DropdownMenuItem onSelect={props.onRefreshProject}>{t("app.projectRefresh")}</DropdownMenuItem>
			<DropdownMenuSeparator />
			<DropdownMenuItem variant="destructive" onSelect={props.onRemoveProject}>{t("menu.removeProject")}</DropdownMenuItem>
		</MenuShell>
	);
}

export function AgentContextMenu(props: {
	menu: { x: number; y: number; agent: AgentTab };
	actionLoading?: "copy" | "export" | null;
	onClose: () => void;
	onRename: () => void;
	onExport: () => void;
	onCopySession: () => void;
	onCopySessionFilePath: () => void;
	/** 打开 RPC 日志：未开启时先开启记录，再弹“已打开”提醒框（含查看入口） */
	onOpenRpcLogging?: () => void;
	/** 切换式 RPC 日志开关（SidebarContent 当前实现），与 onOpenRpcLogging 兼容共存 */
	onToggleRpcLogging?: () => void;
	/** 未启动（无 live runtime）的 agent 不能开启记录：菜单项置灰并给出说明 */
	rpcToggleDisabled?: boolean;
	isRpcLogging?: boolean;
	/** 打开实时日志查看弹窗（仅开启记录后可用） */
	onOpenLogs?: () => void;
	onOpenSessionFile?: () => void;
	onCloseAgent: () => void;
	/** 运行中也可删：主进程先停后删，不必先关 Agent。 */
	onDeleteSession?: () => void;
}) {
	const busy = Boolean(props.actionLoading);
	return (
		<MenuShell x={props.menu.x} y={props.menu.y} onClose={props.onClose}>
			<DropdownMenuItem disabled={busy} onSelect={props.onRename}>{t("common.rename")}</DropdownMenuItem>
			{/* DSH 运行中会话的复制走 clone 分流（fork 无锚点完整副本），保留入口；
			    导出 HTML 无 DSH 实现（G10 待决策），对 dsh agent 隐藏 */}
			<DropdownMenuItem disabled={busy} onSelect={props.onCopySession}>
				{props.actionLoading === "copy" && <span className="mini-loader" />}
				{props.actionLoading === "copy" ? t("menu.copying") : t("menu.copySession")}
			</DropdownMenuItem>
			{props.menu.agent.backend !== "dsh" && (
				<DropdownMenuItem disabled={busy} onSelect={props.onExport}>
					{props.actionLoading === "export" && <span className="mini-loader" />}
					{props.actionLoading === "export" ? t("menu.exporting") : t("menu.exportHtml")}
				</DropdownMenuItem>
			)}
			{props.menu.agent.sessionPath && (
				<>
					<DropdownMenuItem disabled={busy} onSelect={props.onCopySessionFilePath}>
						{t("menu.copySessionFilePath")}
					</DropdownMenuItem>
					{/* DSH 会话文件是 zstd 压缩的持久化日志，系统默认程序打开无意义：只留复制 */}
					{props.menu.agent.backend !== "dsh" && (
						<DropdownMenuItem disabled={busy} onSelect={props.onOpenSessionFile}>
							{t("menu.openAgentSessionFile")}
						</DropdownMenuItem>
					)}
				</>
			)}
			<DropdownMenuSeparator />
			<DropdownMenuItem
				disabled={busy || props.rpcToggleDisabled}
				// 置灰时仍给出原因提示，避免用户以为功能坏了
				title={props.rpcToggleDisabled ? t("menu.rpcLoggingRequiresRuntime") : undefined}
				onSelect={props.onToggleRpcLogging ?? props.onOpenRpcLogging}
			>
				{props.isRpcLogging ? t("menu.rpcLoggingOn") : t("menu.rpcLogging")}
			</DropdownMenuItem>
			{props.isRpcLogging && (
				<DropdownMenuItem disabled={busy} onSelect={props.onOpenLogs}>
					{t("menu.rpcLogView")}
				</DropdownMenuItem>
			)}
			<DropdownMenuSeparator />
			<DropdownMenuItem variant="destructive" onSelect={props.onCloseAgent}>{t("menu.closeAgent")}</DropdownMenuItem>
			{props.onDeleteSession && (
				<DropdownMenuItem variant="destructive" disabled={busy} onSelect={props.onDeleteSession}>
					{t("common.delete")}
				</DropdownMenuItem>
			)}
		</MenuShell>
	);
}

export function DraftSessionContextMenu(props: {
	menu: { x: number; y: number };
	onClose: () => void;
	onDelete: () => void;
}) {
	return (
		<MenuShell x={props.menu.x} y={props.menu.y} onClose={props.onClose}>
			<DropdownMenuItem variant="destructive" onSelect={props.onDelete}>{t("common.delete")}</DropdownMenuItem>
		</MenuShell>
	);
}

export function SessionContextMenu(props: {
	menu: { x: number; y: number; session: SessionSummary };
	actionLoading?: "copy" | "export" | null;
	onClose: () => void;
	onRename: () => void;
	onExport: () => void;
	onCopySession: () => void;
	onCopySessionFilePath: () => void;
	onOpenSessionFile?: () => void;
	/** 打开会话代理设置弹框（菜单项「会话代理」） */
	onOpenProxySetting?: () => void;
	/** 会话是否有文件路径（DSH 会话无 pi 会话文件：隐藏「复制路径/打开文件」） */
	hasFilePath?: boolean;
	/** RPC 日志菜单组（与 AgentContextMenu 同语义）：仅会话有 live runtime 时显示 */
	canRpcLog?: boolean;
	rpcToggleDisabled?: boolean;
	isRpcLogging?: boolean;
	/** 打开 RPC 日志：未开启时先开启记录，再弹“已打开”提醒框（含查看入口） */
	onOpenRpcLogging?: () => void;
	/** 切换式 RPC 日志开关（SidebarContent 当前实现），与 onOpenRpcLogging 兼容共存 */
	onToggleRpcLogging?: () => void;
	onOpenLogs?: () => void;
	onArchiveSession: () => void;
	onDeleteSession: () => void;
}) {
	const busy = Boolean(props.actionLoading);
	// 历史会话（无 runtime）不展示 RPC 日志项：没有运行中的 pi 子进程就无日志可记/可看
	const showRpcGroup = Boolean(props.canRpcLog);
	return (
		<MenuShell x={props.menu.x} y={props.menu.y} onClose={props.onClose}>
			<DropdownMenuItem disabled={busy} onSelect={props.onRename}>{t("common.rename")}</DropdownMenuItem>
			{/* DSH 历史会话无宿主文件可复制/导出（主进程显式拒绝，A8/A9）：隐藏入口 */}
			<DropdownMenuItem disabled={busy} onSelect={props.onOpenProxySetting}>{t("menu.sessionProxy")}</DropdownMenuItem>
			{props.menu.session.backend !== "dsh" && (
				<DropdownMenuItem disabled={busy} onSelect={props.onCopySession}>
					{props.actionLoading === "copy" && <span className="mini-loader" />}
					{props.actionLoading === "copy" ? t("menu.copying") : t("menu.copySession")}
				</DropdownMenuItem>
			)}
			{props.menu.session.backend !== "dsh" && (
				<DropdownMenuItem disabled={busy} onSelect={props.onExport}>
					{props.actionLoading === "export" && <span className="mini-loader" />}
					{props.actionLoading === "export" ? t("menu.exporting") : t("menu.exportHtml")}
				</DropdownMenuItem>
			)}
			{props.hasFilePath !== false && (
				<>
					<DropdownMenuSeparator />
					<DropdownMenuItem disabled={busy} onSelect={props.onCopySessionFilePath}>
						{t("menu.copySessionFilePath")}
					</DropdownMenuItem>
					{/* DSH 会话文件是 zstd 压缩的持久化日志，系统默认程序打开无意义：只留复制 */}
					{props.menu.session.backend !== "dsh" && (
						<DropdownMenuItem disabled={busy} onSelect={props.onOpenSessionFile}>
							{t("menu.openSessionFile")}
						</DropdownMenuItem>
					)}
				</>
			)}
			{showRpcGroup && (
				<>
					<DropdownMenuItem
						disabled={busy || props.rpcToggleDisabled}
						// 置灰时仍给出原因提示，避免用户以为功能坏了
						title={props.rpcToggleDisabled ? t("menu.rpcLoggingRequiresRuntime") : undefined}
						onSelect={props.onToggleRpcLogging ?? props.onOpenRpcLogging}
					>
						{props.isRpcLogging ? t("menu.rpcLoggingOn") : t("menu.rpcLogging")}
					</DropdownMenuItem>
					{props.isRpcLogging && (
						<DropdownMenuItem disabled={busy} onSelect={props.onOpenLogs}>
							{t("menu.rpcLogView")}
						</DropdownMenuItem>
					)}
				</>
			)}
			<DropdownMenuSeparator />
			<DropdownMenuItem disabled={busy} onSelect={props.onArchiveSession}>
				{t("menu.archiveSession")}
			</DropdownMenuItem>
			<DropdownMenuItem variant="destructive" disabled={busy} onSelect={props.onDeleteSession}>
				{t("common.delete")}
			</DropdownMenuItem>
		</MenuShell>
	);
}
export function ProjectAvatar(props: {
	name: string;
	kind?: "chat" | "project";
	status?: "idle" | "running" | "starting" | "error";
}) {
	const StatusIcon = props.status === "running"
		? LoaderCircle
		: props.status === "starting"
			? CircleDot
			: props.status === "error"
				? CircleAlert
				: null;
	return (
		<div
			className={cn(
				"conversation-avatar project-avatar relative",
				props.kind === "chat" && "chat-avatar",
				props.status && `avatar-status-${props.status}`,
			)}
			title={t("app.projectAvatarTitle", { name: props.name })}
			data-avatar-status={props.status ?? "idle"}
		>
			{props.kind === "chat" ? (
				<MessageCircle size={16} strokeWidth={1.9} />
			) : (
				<Folder size={16} strokeWidth={1.8} />
			)}
			{StatusIcon && (
				<span className="avatar-status-indicator" aria-label={props.status}>
					<StatusIcon size={8} strokeWidth={2.5} className={props.status === "running" ? "animate-spin" : undefined} />
				</span>
			)}
		</div>
	);
}

type EntryAction = {
	active?: boolean;
	label: string;
	onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
	icon: ReactNode;
};
export function WorktreeCreateDialog(props: {
	projectId: string;
	creating: boolean;
	onCreate: (branchName: string) => void;
	onClose: () => void;
}) {
	const [name, setName] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	// 预览最终创建的分支名，与后端 WorktreeService.slugify 保持一致：
	// 保留 Unicode 字母数字，其余字符替换为 -。让用户在提交前看到中文/特殊字符的实际结果，
	// 避免输入与最终分支名脱节。
	const previewSlug = useMemo(() => {
		const slug = name
			.trim()
			.replace(/[^\p{L}\p{N}]+/gu, "-")
			.replace(/^-+/, "")
			.replace(/-+$/, "");
		return slug || "workspace";
	}, [name]);

	// #115 U5：外壳换 shadcn Dialog；分支名预览逻辑不变
	return (
		<Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
			<DialogContent className="sm:max-w-sm worktree-create-dialog">
				<DialogHeader>
					<DialogTitle>{t("app.worktreeCreateTitle")}</DialogTitle>
				</DialogHeader>
				<Input
					ref={inputRef}
					type="text"
					className="worktree-create-input"
					placeholder={t("app.worktreeCreatePlaceholder")}
					value={name}
					onChange={(e) => setName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && name.trim()) {
							props.onCreate(name.trim());
						}
						if (e.key === "Escape") props.onClose();
					}}
					disabled={props.creating}
				/>
				{name.trim() && (
					<p className="worktree-create-preview">
						{t("app.worktreeBranchPreview", { name: previewSlug })}
					</p>
				)}
				<DialogFooter>
					<Button variant="outline" onClick={props.onClose} disabled={props.creating}>
						{t("common.cancel")}
					</Button>
					<Button
						disabled={!name.trim() || props.creating}
						onClick={() => props.onCreate(name.trim())}
					>
						{props.creating ? t("app.worktreeCreating") : t("app.worktreeCreate")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * RPC 日志已打开提醒弹框：开启记录后告知用户已可查看，
 * “查看日志”直接打开实时日志查看弹窗（RpcLogViewer）。
 */
export function RpcLogOpenedDialog(props: {
	onView: () => void;
	onClose: () => void;
}) {
	return (
		<AlertDialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{t("rpc.logOpenedTitle")}</AlertDialogTitle>
					<AlertDialogDescription>{t("rpc.logOpenedDescription")}</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel onClick={props.onClose}>
						{t("common.cancel")}
					</AlertDialogCancel>
					<AlertDialogAction onClick={props.onView}>
						{t("rpc.logViewNow")}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
