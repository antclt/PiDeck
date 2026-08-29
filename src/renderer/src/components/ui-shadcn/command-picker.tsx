import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronsDownUp, ChevronsUpDown, ChevronDown, ChevronRight, X } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "./button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandList,
} from "./command";
import { cn } from "../../lib/utils";
import {
	INITIAL_PICKER_GROUP_SELECTION,
	applyPickerGroupAction,
	resolveGroupExpanded,
	type PickerGroupSelection,
} from "./commandPickerExpansion";

type CommandPickerContextValue = {
	searchActive: boolean;
	selection: PickerGroupSelection;
	defaultExpandedIds: ReadonlySet<string> | null;
	toggleGroup: (id: string) => void;
};

const CommandPickerContext = createContext<CommandPickerContextValue>({
	searchActive: false,
	selection: INITIAL_PICKER_GROUP_SELECTION,
	defaultExpandedIds: null,
	toggleGroup: () => undefined,
});

/**
 * 可折叠的 Command 分组。折叠状态是「派生状态 + 用户覆盖」：未覆盖的分组跟随面板的
 * 默认展开集合（defaultExpandedIds，数据异步到达后自动生效），用户切换过的分组优先。
 */
export function CommandPickerGroup(props: {
	id: string;
	label: ReactNode;
	count?: number;
	/** 数量的解释文案（如「3 个模型」）；缺省显示裸数字。 */
	countText?: ReactNode;
	/**
	 * 行尾附加内容（渲染在最右端）：供应商用量等「属于整行」的次要信息放这里，
	 * 不要塞进 label（label 是截断主体）。布局：名称 · 数量 …… 用量（最右）。
	 */
	trailing?: ReactNode;
	defaultOpen?: boolean;
	children: ReactNode;
	className?: string;
}) {
	const { searchActive, selection, defaultExpandedIds, toggleGroup } = useContext(CommandPickerContext);
	const expanded = resolveGroupExpanded({
		selection,
		defaultExpandedIds,
		searchActive,
		groupId: props.id,
	});

	return (
		<div className={cn("border-b border-border/45 last:border-b-0", props.className)}>
			<button
				type="button"
				className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-1.5 text-left text-control font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
				aria-expanded={expanded}
				onClick={() => toggleGroup(props.id)}
			>
				{expanded ? <ChevronDown className="size-3.5 flex-none" aria-hidden="true" /> : <ChevronRight className="size-3.5 flex-none" aria-hidden="true" />}
				<span className="max-w-[45%] flex-none truncate">{props.label}</span>
				{props.count != null && (
					<span className="flex-none font-mono text-caption text-muted-foreground/70">
						{props.countText ?? props.count}
					</span>
				)}
				{/* 弹性空隙：把 trailing（用量等）推到行最右，与名称/数量分开，避免挤在一起 */}
				<span className="min-w-4 flex-1" />
				{props.trailing}
			</button>
			{expanded && <CommandGroup className="p-1">{props.children}</CommandGroup>}
		</div>
	);
}

/**
 * Command 选择器主体：统一标题、搜索、折叠控制、选中项定位、列表空态和底部操作区。
 * Dialog、Popover 只负责浮层容器，因此引导页和会话内选择器使用完全相同的内容结构。
 */
