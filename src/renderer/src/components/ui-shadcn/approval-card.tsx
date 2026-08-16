import type { ReactNode } from "react";
import { Check, ChevronDown, ClipboardCheck, X } from "lucide-react";
import { Button } from "./button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible";
import { cn } from "../../lib/utils";

/**
 * ApprovalCard 是 AI 人在回路交互的通用外壳。
 *
 * 这里只负责 BEUI 风格的标题、折叠、取消和内容布局，不处理业务答案。
 * Ask、权限确认和后续需要用户批准的 Plan 步骤都可以复用同一外壳，
 * 这样不同阻塞点不会各自维护一套视觉和展开状态。
 */

/** 状态胶囊的语义提示：active=等待（琥珀脉动点）、success=已应答（绿色勾）、danger=已取消（红点）。 */
export type ApprovalCardStatusTone = "active" | "success" | "danger";

function StatusIndicator({ tone }: { tone: ApprovalCardStatusTone }) {
  if (tone === "success") {
    return <Check size={12} className="text-emerald-500" aria-hidden="true" />;
  }
  if (tone === "danger") {
    return <span className="inline-block size-1.5 rounded-full bg-red-500" aria-hidden="true" />;
  }
  return (
    <span className="relative flex size-1.5" aria-hidden="true">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-75" />
      <span className="relative inline-flex size-1.5 rounded-full bg-amber-500" />
    </span>
  );
}

export function ApprovalCard(props: {
	title: string;
	description?: string;
	status?: string;
	/** 状态胶囊的语义色；缺省时仅显示纯文本胶囊，不带状态点。 */
	statusTone?: ApprovalCardStatusTone;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCancel?: () => void;
	cancelLabel: string;
	cancelDisabled?: boolean;
	children: ReactNode;
	className?: string;
}) {
	return (
		<Collapsible
			open={props.open}
			onOpenChange={props.onOpenChange}
			className={cn(
				"ask-inline-bar ask-inline-bar--active relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-sm",
				props.className,
			)}
		>
			<div className="flex min-w-0 items-start gap-2 border-b border-border/70 bg-muted/25 px-3 py-1">
				<CollapsibleTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className="h-auto min-w-0 flex-1 justify-start gap-1.5 px-0 py-0.5 text-left hover:bg-transparent"
						aria-label={props.title}
					>
						<ChevronDown
							className={cn("size-3.5 shrink-0 transition-transform duration-200", !props.open && "-rotate-90")}
							aria-hidden="true"
						/>
						<ClipboardCheck className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
						<span className="min-w-0 flex-1">
							<span className="block truncate text-caption font-semibold text-foreground">{props.title}</span>
							{props.description ? <span className="block truncate text-micro font-normal text-muted-foreground">{props.description}</span> : null}
						</span>
						{props.status ? (
							<span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-1.5 py-px text-micro font-medium text-primary">
								{props.statusTone ? <StatusIndicator tone={props.statusTone} /> : null}
								{props.status}
							</span>
						) : null}
					</Button>
				</CollapsibleTrigger>
				{props.onCancel ? (
					<Button
						variant="ghost"
						size="icon-sm"
						className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
						aria-label={props.cancelLabel}
						title={props.cancelLabel}
						disabled={props.cancelDisabled}
						onClick={props.onCancel}
					>
						<X aria-hidden="true" />
					</Button>
				) : null}
			</div>
			<CollapsibleContent className="min-h-0 px-3 pb-3 pt-2">{props.children}</CollapsibleContent>
		</Collapsible>
	);
}
