/**
 * 侧栏「分组」区：会话分组的三层树（分组 → 目录（项目）→ 会话），只读浏览。
 *
 * 数据在宿主 session-groups.json（userData/session-groups.json），写入方是会话分组插件页；
 * 这里只消费 list + onChanged：插件页保存/删除分组后实时刷新，会话失效引用由装配模型丢弃。
 * 点击会话走侧栏同一条打开链路（选中 + 按设置登记 Tab）；增删改管理仍在插件页（v1 约定）。
 */
import { ChevronRight, Folder } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { desktopApi } from "../../desktopApi";
import { projectInventoryByIdAtom } from "../../atoms/project-atoms";
import { sessionRecordsAtom } from "../../atoms/session-atoms";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { formatRelativeTime } from "../../utils/relativeTime";
import type { SessionGroup, SessionGroupColor } from "../../../../shared/types";
import type { SidebarActions } from "./SidebarContent";
import { buildSessionGroupNodes } from "./sessionGroupsModel";

/** 分组身份色（与插件页色点同值；内联样式避免 Tailwind 按名字 purge）。 */
const GROUP_COLOR_HEX: Record<SessionGroupColor, string> = {
	blue: "#3b82f6",
	green: "#16a34a",
	orange: "#ea580c",
	purple: "#7c3aed",
	red: "#dc2626",
	cyan: "#0891b2",
};

const SECTION_COLLAPSED_KEY = "sidebar.sessionGroups.sectionCollapsed";
const GROUP_COLLAPSED_KEY = "sidebar.sessionGroups.groupCollapsed";

function readIdSet(key: string): Set<string> {
	try {
		const raw = localStorage.getItem(key);
		const parsed = raw ? (JSON.parse(raw) as unknown) : [];
		return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === "string")) : new Set();
	} catch {
		return new Set();
	}
}

function writeIdSet(key: string, ids: Set<string>): void {
	try {
		localStorage.setItem(key, JSON.stringify([...ids]));
	} catch {
		/* localStorage 不可用时折叠态退化为内存态，不影响功能。 */
	}
}

export function SessionGroupsSection(props: { actions: SidebarActions; currentSessionId?: string }) {
	const records = useAtomValue(sessionRecordsAtom);
	const projectsById = useAtomValue(projectInventoryByIdAtom);
	const [groups, setGroups] = useState<SessionGroup[]>([]);
	const [sectionCollapsed, setSectionCollapsed] = useState(() => readIdSet(SECTION_COLLAPSED_KEY).has("section"));
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => readIdSet(GROUP_COLLAPSED_KEY));
	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());

	useEffect(() => {
		let disposed = false;
		const refresh = () => {
			void desktopApi.sessionGroups
				.list()
				.then((next) => {
					if (!disposed) setGroups(next);
				})
				.catch(() => undefined);
		};
		refresh();
		const unsubscribe = desktopApi.sessionGroups.onChanged(refresh);
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, []);

	const nodes = useMemo(() => buildSessionGroupNodes(groups, records, projectsById), [groups, records, projectsById]);
	// 没有任何分组（含全部失效）时整块不渲染：不给侧栏留一个永远空着的区。
	if (nodes.length === 0) return null;

	const toggleGroup = (groupId: string) => {
		setCollapsedGroups((current) => {
			const next = new Set(current);
			if (next.has(groupId)) next.delete(groupId);
			else next.add(groupId);
			writeIdSet(GROUP_COLLAPSED_KEY, next);
			return next;
		});
	};

	const rowClass = "group/row relative flex min-h-7 w-full cursor-pointer select-none items-center gap-1.5 rounded-lg border border-transparent px-2 py-0 text-left text-caption text-foreground transition-[background-color,border-color] duration-base hover:border-border-subtle hover:bg-bg-hover";

	return (
		<section aria-label={t("sidebar.sessionGroups")} className="mb-4">
			<div className="flex items-center justify-between px-1 pb-1">
				<button type="button" className="flex min-w-0 items-center gap-1 text-caption font-medium text-muted-foreground" aria-expanded={!sectionCollapsed} onClick={() => setSectionCollapsed((value) => !value)}>
					<ChevronRight size={12} className={cn("shrink-0 transition-transform", !sectionCollapsed && "rotate-90")} aria-hidden="true" />
					<span className="truncate">{t("sidebar.sessionGroups")}</span>
					<span className="text-muted-foreground/70">{nodes.length}</span>
				</button>
			</div>
			{!sectionCollapsed && (
				<div className="space-y-0.5">
					{nodes.map(({ group, total, dirs }) => {
						const collapsed = collapsedGroups.has(group.id);
						return (
							<div key={group.id}>
								<button type="button" className={cn(rowClass, "font-medium")} aria-expanded={!collapsed} onClick={() => toggleGroup(group.id)}>
									<ChevronRight size={12} className={cn("shrink-0 text-muted-foreground transition-transform", !collapsed && "rotate-90")} aria-hidden="true" />
									<span className="size-2 shrink-0 rounded-full" style={{ background: GROUP_COLOR_HEX[group.color] }} aria-hidden="true" />
									<span className="min-w-0 flex-1 truncate">{group.name}</span>
									<span className="shrink-0 text-muted-foreground/70">{total}</span>
								</button>
								{!collapsed && (
									<div className="ml-3 space-y-0.5 border-l border-border-subtle pl-2">
										{dirs.length === 0 && <div className="px-2 py-0.5 text-caption text-muted-foreground/70">{t("sidebar.sessionGroupsEmpty")}</div>}
										{dirs.map((dir) => {
											const dirKey = `${group.id}:${dir.key}`;
											const dirExpanded = expandedDirs.has(dirKey);
											return (
												<div key={dir.key}>
													<button
														type="button"
														className={rowClass}
														title={dir.path ?? dir.name}
														aria-expanded={dirExpanded}
														onClick={() =>
															setExpandedDirs((current) => {
																const next = new Set(current);
																if (next.has(dirKey)) next.delete(dirKey);
																else next.add(dirKey);
																return next;
															})
														}
													>
														<ChevronRight size={12} className={cn("shrink-0 text-muted-foreground transition-transform", dirExpanded && "rotate-90")} aria-hidden="true" />
														<Folder size={12} className="shrink-0 text-muted-foreground" aria-hidden="true" />
														<span className="min-w-0 flex-1 truncate">{dir.name}</span>
														<span className="shrink-0 text-muted-foreground/70">{dir.sessions.length}</span>
													</button>
													{dirExpanded && (
														<div className="ml-4 space-y-0.5">
															{dir.sessions.map((session) => (
																<button key={session.id} type="button" className={cn(rowClass, session.id === props.currentSessionId && "border-border-subtle bg-bg-active")} title={session.title} onClick={() => void props.actions.sessions.open(session.projectId, session.id)}>
																	<span className="min-w-0 flex-1 truncate">{session.title}</span>
																	<span className="shrink-0 text-muted-foreground/70">{formatRelativeTime(session.updatedAt)}</span>
																</button>
															))}
														</div>
													)}
												</div>
											);
										})}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}
