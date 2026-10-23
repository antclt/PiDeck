"use client";
// beui.dev/components/motion/preview-rail
//
// PiDeck 本地扩展（与官方实现的差异）。`npx shadcn add @beui/preview-rail --overwrite`
// 会整份覆盖本文件，下面 7 条必须重新施加（tests/outlineRailScroll.test.mjs 会因覆盖变红）：
// 1. `railMaxHeight`：刻度超出高度时导轨自身滚动（官方版永不滚动，只能压缩/丢弃刻度）；
//    配套隐藏滚动条只用 `[scrollbar-width:none]`（不要恢复 webkit 伪元素滚动条规则，理由见 foundation.css）。
// 2. 滚轮容器两端 16px 渐隐 maskImage + `setFade` 只在两端状态翻转时重渲染。
// 3. 预览卡改绝对定位 + `placeCard` 直接写 DOM，删掉官方版为对齐渲染的 N 个占位格子（DOM 减半）。
// 4. `onWheelFallback`：滚轮先滚导轨，到边界才交还外层；因 React 的 onWheel 是 passive，
//    用原生非 passive 监听 + layout effect 同步 handler。
// 5. `muted`：未加载目标的刻度淡一档（对齐 dsh TurnNavigator 的 markUnloaded）。
// 6. 自动跟随：`FOLLOW_SAFE_BAND_PX` 安全带内不动，移出才居中；`pointerInsideRef` 抑制手底下抢滚。
// 7. 非滚动时保留官方 `min-h-80`，滚动时取消（否则卡片 clamp 的 100% 会大于可视带）。

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type MouseEvent, type PointerEvent, type ReactNode, useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { EASE_OUT, SPRING_LAYOUT } from "@/lib/ease";
import { useDismiss } from "@/lib/hooks/use-dismiss";
import { useHoverGesture } from "@/lib/hooks/use-hover-gesture";
import { useTapGesture } from "@/lib/hooks/use-tap-gesture";
import { cn } from "@/lib/utils";

/** 跟随滚动的安全带（px）：当前刻度落在这个带内就保持滚动位置不动（略宽于 16px 渐隐带，避免贴边抖动）。 */
const FOLLOW_SAFE_BAND_PX = 24;

export interface PreviewRailItem {
	id: string;
	label: string;
	ariaLabel?: string;
	description?: ReactNode;
	/**
	 * [PiDeck local] 该目标尚未加载（需要先补页才能到达）：刻度画淡一档，
	 * 让用户点之前就知道「这一条要等 / 可能到不了」（对齐 dsh TurnNavigator 的 markUnloaded）。
	 */
	muted?: boolean;
	href?: string;
	target?: "_blank" | "_self" | "_parent" | "_top";
	rel?: string;
}

export interface PreviewRailProps {
	items: PreviewRailItem[];
	label?: string;
	orientation?: "vertical" | "horizontal";
	activeId?: string;
	defaultActiveId?: string;
	onActiveChange?: (id: string) => void;
	onItemSelect?: (item: PreviewRailItem) => void;
	renderPreview?: (item: PreviewRailItem) => ReactNode;
	showPreview?: boolean;
	previewSide?: "before" | "after";
	highlightActive?: boolean;
	itemSize?: number;
	/** 纵向导轨的可视高度上限；内容更高时导轨内部滚动并两端渐隐，而不是压缩刻度。 */
	railMaxHeight?: number;
	/** 导轨自身滚到边界后，滚轮事件的去处（会话定位轴用它把滚动交还时间线）。 */
	onWheelFallback?: (deltaY: number) => void;
	children?: ReactNode;
	className?: string;
	railClassName?: string;
	previewContainerClassName?: string;
	previewClassName?: string;
}

function DefaultPreview({ item }: { item: PreviewRailItem }) {
	return (
		<div data-slot="preview-rail-card" className="rounded-2xl border border-border bg-card p-4 shadow-sm">
			<p data-slot="preview-rail-title" className="font-medium text-card-foreground">
				{item.label}
			</p>
			{item.description ? (
				<div data-slot="preview-rail-description" className="mt-1 text-sm leading-6 text-muted-foreground">
					{item.description}
				</div>
			) : null}
		</div>
	);
}

