/**
 * 会话内「引用追问」chip 的纯函数层。
 *
 * 设计（2026-09 审计定稿）：
 * - chip 是指针：草稿里只放短 token（如 #q3f2a1b0c），全文快照存在按 sessionId 隔离的
 *   atom 里（见 composer-atoms.ts）。token 长度即文本偏移长度，满足 chips.ts 对
 *   「raw 区间必须与 ProseMirror 纯文本偏移一致」的硬约束。
 * - 发送期展开：useSessionSend 在读取草稿后立即把 token 展开为 markdown 引用块，
 *   让乐观缓存/队列快照/历史记录统一拿到展开后的文本；token 永不出现在发给 pi 的内容里。
 * - 本模块不依赖 React / 编辑器，可被 node:test 直接加载单测。
 */

/** 引用快照：创建时捕获的文本 + 来源消息 id（时间线节点的 data-message-id）。 */
export type QuoteSnippet = {
	/** 形如 "q3f2a1b0c"（不含 # 前缀），与 token 正则的捕获体一致。 */
	id: string;
	/** 划选文本快照（纯文本、保留换行）；发送后不跟随源消息变化。 */
	text: string;
	/** 来源消息 id，用于展示出处与排查。 */
	messageId: string;
	createdAt: number;
};

/**
 * 引用 token 形态：#q + 6~12 位十六进制。
 * 边界规则：
 * - 前一字符不得是 \w . #（排除 "abc#q…""、"##q…"" 与 markdown 标题相邻场景）；
 * - 后一字符不得是字母数字（"#qabcdefg" 中 g 非十六进制会导致整体回溯失败，不算 token）；
 * - 手工敲出同形 token 只有在白名单命中该会话真实存在的快照 id 时才会渲染成 chip。
 */
const QUOTE_TOKEN_PATTERN = "(?<![\\w.#])#(q[0-9a-f]{6,12})(?![0-9a-zA-Z])";

/** 每次调用返回全新实例：global 正则有 lastIndex 状态，禁止模块级复用同一个实例。 */
export function createQuoteTokenRe(): RegExp {
	return new RegExp(QUOTE_TOKEN_PATTERN, "g");
}

/** 由快照 id 生成草稿 token 文本。 */
export function buildQuoteToken(id: string): string {
	return `#${id}`;
}

/** 生成新快照 id（32 位随机 hex，会话内数量级下碰撞可忽略）。 */
export function createQuoteId(): string {
	const hex = Math.floor(Math.random() * 0xffffffff)
		.toString(16)
		.padStart(8, "0");
	return `q${hex}`;
}

export type QuoteTokenOccurrence = {
	id: string;
	start: number;
	end: number;
};

/** 按出现顺序提取全部 token 及其偏移（同一 id 多次出现各计一次）。 */
export function extractQuoteTokens(text: string): QuoteTokenOccurrence[] {
	if (!text.includes("#q")) return [];
	const re = createQuoteTokenRe();
	const out: QuoteTokenOccurrence[] = [];
	for (let m = re.exec(text); m !== null; m = re.exec(text)) {
		out.push({ id: m[1] ?? "", start: m.index, end: m.index + m[0].length });
	}
	return out;
}

/**
 * 从草稿文本中剥离全部引用 token，并清理剥离后残留的空白
 * （连续空格压成一个、行尾空白去掉、首尾 trim）。用于发送守卫的「是否只剩引用」判断，
 * 以及展开时计算用户正文——两处调用方都希望拿到干净文本。
 */
export function stripQuoteTokens(text: string): string {
	if (!text.includes("#q")) return text.trim();
	return text
		.replace(createQuoteTokenRe(), "")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

/**
 * 把草稿中的引用 token 展开为 markdown 引用块（发送前唯一咽喉点调用）。
 *
 * 输出形态：
 *   > 引文行1
 *   > 引文行2
 *
 *   用户正文…
 *
 * 规则：
 * - 无 token 时返回 null，调用方沿用原文（零开销快速路径）；
 * - 同一 id 出现多次只产出一份引用块（按首次出现顺序）；
 * - resolve 未命中的孤儿 token 直接丢弃（自愈，不阻断发送）；
 * - 展开后若用户正文为空则只留引用块。
 */
export function expandQuoteTokens(
	text: string,
	resolve: (id: string) => QuoteSnippet | undefined,
): string | null {
	const occurrences = extractQuoteTokens(text);
	if (occurrences.length === 0) return null;

	const seen = new Set<string>();
	const blocks: string[] = [];
	for (const occurrence of occurrences) {
		if (seen.has(occurrence.id)) continue;
		seen.add(occurrence.id);
		const snippet = resolve(occurrence.id);
		if (!snippet) continue;
		blocks.push(formatQuoteBlock(snippet.text));
	}

	const rest = stripQuoteTokens(text).trim();
	return [...blocks, rest].filter((part) => part.length > 0).join("\n\n") || null;
}

/** 快照文本 → markdown 引用块：逐行加 "> "，空行用 ">" 占位以保持段落结构。 */
function formatQuoteBlock(text: string): string {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		// 去掉首尾空行（划选跨块时常带出），中间空行保留结构
		.join("\n")
		.replace(/^(\n)+/, "")
		.replace(/(\n)+$/, "");
	return lines
		.split("\n")
		.map((line) => (line.length > 0 ? `> ${line}` : ">"))
		.join("\n");
}

/**
 * chip label：取首个非空行、压平空白、截断并加省略号。
 * maxChars=18：composer 字号下约 250px，配合 CSS 单行省略双保险，保证 chip 永远一行
 * （用户要求：固定合适宽度，短则短、超出不显示，不折行）。
 */
export function truncateQuoteLabel(text: string, maxChars = 18): string {
	const firstLine =
		text
			.split("\n")
			.map((line) => line.replace(/\s+/g, " ").trim())
			.find((line) => line.length > 0) ?? "";
	if (firstLine.length <= maxChars) return firstLine;
	return `${firstLine.slice(0, maxChars)}…`;
}

/**
 * 追加引用 token 到草稿末尾（时间线侧写入无法拿到编辑器 caret，统一追加而非光标处插入；
 * 引用作为上下文块在问题前/后语义等价，发送期展开按出现顺序处理）。
 * token 后补一个空格：chip 是原子节点，无尾随空格时用户紧接着打字会贴住 chip。
 */
export function buildDraftWithAppendedQuote(draft: string, token: string): string {
	const trimmedEnd = draft.replace(/\s+$/, "");
	const spacer = trimmedEnd.length === 0 ? "" : " ";
	return `${trimmedEnd}${spacer}${token} `;
}

/**
 * 孤儿清理：剔除仓里草稿已不再引用的快照（用户删了 chip）。
 * 纯函数便于单测；调用方在每次登记新快照时顺带执行，避免无限堆积。
 */
export function pruneUnreferencedQuotes<T extends { id: string }>(
	map: Record<string, T>,
	keepIds: ReadonlySet<string>,
): Record<string, T> {
	const next: Record<string, T> = {};
	for (const [id, snippet] of Object.entries(map)) {
		if (keepIds.has(id)) next[id] = snippet;
	}
	return next;
}
