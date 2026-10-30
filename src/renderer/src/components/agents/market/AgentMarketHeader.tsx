import { Bot, ListChecks, Plus, Search } from "lucide-react";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { PageHeader } from "../../common/PageHeader";

interface AgentMarketHeaderProps {
	query: string;
	onQueryChange: (query: string) => void;
	onCreate: () => void;
	/** 批量删除模式开关；为空时不渲染入口（例如还没有任何智能体）。 */
	onToggleSelection?: () => void;
	selectionMode?: boolean;
}

/**
 * 「智能体」页面主视图头部：标题 + 说明 + 搜索 + 新建。
 * 页面是会话 Tab 栏里的页面 Tab，关闭由 Tab 负责，头部不再放关闭按钮；
 * 划词工具设置搬到 PiDeck 设置页，这里不再有设置入口。
 */
export function AgentMarketHeader({ query, onQueryChange, onCreate, onToggleSelection, selectionMode = false }: AgentMarketHeaderProps) {
	return (
		<PageHeader
			icon={Bot}
			iconClassName="size-7 rounded-md bg-primary/10 text-primary p-1.5"
			title={t("agentMarket.title")}
			subtitle={t("agentMarket.subtitle")}
			actions={
				<>
					{onToggleSelection && (
						<Button type="button" variant={selectionMode ? "secondary" : "outline"} size="sm" className="h-8 gap-1.5 text-xs" aria-pressed={selectionMode} title={t("common.bulkSelectHint")} onClick={onToggleSelection}>
							<ListChecks className="size-3.5" aria-hidden="true" />
							{t("common.bulkSelect")}
						</Button>
					)}
					<Button type="button" size="sm" className="h-8 gap-1.5 text-xs" onClick={onCreate}>
						<Plus className="size-3.5" aria-hidden="true" />
						{t("agentMarket.create")}
					</Button>
				</>
			}
			search={
				<div className="relative">
					<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
					<Input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={t("agentMarket.searchPlaceholder")} aria-label={t("agentMarket.searchPlaceholder")} size="sm" className="pl-7 text-xs" />
				</div>
			}
		/>
	);
}
