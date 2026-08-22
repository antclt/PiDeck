/**
 * Composer TipTap：string ↔ ProseMirror doc 往返。
 * 单段落 + hardBreak 表示换行；mention 原子节点用 data-raw 还原。
 */

import type { JSONContent } from "@tiptap/core";
import {
	parseRichInputChips,
	type ComposerChip,
} from "../chips";

export type ComposerChipWhitelist = {
	validCommandNames?: Set<string>;
	validFilePaths?: Set<string>;
	validSessionRefs?: Set<string>;
	/** 引用 chip 白名单：id → 展示 label（截断后的快照预览）。 */
	validQuotes?: Map<string, string>;
};

function mentionNode(chip: ComposerChip): JSONContent {
	return {
		type: "mentionChip",
		attrs: {
			kind: chip.kind,
			raw: chip.raw,
			label: chip.label,
		},
	};
}

/** 将一行（不含 \\n）拆成 text + mention 内联节点。 */
function inlineNodesForLine(
	line: string,
	lineOffset: number,
	chips: ComposerChip[],
): JSONContent[] {
	const lineChips = chips
		.filter((c) => c.start >= lineOffset && c.end <= lineOffset + line.length)
		.map((c) => ({
			...c,
			start: c.start - lineOffset,
			end: c.end - lineOffset,
		}));
	if (lineChips.length === 0) {
		return line.length > 0 ? [{ type: "text", text: line }] : [];
	}
	const nodes: JSONContent[] = [];
	let cursor = 0;
	for (const chip of lineChips) {
		if (chip.start > cursor) {
			nodes.push({ type: "text", text: line.slice(cursor, chip.start) });
		}
		nodes.push(mentionNode(chip));
		cursor = chip.end;
	}
	if (cursor < line.length) {
		nodes.push({ type: "text", text: line.slice(cursor) });
	}
	return nodes;
}

/** 纯字符串 → TipTap JSON（单 paragraph，换行用 hardBreak）。 */
export function plainTextToComposerDoc(
	text: string,
	whitelist: ComposerChipWhitelist = {},
): JSONContent {
	const chips = parseRichInputChips(
		text,
		whitelist.validCommandNames,
		whitelist.validFilePaths,
		whitelist.validSessionRefs,
		whitelist.validQuotes,
	);
	const lines = text.split("\n");
	const content: JSONContent[] = [];
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (i > 0) content.push({ type: "hardBreak" });
		content.push(...inlineNodesForLine(line, offset, chips));
		offset += line.length + 1; // +1 for the split \n
	}
	return {
		type: "doc",
		content: [
			{
				type: "paragraph",
				content: content.length > 0 ? content : undefined,
			},
		],
	};
}

/** TipTap JSON / 节点 → 纯字符串（发信 / draft 真相）。 */
export function composerDocToPlainText(doc: JSONContent): string {
	const parts: string[] = [];
	const walk = (node: JSONContent): void => {
		if (node.type === "text" && typeof node.text === "string") {
			parts.push(node.text);
			return;
		}
		if (node.type === "hardBreak") {
			parts.push("\n");
			return;
		}
		if (node.type === "mentionChip") {
			const raw = node.attrs?.raw;
			if (typeof raw === "string") parts.push(raw);
			return;
		}
		if (node.type === "paragraph") {
			// 多段落时段落之间补换行（防御；当前 schema 只用单段）
			if (parts.length > 0 && !parts[parts.length - 1]?.endsWith("\n")) {
				parts.push("\n");
			}
			node.content?.forEach(walk);
			return;
		}
		node.content?.forEach(walk);
	};
	walk(doc);
	// 单 paragraph 开头不应多一个 \n
	if (parts[0] === "\n" && doc.content?.length === 1) {
		// no-op: hardBreaks only inside paragraph
	}
	return parts.join("");
}

/** 从 Editor storage / getJSON 得到的 doc 序列化。 */
export function serializeComposerEditorJson(json: JSONContent): string {
	return composerDocToPlainText(json);
}
