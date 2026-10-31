import { useId } from "react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * 独立页面（收藏 / 自动化 / Agent 市场）的共享页头模式（Wave 2 §5.1）。
 *
 * 三个页面此前各自维护一份同构 `<header class="border-b px-5 py-3">`：
 * 标题行（图标 + 标题 + 徽标）+ 副标题 + 右侧动作区 + 可选搜索行。
 * 本组件只收敛结构骨架与语义槽位，不吞并领域内容：
 * - 图标：icon + iconClassName（收藏/市场用色块底，自动化用裸色图标）；
 * - 徽标：titleSuffix（Badge 等）原样插入；
 * - 右侧动作：actions 槽，调用方保持自己的按钮语义（批量/新建）；
 * - 搜索：search 槽出现时切换为两行布局（与三个页面现状一致）。
 *
 * 不做的事：不内置关闭按钮（页面 Tab 的关闭由 Tab 栏负责）、不内置搜索逻辑、
 * 不规定图标视觉——避免为了统一而改造各页面的视觉细节。
 */
export function PageHeader(props: {
	/** 语义图标；标题前的领域标识。 */
	icon: LucideIcon;
	/** 图标类覆盖：默认 size-5 裸色；收藏/市场传色块底（size-7 rounded-md bg-primary/10 p-1.5）。 */
	iconClassName?: string;
	/** 页面标题（已本地化）。 */
	title: ReactNode;
	/** 标题右侧的徽标/计数（原样插入，不包装）。 */
	titleSuffix?: ReactNode;
	/** 副标题一行说明（truncate，超出省略）。 */
	subtitle?: ReactNode;
	/** 右侧动作区（批量选择/新建等按钮组）。 */
	actions?: ReactNode;
	/** 搜索行（提供时头部变为两行布局：标题行 + 全宽搜索行）。 */
	search?: ReactNode;
	/** 逃逸口：back 按钮（编辑器子视图）等需要并入标题行的节点，插在图标前。 */
	leading?: ReactNode;
	className?: string;
}) {
	const Icon = props.icon;
	const headingId = useId();
	const hasSearchRow = props.search !== undefined;
	return (
		<header aria-labelledby={headingId} className={cn("flex shrink-0 items-start justify-between gap-4 border-b border-border/40 px-5 py-3", hasSearchRow && "flex-col gap-3", props.className)}>
			<div className="flex min-w-0 flex-col">
				<div className="flex min-w-0 items-center gap-2">
					{props.leading}
					<Icon className={cn("size-5 shrink-0 text-[var(--color-accent)]", props.iconClassName)} aria-hidden="true" />
					<h1 id={headingId} className="truncate text-base font-semibold text-foreground">
						{props.title}
					</h1>
					{props.titleSuffix}
				</div>
				{props.subtitle ? <p className="mt-1 truncate text-xs text-muted-foreground">{props.subtitle}</p> : null}
			</div>
			{props.actions ? <div className="flex shrink-0 items-center gap-1.5">{props.actions}</div> : null}
			{hasSearchRow ? <div className="w-full">{props.search}</div> : null}
		</header>
	);
}
