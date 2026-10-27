import { useAtomValue } from "jotai";
import { useCallback, useMemo, useRef } from "react";
import { ChevronDown, ChevronUp, Users } from "lucide-react";
import { sessionRuntimeBySessionIdAtomFamily } from "../../atoms";
import { t } from "../../i18n";
import type { DshTeamMember, DshTeamState, DshTeamTask } from "../../../../shared/types/agent";
import { Collapsible, CollapsibleContent } from "../ui-shadcn/collapsible";
import { VirtualStack, VIRTUAL_STACK_MIN_ROWS } from "../ui-shadcn/virtual-stack";
import { ComposerWidgetFrame, useComposerWidgetCollapsed } from "./ComposerWidgetLayout";
import { TEAM_WIDGET_KEY, readTeamCollapsedPreference, writeTeamCollapsedPreference } from "../../utils/sessionTeamCollapsePreference";

/**
 * composer 上方的 Team 常驻条（agent-team 实验预设，P1 最小可用视图）。
 *
 * 数据源：官方 `agentTeam` projection 经主进程解析后的 AgentRuntimeState.dshTeam
 * （成员 roster + 任务板，见 src/main/dsh/dshTeamProjection.ts 的数据面取舍）。
 * 仅 DSH 后端且 dshTeam 有内容（成员/任务/失败记录任一非空）时渲染；
 * 未启用预设的会话该字段恒 undefined，面板自然不出现。
 * 按 sessionId 订阅 runtime atom family，多会话天然隔离（不订全局 currentSession*）。
 */

function memberPhaseLabel(member: DshTeamMember): string {
	if (member.role === "lead") return t("sessionTeam.role.lead");
	if (member.phase === "provisioning") return t("sessionTeam.phase.provisioning");
	if (member.phase === "failed") return member.error ? `${t("sessionTeam.phase.failed")} · ${member.error}` : t("sessionTeam.phase.failed");
	return t("sessionTeam.role.teammate");
}

function taskStatusLabel(task: DshTeamTask): string {
	if (task.status === "in_progress") return t("sessionTeam.task.in_progress");
	if (task.status === "completed") return t("sessionTeam.task.completed");
	if (task.status === "deleted") return t("sessionTeam.task.deleted");
	return task.ready ? t("sessionTeam.task.pending") : t("sessionTeam.blocked");
}

/** 任务状态点：进行中=品牌色、完成=成功色、删除=弱化、待处理按 ready 分弱化/警示。 */
function taskStatusDotClass(task: DshTeamTask): string {
	if (task.status === "in_progress") return "bg-[var(--color-accent)]";
	if (task.status === "completed") return "bg-[var(--color-success)]";
	if (task.status === "deleted") return "bg-text-tertiary/50";
	return task.ready ? "bg-text-tertiary/70" : "bg-[var(--color-warning)]";
}

/** 成员状态点：活跃=成功色、启动中=警示色、失败=danger 色。 */
function memberPhaseDotClass(member: DshTeamMember): string {
	if (member.phase === "provisioning") return "bg-[var(--color-warning)]";
	if (member.phase === "failed") return "bg-[var(--color-danger)]";
	return "bg-[var(--color-success)]";
}

/** 头部摘要：「n 成员 · n 任务」（删除态任务不计入，避免噪音）。导出供测试断言。 */
export function teamSummaryLabel(team: DshTeamState): string {
	const tasks = team.tasks.filter((task) => task.status !== "deleted").length;
	return t("sessionTeam.summary", { members: team.members.length, tasks });
}

/** 面板可见性：启用预设后没有任何成员/任务/失败记录时不占位（「有数据才显示」）。类型谓词兼供组件内收窄。 */
export function hasTeamContent(team: DshTeamState | null | undefined): team is DshTeamState {
	if (!team) return false;
	return team.members.length > 0 || team.tasks.length > 0 || typeof team.failure === "string";
}