export function PreviewRail({
	items,
	label = "Section navigation",
	orientation = "vertical",
	activeId,
	defaultActiveId,
	onActiveChange,
	onItemSelect,
	renderPreview,
	showPreview = true,
	previewSide = "after",
	highlightActive = false,
	itemSize = 24,
	railMaxHeight,
	onWheelFallback,
	children,
	className,
	railClassName,
	previewContainerClassName,
	previewClassName,
}: PreviewRailProps) {
	const uid = useId();
	const reduce = useReducedMotion();
	const rootRef = useRef<HTMLDivElement>(null);
	const [internalActiveId, setInternalActiveId] = useState(defaultActiveId ?? items[0]?.id ?? "");
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	// A finger cannot hover, so a tap lights the tick instead. Kept apart from
	// the hovered one: they end in different ways, and a stray mouse move must
	// not clear a tick the keyboard or a tap chose.
	const [pinnedId, setPinnedId] = useState<string | null>(null);
	const [focusedId, setFocusedId] = useState<string | null>(null);
	// A click carries no pointerType, so the pointerdown before it is what says
	// whether the activation was a tap. Keyboard activation has none at all.
	const tap = useTapGesture<boolean>();
	const hover = useHoverGesture();
	const scrollerRef = useRef<HTMLDivElement>(null);
	const cardRef = useRef<HTMLDivElement>(null);
	// 滚动位置不进 state：每帧 setState 会让整列刻度重渲染（长会话可达数百条），
	// 预览卡位置直接写 DOM，只有两端渐隐状态翻转时才重渲染。
	const scrollTopRef = useRef(0);
	const [fade, setFade] = useState({ top: false, bottom: false });
	/** 指针停在导轨上时不自动跟随当前刻度，否则刻度会在手底下跑掉。 */
	const pointerInsideRef = useRef(false);

	const clearPinned = useCallback(() => setPinnedId(null), []);

	// The next tap outside the rail stands in for the pointer leaving it. The
	// card is a preview, so that tap passes through to whatever it landed on.
	useDismiss(pinnedId !== null, clearPinned, rootRef);

	const requestedActiveId = activeId ?? internalActiveId;
	const selectedId = items.some((item) => item.id === requestedActiveId) ? requestedActiveId : (items[0]?.id ?? "");
	const displayedId = hoveredId ?? pinnedId ?? focusedId ?? "";
	const highlightedId = displayedId || (highlightActive ? selectedId : "");
	const displayedIndex = items.findIndex((item) => item.id === highlightedId);
	const displayedItem = displayedIndex >= 0 ? items[displayedIndex] : undefined;
	const rowTemplate = items.length ? `repeat(${items.length}, ${itemSize}px)` : undefined;
	const isHorizontal = orientation === "horizontal";
	// 内容高于上限才滚动：短会话保持原样（不出现滚动条、不出现渐隐）。
	const contentSize = items.length * itemSize;
	const scrollable = !isHorizontal && railMaxHeight !== undefined && contentSize > railMaxHeight;
	const fadeTop = scrollable && fade.top;
	const fadeBottom = scrollable && fade.bottom;
	const scrollerMask = !scrollable
		? undefined
		: fadeTop && fadeBottom
			? "linear-gradient(to bottom, transparent 0, #000 16px, #000 calc(100% - 16px), transparent 100%)"
			: fadeTop
				? "linear-gradient(to bottom, transparent 0, #000 16px, #000 100%)"
				: fadeBottom
					? "linear-gradient(to bottom, #000 0, #000 calc(100% - 16px), transparent 100%)"
					: undefined;

	/**
	 * 预览卡垂直居中于所属刻度并夹在可视带内；滚动时由 scroll 回调逐帧写这里（不进 state）。
	 * `centeredOffset` 服务“调用方给导轨设了 min-height、刻度被 content-center 居中”的坐位
	 * （官方组件默认 min-h-80 就是这种）；会话定位轴传的是 min-h-0，那里恒为 0。
	 */
	const placeCard = useCallback(
		(index: number) => {
			const card = cardRef.current;
			const scroller = scrollerRef.current;
			if (!card || !scroller || isHorizontal || index < 0) return;
			// 不滚动时刻度被 `content-center` 居中，需要补偿 same offset
			const centeredOffset = Math.max(0, (scroller.clientHeight - contentSize) / 2);
			const center = centeredOffset + index * itemSize + itemSize / 2 - scrollTopRef.current;
			const cardHeight = card.offsetHeight || 80;
			const viewHeight = scroller.clientHeight || railMaxHeight || 0;
			card.style.top = `${Math.max(0, Math.min(Math.max(0, viewHeight - cardHeight), center - cardHeight / 2))}px`;
		},
		[isHorizontal, itemSize, railMaxHeight, contentSize],
	);

	const followedIdRef = useRef<string | undefined>(undefined);

	// 进出滚动档位（窗口缩放/终端坞开关）时重置跟随记录：
	// 浏览器在 overflow 消失后会把 scrollTop 归零，不复位会让刻度停在顶部、当前刻度在带外。
	useLayoutEffect(() => {
		followedIdRef.current = undefined;
	}, [scrollable, railMaxHeight]);

	// 当前刻度移出两侧安全带时才将它滚回中间（对齐 dsh TurnNavigator 的 'if-needed'）。
	// 只比 id 会让每次检查点变化都重算居中（相邻刻度仅差 10px），导轨会“抽”一下。
	useLayoutEffect(() => {
		const scroller = scrollerRef.current;
		if (!scrollable || !scroller || pointerInsideRef.current) return;
		if (followedIdRef.current === requestedActiveId) return;
		followedIdRef.current = requestedActiveId;
		const index = items.findIndex((item) => item.id === requestedActiveId);
		const viewHeight = scroller.clientHeight;
		if (index < 0 || viewHeight <= 0) return;
		const center = index * itemSize + itemSize / 2;
		// 安全带：落在可视带内部就保持不动，只把它推回来（与两端渐隐的 16px 同量级）
		const scrollTop = scroller.scrollTop;
		if (center >= scrollTop + FOLLOW_SAFE_BAND_PX && center <= scrollTop + viewHeight - FOLLOW_SAFE_BAND_PX) return;
		const target = Math.max(0, Math.min(Math.max(0, contentSize - viewHeight), center - viewHeight / 2));
		if (Math.abs(scrollTop - target) < 1) return;
		scroller.scrollTo({ top: target, behavior: reduce ? "auto" : "smooth" });
	}, [scrollable, requestedActiveId, items, itemSize, contentSize, reduce]);

	// 预览卡跟随当前刻度（悬停/激活/滚动都走同一条路径）。
	useLayoutEffect(() => {
		placeCard(displayedIndex);
	}, [placeCard, displayedIndex]);

	// 进入/离开滚动档位时重置渐隐：短会话不该残留底部渐隐，切到长会话时底部要立刻提示还有更多。
	useLayoutEffect(() => {
		scrollTopRef.current = scrollerRef.current?.scrollTop ?? 0;
		setFade({ top: false, bottom: scrollable && contentSize > (railMaxHeight ?? 0) + 1 });
	}, [scrollable, contentSize, railMaxHeight]);

	// 滚轮先给导轨（还在可视带内就自己滚），到边界才交还外层时间线。
	// React 的 onWheel 是 passive 监听，preventDefault 会被忽略并留下告警，
	// 因此这里显式注册非 passive 原生监听（同 SessionTrajectoryView）。
	const wheelRef = useRef<(event: WheelEvent) => void>(() => {});
	// 渲染期写 ref 在并发渲染下不安全（被丢弃的渲染会留下过期闭包），统一在 layout effect 里同步。
	useLayoutEffect(() => {
		wheelRef.current = (event: WheelEvent) => {
			const scroller = scrollerRef.current;
			if (scroller && scrollable) {
				const atTop = scroller.scrollTop <= 0;
				const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
				if (!((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom))) return;
			}
			if (!onWheelFallback || event.deltaY === 0) return;
			event.preventDefault();
			onWheelFallback(event.deltaY);
		};
	});
	useLayoutEffect(() => {
		const element = rootRef.current;
		if (!element) return;
		const handler = (event: WheelEvent) => wheelRef.current(event);
		element.addEventListener("wheel", handler, { passive: false });
		return () => element.removeEventListener("wheel", handler);
	}, []);

	const selectItem = (id: string) => {
		if (activeId === undefined) setInternalActiveId(id);
		onActiveChange?.(id);
	};

	return (
		<motion.div
			layoutRoot
			ref={rootRef}
			onBlur={(event) => {
				// Both tick sources leave with the focus: a tap does not always land
				// focus, but when it does, tabbing away must not strand the card.
				if (!event.currentTarget.contains(event.relatedTarget)) {
					setFocusedId(null);
					setPinnedId(null);
				}
			}}
			onPointerEnter={() => {
				pointerInsideRef.current = true;
			}}
			onPointerLeave={() => {
				pointerInsideRef.current = false;
			}}
			className={cn("isolate relative flex w-full overflow-visible", isHorizontal ? "min-h-64 flex-col items-center justify-center" : scrollable ? undefined : "min-h-80", className)}
		>
			{/* 滚轮容器：内容高于上限时内部滚动，滚动条隐藏、两端渐隐提示还有更多刻度 */}
			<div
				ref={scrollerRef}
				onScroll={(event) => {
					const scroller = event.currentTarget;
					scrollTopRef.current = scroller.scrollTop;
					placeCard(displayedIndex);
					const top = scroller.scrollTop > 1;
					const bottom = railMaxHeight !== undefined && scroller.scrollTop < contentSize - railMaxHeight - 1;
					setFade((previous) => (previous.top === top && previous.bottom === bottom ? previous : { top, bottom }));
				}}
				style={{ maxHeight: scrollable ? railMaxHeight : undefined, maskImage: scrollerMask, WebkitMaskImage: scrollerMask }}
				className={cn("relative z-10 flex min-h-0 shrink-0", scrollable && "items-start overflow-y-auto overscroll-contain [scrollbar-width:none]")}
			>
				<nav
					aria-label={label}
					onPointerLeave={(event) => {
						// A touch pointer leaves on lift, which would clear the tick the tap
						// just chose — that one is cleared by the outside tap instead.
						if (hover.leave(event)) setHoveredId(null);
					}}
					style={isHorizontal ? { gridTemplateColumns: rowTemplate } : { gridTemplateRows: rowTemplate }}
					className={cn("relative grid shrink-0", isHorizontal ? "h-12 w-fit max-w-full self-center justify-center" : "w-12 content-center", railClassName)}
				>
					{items.map((item, index) => {
						const selected = item.id === selectedId;
						const highlighted = item.id === highlightedId;
						const distance = displayedIndex < 0 ? Number.POSITIVE_INFINITY : Math.abs(index - displayedIndex);
						const scale = highlighted ? 1 : distance === 1 ? 0.68 : distance === 2 ? 0.44 : 0.25;

						const itemContent = (
							<>
								<motion.span
									data-slot="preview-rail-tick"
									aria-hidden="true"
									animate={isHorizontal ? { scaleY: scale } : { scaleX: scale }}
									transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
									className={cn("block bg-current", isHorizontal ? "h-12 w-0.5 origin-bottom" : "h-0.5 w-12 origin-left", highlighted ? "text-foreground" : undefined)}
								/>
							</>
						);

						const sharedClassName = cn(
							"relative flex text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
							isHorizontal ? "h-12 w-6 items-end justify-center" : "h-6 w-12 items-center",
							// 未加载目标淡一档（对齐 dsh markUnloaded 的 0.6）：看得到位置，
							// 但不会误以为是「点了立刻跳」。不能更淡——长会话里多数刻度都未加载，
							// 压到 0.4 以下时整条导轨看起来像空的。
							item.muted && "opacity-60",
						);
						const sharedStyle = isHorizontal ? { width: itemSize } : { height: itemSize };
						const handlePointerEnter = (event: PointerEvent<HTMLElement>) => {
							if (hover.enter(event)) setHoveredId(item.id);
						};
						const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
							tap.start(event, pinnedId === item.id);
							setFocusedId(null);
						};
						// A gesture the platform takes away sends no click, and a key press
						// starts an activation that never had a pointer behind it: either
						// one leaves a record the next click would read as a tap of its own.
						const dropGesture = () => tap.drop();
						const handleFocus = (currentTarget: HTMLElement) => {
							if (currentTarget.matches(":focus-visible")) {
								setFocusedId(item.id);
							}
						};
						const handleSelect = (event: MouseEvent<HTMLElement>) => {
							const gesture = tap.take();
							const tapped = gesture !== null && gesture.pointerType !== "mouse";

							if (tapped) {
								// A link would otherwise show its preview and leave the page in
								// the same tap, so the card is never read: the first tap lights
								// the tick, the second follows the link.
								if (item.href && !gesture.state) {
									event.preventDefault();
									setPinnedId(item.id);
									return;
								}
								setPinnedId(item.id);
							}

							selectItem(item.id);
							onItemSelect?.(item);
						};

						return item.href ? (
							<a
								key={item.id}
								data-slot="preview-rail-item"
								href={item.href}
								target={item.target}
								rel={item.rel ?? (item.target === "_blank" ? "noreferrer noopener" : undefined)}
								aria-label={item.ariaLabel ?? item.label}
								aria-current={selected ? "page" : undefined}
								onPointerEnter={handlePointerEnter}
								onPointerDown={handlePointerDown}
								onPointerCancel={dropGesture}
								onKeyDown={dropGesture}
								onFocus={(event) => handleFocus(event.currentTarget)}
								onClick={handleSelect}
								style={sharedStyle}
								className={sharedClassName}
							>
								{itemContent}
							</a>
						) : (
							<button
								key={item.id}
								data-slot="preview-rail-item"
								type="button"
								aria-label={item.ariaLabel ?? item.label}
								aria-current={selected ? "location" : undefined}
								onPointerEnter={handlePointerEnter}
								onPointerDown={handlePointerDown}
								onPointerCancel={dropGesture}
								onKeyDown={dropGesture}
								onFocus={(event) => handleFocus(event.currentTarget)}
								onClick={handleSelect}
								style={sharedStyle}
								className={sharedClassName}
							>
								{itemContent}
							</button>
						);
					})}
				</nav>
			</div>

			{showPreview && displayedItem ? (
				<div aria-hidden="true" className={cn("pointer-events-none absolute z-50", isHorizontal ? "top-1/2 left-1/2 h-5 max-w-full -translate-x-1/2 -translate-y-1/2" : previewSide === "before" ? "inset-y-0 right-16 left-4" : "inset-y-0 right-4 left-16", previewContainerClassName)}>
					{/* 只渲染当前那一张卡，按刻度索引绝对定位（官方版为对齐渲染了 N 个占位格子）。 */}
					<div
						ref={cardRef}
						style={isHorizontal ? { left: displayedIndex * itemSize + itemSize / 2 } : undefined}
						className={cn(
							"absolute",
							// 预览卡在相邻刻度之间滑动时补一段过渡（官方版是瞬移）；减少动态偏好下关闭
							!reduce && !isHorizontal && "transition-[top] duration-[140ms] ease-out",
							isHorizontal ? "bottom-12 w-72 -translate-x-1/2" : cn("w-full max-w-sm", previewSide === "before" ? "right-0" : "left-0"),
							previewClassName,
						)}
					>
						<motion.div layoutId={`preview-rail-card-${uid}`} transition={reduce ? { duration: 0 } : SPRING_LAYOUT}>
							<AnimatePresence mode="wait" initial={false}>
								<motion.div
									key={displayedItem.id}
									initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4, filter: "blur(6px)" }}
									animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, filter: "blur(0px)" }}
									exit={
										reduce
											? { opacity: 0 }
											: {
													opacity: 0,
													y: -2,
													filter: "blur(4px)",
													transition: {
														duration: 0.12,
														ease: EASE_OUT,
													},
												}
									}
									transition={{
										duration: reduce ? 0 : 0.18,
										ease: EASE_OUT,
									}}
								>
									{renderPreview ? renderPreview(displayedItem) : <DefaultPreview item={displayedItem} />}
								</motion.div>
							</AnimatePresence>
						</motion.div>
					</div>
				</div>
			) : null}

			{children ? <div className="min-h-0 min-w-0 flex-1">{children}</div> : null}
		</motion.div>
	);
}
