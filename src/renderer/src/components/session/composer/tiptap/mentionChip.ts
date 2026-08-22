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
				// 兼容两种形态：旧 chip（span.input-chip[data-raw]）与新普通文本引用
				// （span[data-raw][data-type]）——历史记录 load 回编辑器时都能重建原子节点。
				tag: "span[data-raw][data-type]",
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
		// 文件/技能（含提示词模板，同为 slash 命令 token）引用按用户要求做普通文本：
		// 不再套 .input-chip 徽章外观，与正文同视感。仍保留 data-raw/data-type 与
		// contenteditable=false——点击定位（closest [data-raw]）与内容再解析都依赖它们。
		if (kind === "file" || kind === "skill") {
			return [
				"span",
				mergeAttributes(HTMLAttributes, {
					"data-type": kind,
					"data-raw": raw,
					contenteditable: "false",
					title: raw,
				}),
				raw || label,
			];
		}
		// session（& 会话引用）与 quote（❝ 对话引用）保留 chip 外观：它们是跨内容引用，
		// 徽章化有助于与正文区分，且时间线共用同一渲染。
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