export function SessionTeamStrip(props: { sessionId: string }) {
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(props.sessionId));
	// Team 条的折叠偏好跨会话共享并落盘（默认展开）：内存 context map 会随面板重挂/切会话清空，
	// 不能作为长期记忆。默认值每帧从存储读取，切到别的会话时按同一偏好解析。
	const { collapsed, toggleCollapsed } = useComposerWidgetCollapsed(TEAM_WIDGET_KEY, readTeamCollapsedPreference());
	const handleToggleCollapsed = useCallback(() => {
		// 先落盘再走 composer 通道：下一次挂载（切会话/面板重挂）按新偏好解析；
		// 反序会先按旧默认渲染一帧，出现「折叠后闪现展开」。
		writeTeamCollapsedPreference(!collapsed);
		toggleCollapsed();
	}, [collapsed, toggleCollapsed]);

	const team = runtime?.backend === "dsh" ? runtime.state?.dshTeam : undefined;
	const members = useMemo(() => team?.members ?? [], [team]);
	const tasks = useMemo(() => (team ? team.tasks.filter((task) => task.status !== "deleted") : []), [team]);

	// 成员 + 任务板压成扁平行序列交给虚拟栈：两者在同一个限高滚窗里，行数随成员/任务增长。
	// 虚拟化只在超过门槛时启用，短列表仍走原来的 flex 列（DOM 完全不变）。
	// 行里**不放文案**：`t()` 读的是模块级当前 locale，而这份 useMemo 的依赖只有数据；
	// 文案一旦在这里烘焙，切语言后这几行会停在旧语言（数据没变 → memo 不重算）。
	type TeamRow = { kind: "failure"; key: string } | { kind: "member"; key: string; member: DshTeamMember } | { kind: "tasks-header"; key: string } | { kind: "empty"; key: string } | { kind: "task"; key: string; task: DshTeamTask };
	const rows = useMemo<TeamRow[]>(() => {
		const out: TeamRow[] = [];
		if (team?.failure) out.push({ kind: "failure", key: "failure" });
		for (const member of members) out.push({ kind: "member", key: member.id, member });
		if (tasks.length > 0) out.push({ kind: "tasks-header", key: "tasks-header" });
		if (tasks.length === 0 && members.length === 0) out.push({ kind: "empty", key: "empty" });
		for (const task of tasks) out.push({ kind: "task", key: task.id, task });
		return out;
	}, [team, members, tasks]);
	const listRef = useRef<HTMLDivElement | null>(null);
	const virtualizeRows = rows.length > VIRTUAL_STACK_MIN_ROWS;
	// 提前返回必须放在**全部 hooks 之后**：DSH 会话里 team 初始为 undefined，一旦 team 出现，
	// 本次渲染会比上次多调用 useMemo/useRef → React 抛
	// "Rendered more hooks than during the previous render"，整个 composer 区崩掉。
	// （这个组件在 SessionView 里是无条件挂载的，所以不是边缘路径。）
	if (!hasTeamContent(team)) return null;

	return (
		<ComposerWidgetFrame data-testid="session-team-strip" aria-label={t("sessionTeam.title")}>
			{/* 受控呈现：折叠偏好先落 localStorage 再走 composer 通道（见 handleToggleCollapsed），
			    Radix 只承载高度动画，故不用 CollapsibleTrigger/onOpenChange 另持一份状态。 */}
			<Collapsible open={!collapsed}>
				<div className="flex h-9 w-full items-center gap-2.5 px-3">
					<button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 text-left" aria-expanded={!collapsed} onClick={handleToggleCollapsed}>
						<Users size={14} aria-hidden="true" className="shrink-0 text-text-tertiary" />
						<span className="shrink-0 text-control font-medium leading-6 text-foreground">{t("sessionTeam.title")}</span>
						<span className="min-w-0 flex-1 truncate text-control leading-5 text-text-tertiary">{teamSummaryLabel(team)}</span>
						<span className="shrink-0 text-text-tertiary" aria-hidden="true">
							{collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
						</span>
					</button>
				</div>
				<CollapsibleContent>
					<div ref={listRef} className={`mb-2 max-h-[260px] overflow-y-auto [contain:layout_paint] px-3${virtualizeRows ? "" : " flex flex-col gap-2"}`}>
						{virtualizeRows ? (
							<VirtualStack
								items={rows}
								getKey={(row) => row.key}
								scrollRef={listRef}
								minRows={VIRTUAL_STACK_MIN_ROWS}
								estimateHeight={30}
								rowClassName="pb-2"
								renderItem={(row) => {
									if (row.kind === "failure") return team?.failure ? <p className="rounded-md bg-[var(--color-danger)]/10 px-2 py-1 text-xs leading-5 text-[var(--color-danger)]">{t("sessionTeam.failure", { failure: team.failure })}</p> : null;
									if (row.kind === "member")
										return (
											<div className="flex min-w-0 items-center gap-2.5 overflow-hidden text-control leading-5">
												<span className={`size-1.5 shrink-0 rounded-full ${memberPhaseDotClass(row.member)}`} aria-hidden="true" />
												<span className="min-w-0 shrink-0 truncate font-medium text-text-secondary">{row.member.name}</span>
												<span className="min-w-0 flex-1 truncate text-xs text-text-tertiary">{memberPhaseLabel(row.member)}</span>
											</div>
										);
									if (row.kind === "tasks-header") return <p className="pt-1 text-xs font-medium uppercase tracking-wide text-text-tertiary">{t("sessionTeam.tasks")}</p>;
									if (row.kind === "empty") return <p className="text-control leading-5 text-text-tertiary">{t("sessionTeam.noTasks")}</p>;
									return (
										<div className="flex min-w-0 items-center gap-2.5 overflow-hidden text-control leading-5">
											<span className={`size-1.5 shrink-0 rounded-full transition-colors ${taskStatusDotClass(row.task)}`} aria-hidden="true" />
											<span className="min-w-0 flex-1 truncate text-text-secondary">{row.task.subject}</span>
											<span className="shrink-0 truncate text-xs text-text-tertiary">{row.task.ownerName ?? t("sessionTeam.unassigned")}</span>
										</div>
									);
								}}
							/>
						) : (
							<>
								{/* 短列表：保留原来的 flex 列与行距，DOM 与接入虚拟化前完全一致 */}
								{/* 与 todo 条同款 shrink-0 纪律：限高 flex 列 + 行 overflow-hidden 会清零
						    min-height:auto，不锁行高整列会被线性压扁（2027-01 排版事故）。 */}
								{team?.failure && <p className="shrink-0 rounded-md bg-[var(--color-danger)]/10 px-2 py-1 text-xs leading-5 text-[var(--color-danger)]">{t("sessionTeam.failure", { failure: team.failure })}</p>}
								{members.map((member) => (
									<div key={member.id} className="flex min-w-0 shrink-0 items-center gap-2.5 overflow-hidden text-control leading-5">
										<span className={`size-1.5 shrink-0 rounded-full ${memberPhaseDotClass(member)}`} aria-hidden="true" />
										<span className="min-w-0 shrink-0 truncate font-medium text-text-secondary">{member.name}</span>
										<span className="min-w-0 flex-1 truncate text-xs text-text-tertiary">{memberPhaseLabel(member)}</span>
									</div>
								))}
								{tasks.length > 0 && <p className="shrink-0 pt-1 text-xs font-medium uppercase tracking-wide text-text-tertiary">{t("sessionTeam.tasks")}</p>}
								{tasks.length === 0 && members.length === 0 && <p className="shrink-0 text-control leading-5 text-text-tertiary">{t("sessionTeam.noTasks")}</p>}
								{tasks.map((task) => (
									<div key={task.id} className="flex min-w-0 shrink-0 items-center gap-2.5 overflow-hidden text-control leading-5">
										<span className={`size-1.5 shrink-0 rounded-full transition-colors ${taskStatusDotClass(task)}`} aria-hidden="true" />
										<span className="min-w-0 flex-1 truncate text-text-secondary">{task.subject}</span>
										<span className="shrink-0 truncate text-xs text-text-tertiary">{task.ownerName ?? t("sessionTeam.unassigned")}</span>
									</div>
								))}
							</>
						)}
					</div>
				</CollapsibleContent>
			</Collapsible>
		</ComposerWidgetFrame>
	);
}
