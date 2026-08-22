/**
 * Composer mention 原子节点：@file / /skill|/cmd / &session。
 * 渲染为与旧 RichInput 一致的 .input-chip 外观；不可编辑内部。
 */

import { mergeAttributes, Node } from "@tiptap/core";
import type { ComposerChip } from "../chips";

export type MentionChipAttrs = {
	kind: ComposerChip["kind"];
	raw: string;
	label: string;
};

declare module "@tiptap/core" {
	interface Commands<ReturnType> {
		mentionChip: {
			insertMentionChip: (attrs: MentionChipAttrs) => ReturnType;
		};
	}
}

export const MentionChip = Node.create({
	name: "mentionChip",
	group: "inline",
	inline: true,
	atom: true,
	selectable: true,
	draggable: false,

	addAttributes() {
		return {
			kind: { default: "file" as ComposerChip["kind"] },
			raw: { default: "" },
			label: { default: "" },
		};
	},

	parseHTML() {
		return [
			{
				tag: "span.input-chip[data-raw]",
				getAttrs: (el) => {
					if (!(el instanceof HTMLElement)) return false;
					const kind = el.getAttribute("data-type");
					const raw = el.getAttribute("data-raw");
					if (!raw || (kind !== "file" && kind !== "skill" && kind !== "session" && kind !== "quote")) {
						return false;
					}
					return {
						kind,
						raw,
						label: el.textContent?.replace(/^[@/&❝]/, "").trim() || raw.slice(1),
					};
				},
			},
		];
	},

	renderHTML({ node, HTMLAttributes }) {
		const kind = String(node.attrs.kind ?? "file");
		const raw = String(node.attrs.raw ?? "");
		const label = String(node.attrs.label ?? raw);
		// quote chip 用引号字形而非 @/&/ 前缀：它引用的是对话内容，不是外部资源
		const icon = kind === "file" ? "@" : kind === "session" ? "&" : kind === "quote" ? "❝" : "/";
		// 单行省略内联在节点上：chip 是原子装饰节点，关键视觉不依赖样式表加载顺序
		// （@layer(legacy) + Vite HMR 曾出现更新丢失导致折行，见 quoteChipStyle 契约测试）；
		// 颜色仍走 timeline.css 的 .input-chip--quote（语义 token，暗色自适应）。
		const extraAttrs = kind === "quote"
			? {
					style:
						"display:inline-block;max-width:280px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;vertical-align:bottom;",
			  }
			: {};
		return [
			"span",
			mergeAttributes(HTMLAttributes, extraAttrs, {
				class: `input-chip input-chip--${kind}`,
				"data-type": kind,
				"data-raw": raw,
				contenteditable: "false",
				title: raw,
			}),
			["span", { class: "input-chip__icon" }, icon],
			["span", { class: "input-chip__label" }, label],
		];
	},

	addCommands() {
		return {
			insertMentionChip:
				(attrs) =>
				({ commands }) =>
					commands.insertContent({
						type: this.name,
						attrs,
					}),
		};
	},
});
