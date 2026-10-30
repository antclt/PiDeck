import type { LucideIcon } from "lucide-react";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { t } from "../../i18n";

/**
 * 列表/面板的共享异步状态模式（Wave 2 §5.1 AsyncState）：
 * loading / empty / error / content 四态同构，消灭「错误被显示成空数据」与各页自绘空态。
 *
 * 收敛的是三个页面（收藏 / 自动化任务 / Agent 市场）已有的同构 JSX：
 * 图标槽（色块底）+ 标题 + 说明 + 可选主行动，以及 loading 居中自旋。
 * 领域差异走 props：图标、文案、action 槽，不吞并调用方的数据逻辑。
 *
 * 用法（两个具名块组件，不引入布尔分发——调用方自己 if/else 四态，语义更直白）：
 * - loading：`{loading ? <AsyncLoadingBlock/> : ...}`（role=status，屏幕阅读器可感知完成）；
 * - empty：`<AsyncEmptyBlock icon={Star} iconClassName="..." title={...} description={...} action={<Button/>}/>`；
 * - error：不在此文件——错误态带重试语义，走各面板的 role=alert 错误行（Wave 1 口径）。
 */
export function AsyncLoadingBlock(props: { className?: string; label?: string }) {
	return (
		<div className={cn("flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground", props.className)} role="status" aria-live="polite">
			<Loader2 className="size-4 animate-pideck-spin" aria-hidden="true" />
			{props.label ?? t("common.loading")}
		</div>
	);
}

export function AsyncEmptyBlock(props: {
	/** 领域图标；缺省渲染无图标的紧凑空态。 */
	icon?: LucideIcon;
	/** 图标容器类：默认 size-12 色块底（Agent 市场/自动化），收藏传 size-8 裸色。 */
	iconClassName?: string;
	title: ReactNode;
	/** 补充说明（空态引导文案）。 */
	description?: ReactNode;
	/** 主行动（如「新建」按钮）。 */
	action?: ReactNode;
	className?: string;
}) {
	const Icon = props.icon;
	return (
		<div className={cn("flex flex-col items-center justify-center gap-2 px-4 py-16 text-center", props.className)}>
			{Icon ? (
				<span className={cn("flex size-12 items-center justify-center rounded-xl bg-bg-muted text-muted-foreground", props.iconClassName)}>
					<Icon className="size-6" aria-hidden="true" />
				</span>
			) : null}
			<div className="text-sm font-semibold text-foreground">{props.title}</div>
			{props.description ? <p className="max-w-[360px] text-xs leading-6 text-muted-foreground">{props.description}</p> : null}
			{props.action ? <div className="mt-2">{props.action}</div> : null}
		</div>
	);
}
