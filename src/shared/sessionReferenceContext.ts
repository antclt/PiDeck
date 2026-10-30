/**
 * 会话引用（`&会话名` → `<referenced_session>`）的上下文装配：纯函数，主进程（读 JSONL 取文）
 * 与渲染层（拼块正文）共用一份口径。
 *
 * 两条硬约束（2026-11 现场：引用一个大对话把上游上下文一次顶到 600K token）：
 *
 * 1) **只取正文块**。pi 的 assistant content 里 thinking 块占大头——实测一个 558K 字符的
 *    会话中 471K（84%）是 thinking。把思考链当引用正文，等于把模型的草稿本原样塞给上游；
 *    标题推断仍走 `sessionNameLine.extractTextFromContent`（那里 thinking 是有效兜底素材，
 *    两者刻意不共用）。
 * 2) **按估算预算保留最近的消息**。这段正文会写进用户消息落盘，之后每一轮请求都随历史
 *    重传，因此必须一次性封顶，而不是靠上游的上下文水位兜底。
 */

/**
 * 单次会话引用的上下文预算（估算 token）。
 *
 * 取值依据：足够装下一次「最近几轮」的可读对话（30K token ≈ 3 万字中文），
 * 又不至于单条引用就把 128K 窗口吃掉近三成。要放宽就改这里（调用方可覆盖）。
 */
export const REFERENCE_CONTEXT_TOKEN_BUDGET = 30_000;

/**
 * 全角/东亚宽度字符按 1 token/字、其余按 4 字符/token 估算。
 *
 * 不用真实 tokenizer：主进程读 JSONL 与渲染层各拼一次，为「截断水位」引入分词器既慢
 * 又会把 pi 的分词实现复制进来。这里要的是上界，不是精确计数。
 */
const WIDE_CHAR_RE = /[\u1100-\u11ff\u2e80-\u303f\u3040-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

/** 文本的估算 token 数（只用于预算判断与日志，不用于计费）。 */
export function estimateReferenceTokens(text: string): number {
	let cost = 0;
	for (const char of text) cost += WIDE_CHAR_RE.test(char) ? 1 : 0.25;
	return Math.ceil(cost);
}

/** 按预算截断文本（单条消息自己就超预算时用），截断处补省略号。 */
export function truncateReferenceText(text: string, budget: number): string {
	if (budget <= 0) return "";
	let cost = 0;
	let end = 0;
	for (const char of text) {
		cost += WIDE_CHAR_RE.test(char) ? 1 : 0.25;
		if (cost > budget) return `${text.slice(0, end)}…`;
		end += char.length;
	}
	return text;
}

/**
 * 消息 content → 引用正文：**只取正文块**。
 *
 * - 裸字符串原样返回（pi 的旧格式 / 已展开的用户消息）；
 * - 数组里取字符串项与 `{ type: "text", text }`；
 * - `thinking` 块直接丢弃（见文件头约束 1），图片与工具调用块没有 `.text`，自然不入选。
 */
export function extractReferenceMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (typeof item === "string") {
			if (item) parts.push(item);
			continue;
		}
		if (item === null || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (record.type === "thinking") continue;
		const text = record.text;
		if (typeof text === "string" && text.length > 0) parts.push(text);
	}
	return parts.join(" ");
}

export type ReferenceContextMessage = { role: string; content: string };

export type ReferenceContextResult = {
	/** 拼好的引用正文：`[User]: …` / `[Assistant]: …` 逐行（空字符串表示没有可引用的内容）。 */
	body: string;
	/** 保留下来的消息条数。 */
	kept: number;
	/** 因预算被裁掉的消息条数（0 = 未截断）。 */
	dropped: number;
	/** 正文的估算 token 数（截断后）。 */
	tokens: number;
};

/** 单条消息一行：保留既有的 `[User]/[Assistant]` 形态（模型据此区分发言方）。 */
function formatReferenceLine(message: ReferenceContextMessage): string {
	return `[${message.role === "user" ? "User" : "Assistant"}]: ${message.content}`;
}

/**
 * 把选中的历史消息拼成 `<referenced_session>` 的正文。
 *
 * 规则：
 * - 没有消息时返回空 body（调用方据此整段丢弃块，保持既有行为）；
 * - 预算内原样全留；
 * - 超预算时**从最早的消息开始裁**（保留最近的，与 `SessionScanner.readMessages` 的截尾口径一致），
 *   至少保留最新一条——但最新一条自己就超预算时按预算截断它的正文；
 * - `dropped > 0` 由调用方提示用户（并可在块内加一行省略说明），别静默丢内容。
 */
export function buildSessionReferenceContext(messages: readonly ReferenceContextMessage[], options?: { tokenBudget?: number }): ReferenceContextResult {
	const budget = Math.max(1, Math.floor(options?.tokenBudget ?? REFERENCE_CONTEXT_TOKEN_BUDGET));
	if (messages.length === 0) return { body: "", kept: 0, dropped: 0, tokens: 0 };

	const costs = messages.map((message) => estimateReferenceTokens(formatReferenceLine(message)));
	let kept = 0;
	let total = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		const cost = costs[index] ?? 0;
		// 至少保留最新一条：剩下的长度交给下面的截断分支处理，不能让引用变成空块。
		if (kept === 0) {
			kept = 1;
			total = cost;
			continue;
		}
		if (total + cost > budget) break;
		total += cost;
		kept++;
	}

	const selected = messages.slice(messages.length - kept);
	const lines = selected.map(formatReferenceLine);
	// 最新一条自己就超预算（此时 kept 必为 1）：截断它的正文，顺序仍保持「旧 → 新」。
	if (kept === 1 && (costs[costs.length - 1] ?? 0) > budget) {
		lines[0] = truncateReferenceText(lines[0] ?? "", budget);
	}

	const body = lines.join("\n");
	return { body, kept, dropped: messages.length - kept, tokens: estimateReferenceTokens(body) };
}
