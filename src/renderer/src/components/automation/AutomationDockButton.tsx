import { useAtom, useAtomValue } from "jotai";
import { Clock } from "lucide-react";
import {
	automationModalOpenAtom,
	automationActiveRunsAtom,
} from "../../atoms/automation-atoms";
import { Button } from "../ui-shadcn/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui-shadcn/tooltip";
import { t } from "../../i18n";

/**
 * 侧栏底栏 Dock 上的定时任务入口按钮。
 * 当有正在执行的任务时，呈现呼吸蓝点角标与计数提示。
 */
export function AutomationDockButton() {
	const [, setOpen] = useAtom(automationModalOpenAtom);
	const activeRuns = useAtomValue(automationActiveRunsAtom);
	const hasActive = activeRuns.length > 0;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<div className="relative size-full">
					<Button
						type="button"
						variant="ghost"
						className="size-full rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
						title={t("automation.title")}
						aria-label={t("automation.title")}
						onClick={() => setOpen(true)}
					>
						<Clock className="size-4" />
					</Button>
					{hasActive && (
						<span
							className="pointer-events-none absolute right-1 top-1 size-2 rounded-full bg-sky-500 animate-pulse"
							aria-hidden="true"
						/>
					)}
				</div>
			</TooltipTrigger>
			<TooltipContent side="top">
				{hasActive
					? `${t("automation.title")} (${activeRuns.length})`
					: t("automation.title")}
			</TooltipContent>
		</Tooltip>
	);
}
