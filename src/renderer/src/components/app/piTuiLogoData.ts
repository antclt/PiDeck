/**
 * pi 官方 TUI logo 的纯数据与纯函数模块（无 React/DOM 依赖，可单测）。
 * 位图与颜色逐字段对齐 pi 源码 packages/coding-agent/src/modes/interactive/components/pi-logo.ts：
 * 4×4 像素 π（半块字符画的 DOM 复刻），品牌色固定不随明暗主题变。
 */

/** pi 官方品牌色（rgb 值来自 pi-logo.ts 的 rgbColor 定义） */
export const PI_TUI_COLORS = {
	coral: "#E48A7A",
	blue: "#4F8EB3",
	yellow: "#EAB65D",
} as const;

export type PiTuiColorKey = keyof typeof PI_TUI_COLORS;

/**
 * 官方 4×4 位图（key 为 "y:x"）：
 * ```
 * coral coral coral .
 * blue  .     coral .
 * blue  blue  .     yellow
 * blue  .     .     yellow
 * ```
 * 官方以 4 格宽 × 2 行半块字符渲染；DOM/canvas 按逐像素 4×4 还原。
 */
export const PI_TUI_LOGO_CELLS: Record<string, PiTuiColorKey> = {
	"0:0": "coral",
	"0:1": "coral",
	"0:2": "coral",
	"1:0": "blue",
	"1:2": "coral",
	"2:0": "blue",
	"2:1": "blue",
	"2:3": "yellow",
	"3:0": "blue",
	"3:3": "yellow",
};

/** 落位动画的一块：官方位图的三块连通区域，各自从上方落下拼成定格 */
export type PiTuiPiece = {
	color: PiTuiColorKey;
	/** 相对 piece 原点的像素坐标 [y, x] */
	cells: Array<[number, number]>;
	/** 起始/目标原点（4×4 位图坐标系；起始为负值表示从画面上方进入） */
	startY: number;
	targetY: number;
};

/** 三块落位顺序：coral 顶横 → blue 左钩 → yellow 右竖（与位图视觉重心一致） */
export const PI_TUI_PIECES: PiTuiPiece[] = [
	{
		color: "coral",
		cells: [
			[0, 0],
			[0, 1],
			[0, 2],
			[1, 2],
		],
		startY: -1,
		targetY: 0,
	},
	{
		color: "blue",
		cells: [
			[0, 0],
			[1, 0],
			[1, 1],
			[2, 0],
		],
		startY: -2,
		targetY: 1,
	},
	{
		color: "yellow",
		cells: [
			[0, 3],
			[1, 3],
		],
		startY: -2,
		targetY: 2,
	},
];

export type LogoStyleValue = "classic" | "pi-tui";

/**
 * 解析 logo 风格：仅 "pi-tui" 视为新风格，其余（null/未知/旧值）一律 classic。
 * 启动画面（React 挂载前）与渲染层组件共用同一判定。
 */
export function resolveLogoStyle(value: string | null | undefined): LogoStyleValue {
	return value === "pi-tui" ? "pi-tui" : "classic";
}

/**
 * logo 风格的 localStorage 缓存键：App.tsx 在 settings 权威值就绪/变化时写入，
 * index.html 启动画面内联脚本读取（两处字符串必须一致，tests/piTuiLogo.test.mjs 锚定）。
 */
export const LOGO_STYLE_STORAGE_KEY = "pideck:logo-style";
