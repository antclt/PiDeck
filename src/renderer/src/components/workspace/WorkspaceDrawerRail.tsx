import { Fragment } from "react";
import type { ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "../ui-shadcn/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";
import { cn } from "../../lib/utils";

/**
 * 抽屉活动栏动作项：由 App 层组装（复用与 outline 相同的打开/关闭语义），
 * rail 本体只负责渲染与激活态展示，不感知具体面板业务。
 */
export type WorkspaceDrawerRailAction = {
	id: string;
	label: string;
	icon: ReactNode;
	active: boolean;
	pinned?: boolean;
	canRemove?: boolean;
	onClick: () => void;
	onTogglePinned?: () => void;
};

/**
 * 右侧抽屉活动栏（#115 pure official）：横排 tab，shadcn ghost/secondary 按钮。
 * 抽屉打开期间始终可见，无活跃会话时也能切换 files/git/browser。
 * 可移除 tab 的 X 按钮紧贴在该 tab 后面成组渲染，加号下拉收尾——
 * 不是把所有 X 堆在加号后面（2026-10 用户反馈 remove 错位）。
 * 开/关抽屉按钮留在会话 Tab 栏右侧，不进本栏。
 */
export function WorkspaceDrawerRail(props: { actions: WorkspaceDrawerRailAction[]; addLabel: string }) {
	if (props.actions.length === 0) return null;
	const optionalActions = props.actions.filter((action) => action.canRemove && action.onTogglePinned);
	const visibleActions = props.actions.filter((action) => (action.pinned ?? false) || !action.canRemove);
	return (
		<div className="drawer-activity-rail flex h-10 shrink-0 items-center gap-1 border-b border-border/40 bg-background px-2" role="tablist" aria-orientation="horizontal">
			{visibleActions.map((action) => (
				<Fragment key={action.id}>
				<Button
					type="button"
					role="tab"
					aria-selected={action.active}
					data-testid={`drawer-rail-${action.id}`}
					variant={action.active ? "secondary" : "ghost"}
					size="icon"
					className={cn("drawer-activity-rail-button relative size-8", action.active && "active")}
					title={action.label}
					aria-label={action.label}
					onClick={action.onClick}
				>
					{action.icon}
					{action.active ? <span className="pointer-events-none absolute inset-x-1.5 -bottom-1 h-0.5 rounded-full bg-foreground" aria-hidden="true" /> : null}
				</Button>
				{action.canRemove && action.pinned && action.onTogglePinned ? (
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="drawer-rail-remove size-6 text-muted-foreground"
						title={`Remove ${action.label}`}
						aria-label={`Remove ${action.label}`}
						onClick={action.onTogglePinned}
					>
						<X size={13} />
					</Button>
				) : null}
				</Fragment>
			))}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button type="button" variant="ghost" size="icon" className="size-8" title={props.addLabel} aria-label={props.addLabel}><Plus size={16} /></Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					{optionalActions.map((action) => <DropdownMenuCheckboxItem key={action.id} checked={action.pinned ?? false} onCheckedChange={() => action.onTogglePinned?.()}>{action.icon}{action.label}</DropdownMenuCheckboxItem>)}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
