import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Toaster as SonnerToaster } from "sonner";
import { setToasterReady } from "../../utils/notice";

/**
 * 全局 Toaster（#115）：sonner 官方组件，主题跟随应用 dataset.theme
 * （应用主题独立于系统主题，不能用 sonner 的 "system" 模式）。
 *
 * portal 到 body：sonner 自身不 portal，而 #root 带 position:relative + z-index:1
 * （层叠上下文），Radix Dialog/Sheet 却 portal 到 body——toast 留在 #root 内会被
 * 弹窗整体盖住（曾现：设置弹窗内 toast 显示到下层图层）。挂到 body 后 z-index
 * 999999999 与弹窗（--z-dialog: 950）同级比较，永远置顶。
 */

function subscribeTheme(callback: () => void) {
	const observer = new MutationObserver(callback);
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["data-theme"],
	});
	return () => observer.disconnect();
}

function getThemeSnapshot(): "light" | "dark" {
	return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function Toaster() {
	const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot);
	// sonner 2.x 无 toast 时不渲染 DOM，notice.ts 无法靠 DOM 探测挂载态，
	// 挂载/卸载时显式回报，未挂载窗口期 showNotice 才走 DOM 兜底。
	useEffect(() => {
		setToasterReady(true);
		return () => setToasterReady(false);
	}, []);
	// 禁掉 sonner 的拖动取消手势：桌面端用鼠标拖选 toast 文本复制时，
	// 快速拖动会被判定为 swipe（velocity > 0.11 / 位移超阈值即取消），
	// 表现为“想复制却把 toast 拖没了”，且 setPointerCapture 会干扰选区。
	// 在 document 捕获阶段拦掉 toast 非按钮区的 pointerdown，sonner 的
	// onPointerDown 收不到事件就不会进入 swipe 状态；关闭/操作/取消按钮
	// 走 click 事件不受影响，文本选区默认行为也保留（不 preventDefault）。
	useEffect(() => {
		const blockToastSwipe = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			// 按钮（data-button / data-close-button 等）放行，保持 sonner 原交互
			if (target.closest("button")) return;
			if (target.closest("[data-sonner-toast]")) {
				event.stopImmediatePropagation();
			}
		};
		document.addEventListener("pointerdown", blockToastSwipe, true);
		return () => document.removeEventListener("pointerdown", blockToastSwipe, true);
	}, []);
	return createPortal(
		<SonnerToaster
			theme={theme}
			position="top-right"
			gap={10}
			closeButton
			visibleToasts={4}
			offset={{
				// 让开自定义标题栏拖拽区（--window-drag-height：frameless 下 32px，否则 0px）。
				// 首个 toast 若贴顶，左上角关闭按钮会落在 -webkit-app-region: drag 层里，
				// 点击被拖拽命中测试吞掉，表现为“点叉没反应”。
				top: "calc(var(--window-drag-height, 0px) + 12px)",
				right: "16px",
			}}
			toastOptions={{
				// select-text：显式允许选中 toast 文本（sonner 自身只在 swiped 后关选中，
				// 这里与上方 pointerdown 拦截配合，保证“拖选复制”始终可用）
				className: "app-sonner-toast select-text",
				style: {
					// 中性面板卡片：与弹窗/抽屉同一套 token，类型语义只体现在图标色（见 surfaces.css）
					background: "var(--color-bg-panel)",
					border: "1px solid var(--color-border-subtle)",
					borderRadius: "var(--radius-lg)",
					boxShadow: "var(--shadow-popover)",
					color: "var(--color-text-primary)",
					fontSize: "13px",
					fontFamily: "var(--font-family-base)",
					padding: "12px 36px 12px 14px",
				},
			}}
		/>,
		document.body,
	);
}
