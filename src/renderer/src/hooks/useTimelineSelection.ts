import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
	MAX_QUOTE_CHARS,
	QUOTE_EXCLUDED_SELECTOR,
	isQuotableRange,
} from "../components/session/timeline/selectionToolbarPolicy";

export type TimelineSelectionQuote = {
	text: string;
	messageId: string;
	rect: { top: number; left: number; width: number; height: number };
};

/** 从 DOM 节点向上找所属消息 id；不在容器内返回 null。 */
function resolveMessageId(node: Node | null, container: HTMLElement): string | null {
	if (!node) return null;
	const element = node.nodeType === Node.ELEMENT_NODE
		? (node as Element)
		: node.parentElement;
	if (!element || !container.contains(element)) return null;
	return element.closest("[data-message-id]")?.getAttribute("data-message-id") ?? null;
}

function isExcluded(node: Node | null): boolean {
	if (!node) return false;
	const element = node.nodeType === Node.ELEMENT_NODE
		? (node as Element)
		: node.parentElement;
	if (!element) return false;
	return Boolean(element.closest(QUOTE_EXCLUDED_SELECTOR));
}

/**
 * 时间线划选监听：选区完全落在同一条消息内且未命中排除区域时，
 * 产出 { 文本快照, 来源消息 id, 选区矩形 } 供浮层按钮使用。
 *
 * 行为对齐 assistant-ui/Codex（2026-09 调研）：
 * - selectionchange 只负责"收起"（拖选中不闪浮层）；pointerup/keyup 后延迟 ~60ms 评估展示；
 * - 容器滚动即隐藏（fixed 定位会随滚动失效）；Escape 收起。
 */
export function useTimelineSelection(
	containerRef: RefObject<HTMLElement | null>,
): { quote: TimelineSelectionQuote | null; clear: () => void } {
	const [quote, setQuote] = useState<TimelineSelectionQuote | null>(null);
	const evaluateTimerRef = useRef(0);

	const clear = useCallback(() => setQuote(null), []);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const currentSelection = () => window.getSelection();

		// 拖选过程中 selectionchange 连续触发：折叠立即收起，展开中不动（避免闪烁）
		const onSelectionChange = () => {
			const selection = currentSelection();
			if (!selection || selection.isCollapsed) setQuote(null);
		};

		const evaluate = () => {
			const selection = currentSelection();
			if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
				setQuote(null);
				return;
			}
			const range = selection.getRangeAt(0);
			const text = selection.toString();
			const ok = isQuotableRange({
				messageIdA: resolveMessageId(range.startContainer, container),
				messageIdB: resolveMessageId(range.endContainer, container),
				excludedA: isExcluded(range.startContainer),
				excludedB: isExcluded(range.endContainer),
				text,
				maxLength: MAX_QUOTE_CHARS,
			});
			if (!ok) {
				setQuote(null);
				return;
			}
			const rect = range.getBoundingClientRect();
			setQuote({
				text: text.trim(),
				messageId: resolveMessageId(range.startContainer, container) ?? "",
				rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
			});
		};

		// pointerup/键盘选区结束后再评估：给浏览器一点时间稳定最终选区
		const scheduleEvaluate = () => {
			window.clearTimeout(evaluateTimerRef.current);
			evaluateTimerRef.current = window.setTimeout(evaluate, 60);
		};
		const onPointerUp = (event: PointerEvent) => {
			if (event.button !== 0) return;
			scheduleEvaluate();
		};
		const onKeyUp = (event: KeyboardEvent) => {
			// Shift+方向键 / Ctrl+A 等键盘扩选；Escape 只负责收起
			if (event.key === "Escape") {
				setQuote(null);
				return;
			}
			if (event.shiftKey || event.key === "a" || event.key === "A") scheduleEvaluate();
		};
		// 滚动让 fixed 定位失真：直接隐藏（下次划选会重新评估）
		const onHide = () => setQuote(null);

		document.addEventListener("selectionchange", onSelectionChange);
		container.addEventListener("pointerup", onPointerUp);
		document.addEventListener("keyup", onKeyUp);
		// capture：捕获内层滚动容器（消息列自身可滚）
		container.addEventListener("scroll", onHide, true);
		window.addEventListener("resize", onHide);

		return () => {
			window.clearTimeout(evaluateTimerRef.current);
			document.removeEventListener("selectionchange", onSelectionChange);
			container.removeEventListener("pointerup", onPointerUp);
			document.removeEventListener("keyup", onKeyUp);
			container.removeEventListener("scroll", onHide, true);
			window.removeEventListener("resize", onHide);
		};
	}, [containerRef]);

	return { quote, clear };
}
