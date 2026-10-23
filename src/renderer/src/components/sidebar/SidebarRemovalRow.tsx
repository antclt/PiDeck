import { createContext, forwardRef, useContext, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, LayoutGroup, motion, useIsPresent, useReducedMotion } from "motion/react";
import { EASE_OUT } from "../../lib/ease";
import { cn } from "../../lib/utils";

const RemovalGeneration = createContext(0);

/**
 * 未过滤的数据 id 区分真实移除与搜索隐藏；只在数据真的变了时触发布局测量。
 *
 * orderSensitive：调用方声明「这个列表的顺序本身有语义」（典型是用户拖拽排序的项目列表）。
 * 默认 false —— 会话列表按 updatedAt 排序，顺序随消息实时变化，若也按顺序触发测量，
 * 每次流式刷新都会让整列重新测量并播位移，得不偿失。开启后顺序变化（含移除导致的前移）
 * 才 bump 生成数，让 layout 动画只在用户可感知的结构变动时发生。
 */
export function SidebarRemovalList(props: { remainingIds: readonly string[]; children: ReactNode; onExitComplete?: () => void; orderSensitive?: boolean }) {
	const groupId = useId();
	const previous = useRef<{ ids: ReadonlySet<string>; order: string; generation: number } | null>(null);
	const prior = previous.current;
	// 用 NUL 连接：id 里不会出现该字符，避免 ["a","bc"] 与 ["ab","c"] 撞成同一签名。
	const order = props.remainingIds.join("\u0000");
	const unchanged = prior !== null && prior.ids.size === props.remainingIds.length && props.remainingIds.every((id) => prior.ids.has(id));
	const currentIds = unchanged ? prior.ids : new Set(props.remainingIds);
	const removed = prior !== null && !unchanged && [...prior.ids].some((id) => !currentIds.has(id));
	const reordered = props.orderSensitive === true && prior !== null && prior.order !== order;
	const generation = (prior?.generation ?? 0) + (removed || reordered ? 1 : 0);
	useLayoutEffect(() => {
		previous.current = { ids: currentIds, order, generation };
	}, [currentIds, order, generation]);
	return (
		<RemovalGeneration.Provider value={generation}>
			<LayoutGroup id={groupId} inherit={false}>
				<AnimatePresence initial={false} mode="popLayout" custom={props.remainingIds} onExitComplete={props.onExitComplete}>
					{props.children}
				</AnimatePresence>
			</LayoutGroup>
		</RemovalGeneration.Provider>
	);
}

// popLayout 需要直接取得这一行的 DOM，才能一次性移出文档流而非逐帧改高度。
export const SidebarRemovalRow = forwardRef<HTMLDivElement, { itemId: string; className?: string; children: ReactNode }>(function SidebarRemovalRow(props, ref) {
	const present = useIsPresent();
	const reduceMotion = useReducedMotion();
	const generation = useContext(RemovalGeneration);
	return (
		<motion.div
			ref={ref}
			data-sidebar-removal-id={props.itemId}
			inert={!present}
			aria-hidden={!present}
			className={cn(props.className, !present && "pointer-events-none")}
			initial={false}
			layout="position"
			layoutDependency={generation}
			transition={{ layout: { duration: reduceMotion ? 0 : 0.16, ease: EASE_OUT } }}
			exit="removed"
			variants={{
				removed: (remainingIds: readonly string[]) => ({
					opacity: 0,
					transition: { duration: reduceMotion || remainingIds.includes(props.itemId) ? 0 : 0.1, ease: EASE_OUT },
				}),
			}}
		>
			{props.children}
		</motion.div>
	);
});
