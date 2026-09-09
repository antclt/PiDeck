/**
 * 发送后仍需恢复为行内 chip 的「自包含消息块」编解码。
 *
 * prompt template 与 pi 展开的 skill 都必须把展示名称和完整模型上下文一起持久化：
 * 模型读完整正文，时间线只读 name 并折叠成 /command chip。该模块保持纯函数，
 * 不依赖 React/编辑器，供发送链路、气泡渲染和 node:test 共享。
 */

/** XML 属性转义（展示名称可能包含引号或尖括号）。 */
export function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** XML 属性反转义（仅处理本模块生成的四种实体）。 */
export function decodeXmlAttribute(value: string): string {
	return value
		.replace(/&quot;/g, "\"")
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&amp;/g, "&");
}

/** 防止正文中的闭合标签提前截断后续展示解析。 */
function sanitizeBlockText(value: string, tagName: string): string {
	return value.replace(new RegExp(`</${tagName}>`, "gi"), `</${tagName}_>`);
}

/**
 * 模板命令的发送/存储形态。
 *
 * 模板正文仍完整发给模型，但 name 同时持久化，因此会话重载后不必依赖当前模板列表
 * （模板被改名、删除或切换项目时也能还原原来的 /name chip）。
 */
export function formatPromptTemplateBlock(name: string, content: string): string {
	const safeName = escapeXmlAttribute(name);
	const safeContent = sanitizeBlockText(content, "prompt_template");
	// 不 trim 模板正文：空行也可能是提示词的刻意结构；仅在 tag 边界补必要换行。
	const openingBreak = /^\r?\n/.test(safeContent) ? "" : "\n";
	const closingBreak = /\r?\n$/.test(safeContent) ? "" : "\n";
	return `<prompt_template name="${safeName}">${openingBreak}${safeContent}${closingBreak}</prompt_template>`;
}

/** 解析后的命名消息块（skill/template 共用）。 */
export type ExpandedNamedReferenceBlock = {
	name: string;
	text: string;
	start: number;
	end: number;
};

function parseNamedReferenceBlocks(
	text: string,
	tagName: "skill" | "prompt_template",
): ExpandedNamedReferenceBlock[] {
	if (!text.includes(`<${tagName}`)) return [];
	const re = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, "gi");
	const blocks: ExpandedNamedReferenceBlock[] = [];
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		const attrs = match[1] ?? "";
		const name = /\bname="([^"]*)"/i.exec(attrs)?.[1];
		if (!name) continue;
		blocks.push({
			name: decodeXmlAttribute(name),
			text: (match[2] ?? "").replace(/^\r?\n|\r?\n$/g, ""),
			start: match.index,
			end: match.index + match[0].length,
		});
	}
	return blocks;
}

/** 从 pi 展开的 `<skill name="…">…</skill>` 块恢复技能名。 */
export function parseExpandedSkillBlocks(text: string): ExpandedNamedReferenceBlock[] {
	return parseNamedReferenceBlocks(text, "skill");
}

/** 从 PiDeck 展开的 `<prompt_template name="…">…</prompt_template>` 块恢复模板名。 */
export function parseExpandedPromptTemplateBlocks(
	text: string,
): ExpandedNamedReferenceBlock[] {
	return parseNamedReferenceBlocks(text, "prompt_template");
}
