import { useAtom, useAtomValue } from "jotai";
import { Clock } from "lucide-react";
import {
	automationModalOpenAtom,
	automationActiveRunsAtom,
} from "../../atoms/automation-atoms";
import { t } from "../../i18n";

/**
 * 侧栏顶部动作区的定时任务入口（新建会话 / 搜索会话下方）。
 * 有正在执行的任务时，行尾显示呼吸蓝点，避免用户还要翻底栏 Dock。
 */
export function AutomationDockButton() {
	const [, setOpen] = useAtom(automationModalOpenAtom);
	const activeRuns = useAtomValue(automationActiveRunsAtom);
	const hasActive = activeRuns.length > 0;
	const label = hasActive
		? `${t("automation.title")} (${activeRuns.length})`
		: t("automation.title");

	return (
		<button
			type="button"
			className="group flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-body text-foreground transition-colors hover:bg-muted/60"
			aria-label={label}
			title={label}
			onClick={() => setOpen(true)}
		>
			<span className="relative shrink-0">
				<Clock className="size-4 text-muted-foreground" aria-hidden="true" />
				{hasActive && (
					<span
						className="pointer-events-none absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-sky-500 animate-pulse"
						aria-hidden="true"
					/>
				)}
			</span>
			<span className="min-w-0 flex-1 truncate font-medium">{t("automation.title")}</span>
			{hasActive && (
				<span className="shrink-0 text-micro tabular-nums text-sky-500">
					{activeRuns.length}
				</span>
			)}
		</button>
	);
}
