import { useEffect, useState } from "react";

/**
 * 订阅 documentElement 的 data-theme（"dark" / "light"）。
 *
 * 为什么需要：渲染期直读 dataset.theme 拿不到后续变化——主题切换只改 root 属性，
 * 不触发任何 React 状态更新，已挂载组件会带着旧明暗档一直留到下次无关重渲染
 * （MarkdownStream 的 mermaid 主题配置曾因此切主题后配色陈旧）。
 * 应用没有全局主题 atom（外观域直写 root），MutationObserver 是最小正确订阅点；
 * TerminalDock 的同款观察器是局部实现，这里抽成共享 hook 供多处复用。
 */
export function useDocumentTheme(): "dark" | "light" {
	const [theme, setTheme] = useState<"dark" | "light">(() => (typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
	useEffect(() => {
		const root = document.documentElement;
		const observer = new MutationObserver(() => {
			setTheme(root.dataset.theme === "dark" ? "dark" : "light");
		});
		observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
		return () => observer.disconnect();
	}, []);
	return theme;
}

/**
 * 订阅 documentElement 的 data-palette（配色 id）。
 *
 * 与 useDocumentTheme 同理：切配色只改 root 属性，不触发 React 更新。
 * 用于让 MarkdownStream 在 `tui` 配色下换用 pi 终端的 Shiki 代码高亮色板
 * （代码 token 色由 inline style 决定，CSS 变量管不到）。
 *
 * 为什么跟配色而不是跟样式：代码块的语法色是「颜色」而不是「形状」，
 * 与另外 19 个 `--color-*` 一样属于配色维度；terminal 样式配 graphite 配色时
 * 用默认高亮、classic 样式配 tui 配色时用 TUI 高亮，两种组合都自洽。
 */
export function useDocumentPalette(): string {
	const read = () => (typeof document === "undefined" ? "" : (document.documentElement.dataset.palette ?? ""));
	const [palette, setPalette] = useState<string>(read);
	useEffect(() => {
		const root = document.documentElement;
		const observer = new MutationObserver(() => setPalette(root.dataset.palette ?? ""));
		observer.observe(root, { attributes: true, attributeFilter: ["data-palette"] });
		return () => observer.disconnect();
	}, []);
	return palette;
}