export function CommandPickerPanel(props: {
	title: ReactNode;
	hint?: ReactNode;
	searchPlaceholder: string;
	emptyLabel: ReactNode;
	value?: string;
	onValueChange?: (value: string) => void;
	onClose?: () => void;
	showGroupActions?: boolean;
	/** 标题栏操作（模型列表手动刷新等）；置于折叠/展开按钮之后、关闭按钮之前 */
	headerAction?: ReactNode;
	/** 默认展开的分组 id 集合；null（缺省）= 默认全展开。未覆盖的分组始终跟随该集合（数据异步到达后自动生效）。 */
	defaultExpandedIds?: ReadonlySet<string> | null;
	children: ReactNode;
	className?: string;
}) {
	const [search, setSearch] = useState("");
	// 折叠是派生状态 + 用户覆盖：mount 时数据（模型目录）可能未就绪，
	// 不能再像旧实现那样把折叠集合固化成一次快照，否则数据到达后分组全展开且不再响应。
	const [selection, setSelection] = useState<PickerGroupSelection>(() => ({
		mode: "default",
		overrides: new Map(INITIAL_PICKER_GROUP_SELECTION.overrides),
	}));
	const listHostRef = useRef<HTMLDivElement | null>(null);
	const defaultExpandedIds = props.defaultExpandedIds ?? null;
	const toggleGroup = (id: string) => {
		setSelection((current) =>
			applyPickerGroupAction({
				selection: current,
				defaultExpandedIds,
				action: { kind: "toggle", groupId: id },
			}),
		);
	};

	// cmdk 会选中当前值，但不会保证它在 Portal 内的滚动容器中居中；这里统一补上定位。
	useEffect(() => {
		const value = props.value?.trim().toLowerCase();
		if (!value) return;
		const frame = window.requestAnimationFrame(() => {
			const items = listHostRef.current?.querySelectorAll<HTMLElement>("[data-picker-value]");
			const selected = Array.from(items ?? []).find(
				(item) => item.getAttribute("data-picker-value")?.toLowerCase() === value,
			);
			selected?.scrollIntoView({ block: "center" });
		});
		return () => window.cancelAnimationFrame(frame);
	}, [props.value]);

	return (
		<div className={cn("flex min-h-0 w-full flex-col overflow-hidden bg-popover text-popover-foreground", props.className)}>
			<header className="flex shrink-0 items-start justify-between gap-4 border-b border-border/60 px-4 py-3">
				<div className="min-w-0">
					<h2 className="truncate text-body font-semibold text-foreground">{props.title}</h2>
					{props.hint && <p className="mt-0.5 text-caption text-muted-foreground">{props.hint}</p>}
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{props.showGroupActions && (
						<>
							<Button
								variant="ghost"
								size="icon-xs"
								className="text-muted-foreground hover:text-foreground"
								aria-label={t("app.modelExpandAllProviders")}
								title={t("app.modelExpandAllProviders")}
								onClick={() => {
									setSelection((current) =>
										applyPickerGroupAction({
											selection: current,
											defaultExpandedIds,
											action: { kind: "expandAll" },
										}),
									);
								}}
							>
								<ChevronsUpDown size={14} aria-hidden="true" />
							</Button>
							<Button
								variant="ghost"
								className="text-muted-foreground hover:text-foreground"
								aria-label={t("app.modelCollapseAllProviders")}
								title={t("app.modelCollapseAllProviders")}
								onClick={() => {
									setSelection((current) =>
										applyPickerGroupAction({
											selection: current,
											defaultExpandedIds,
											action: { kind: "collapseAll" },
										}),
									);
								}}
							>
								<ChevronsDownUp size={14} aria-hidden="true" />
							</Button>
						</>
					)}
					{props.headerAction}
					{props.onClose && (
						<Button
							variant="ghost"
							size="icon-sm"
							className="text-muted-foreground hover:text-foreground"
							aria-label={t("common.close")}
							title={t("common.close")}
							onClick={props.onClose}
						>
							<X size={16} strokeWidth={2} aria-hidden="true" />
						</Button>
					)}
				</div>
			</header>
			<Command defaultValue={props.value} onValueChange={props.onValueChange} className="min-h-0 rounded-none">
				<CommandInput
					onValueChange={setSearch}
					placeholder={props.searchPlaceholder}
					autoFocus
				/>
				<div ref={listHostRef} className="min-h-0">
					<CommandList className="max-h-[min(440px,55vh)] min-h-0">
						{search.trim() ? <CommandEmpty>{props.emptyLabel}</CommandEmpty> : null}
						<CommandPickerContext.Provider value={{ searchActive: search.trim().length > 0, selection, defaultExpandedIds, toggleGroup }}>
							{props.children}
						</CommandPickerContext.Provider>
					</CommandList>
				</div>
			</Command>
		</div>
	);
}
