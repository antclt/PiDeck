import type { ThemeRegistrationAny } from "shiki";

/**
 * 终端皮肤（data-appearance="terminal"）的代码高亮色板。
 *
 * 为什么要在代码里造 Shiki 主题，而不是加 CSS token：
 * 代码块每个 token 的颜色由 Shiki 生成的 inline style 决定，CSS 变量管不到；pi TUI 的
 * 语法高亮恰恰是「终端感」最重的部分（注释灰、关键字蓝、函数黄、字符串橙、数字绿、类型紫），
 * 只能以 Shiki 主题的形式移植。
 *
 * 取值来自 pi 内置主题（dist/modes/interactive/theme/{dark,light}.json）的 syntax* 组，
 * 前景用 mdCodeBlock（终端里代码块正文就是绿色），背景留 transparent 让卡片底色透出来。
 * 修改这里不需要同步任何 CSS；改皮肤色板时请一并回看，两边应保持同一套色。
 */

const DARK = {
	comment: "#9da5a9",
	keyword: "#69add0",
	fn: "#cd9a22",
	variable: "#5db3ba",
	string: "#de8d5a",
	number: "#68b78d",
	type: "#a798d7",
	punct: "#9da5a9",
	invalid: "#ea7f81",
	foreground: "#68b78d",
} as const;

const LIGHT = {
	comment: "#677176",
	keyword: "#2f7899",
	fn: "#775602",
	variable: "#287a81",
	string: "#a45417",
	number: "#2b6e4d",
	type: "#6f55ad",
	punct: "#677176",
	invalid: "#c4243c",
	foreground: "#2b6e4d",
} as const;

type Palette = Record<keyof typeof DARK, string>;

function buildTheme(name: string, type: "dark" | "light", palette: Palette): ThemeRegistrationAny {
	return {
		name,
		type,
		colors: {
			"editor.background": "transparent",
			"editor.foreground": palette.foreground,
		},
		tokenColors: [
			// 兜底层：未命中的作用域都落在代码块正文色上（终端里是 mdCodeBlock 绿）
			{ settings: { foreground: palette.foreground } },
			{ scope: ["comment", "punctuation.definition.comment", "string.comment"], settings: { foreground: palette.comment, fontStyle: "italic" } },
			{ scope: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.control", "keyword.other", "keyword.operator.new"], settings: { foreground: palette.keyword } },
			{ scope: ["entity.name.function", "support.function", "meta.function-call", "meta.function.entity", "variable.function"], settings: { foreground: palette.fn } },
			{ scope: ["variable", "variable.other", "variable.parameter", "meta.object-literal.key", "support.variable", "entity.other.attribute-name"], settings: { foreground: palette.variable } },
			{ scope: ["string", "string.quoted", "markup.inline.raw", "constant.other.symbol"], settings: { foreground: palette.string } },
			{ scope: ["constant.numeric", "constant.language", "constant.character", "constant.escape", "support.constant"], settings: { foreground: palette.number } },
			{ scope: ["entity.name.type", "entity.name.class", "entity.name.tag", "support.type", "support.class", "storage.type.class", "meta.type.annotation"], settings: { foreground: palette.type } },
			{ scope: ["keyword.operator", "punctuation", "punctuation.separator", "punctuation.terminator", "meta.brace"], settings: { foreground: palette.punct } },
			{ scope: ["invalid", "invalid.illegal"], settings: { foreground: palette.invalid } },
			// markup（Markdown 代码块里的 md 语法）：标题/链接复用终端的黄/蓝，保持同一套语义
			{ scope: ["markup.heading"], settings: { foreground: palette.fn } },
			{ scope: ["markup.underline.link", "markup.link"], settings: { foreground: palette.keyword } },
			{ scope: ["markup.bold"], settings: { foreground: palette.foreground, fontStyle: "bold" } },
			{ scope: ["markup.italic"], settings: { foreground: palette.foreground, fontStyle: "italic" } },
		],
	};
}

/** [light, dark] —— 与 @streamdown/code 的 themes 顺序一致。 */
export const PI_TUI_SHIKI_THEMES: [ThemeRegistrationAny, ThemeRegistrationAny] = [buildTheme("pideck-tui-light", "light", LIGHT), buildTheme("pideck-tui-dark", "dark", DARK)];
