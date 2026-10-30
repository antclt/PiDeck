/**
 * 模型思考（reasoning）展示文本的唯一净化实现（对齐 DSH 0.2.1-rc.5 `reasoning-text.ts`）。
 *
 * 部分供应商把思维签名整块拼进推理正文流的最前面（`<signature>…</signature>`），
 * 原样渲染就是折叠行里一段无意义的 XML、展开正文也被签名挤占。rc.5 的 ReasoningRow
 * 在展示前统一跑一遍 `reasoningText()`，PiDeck 在「思考文本进入展示」的边界做同样的事：
 * - 只认文本开头：`text[0] !== "<"` 直接返回原引用（流式高频调用走 O(1) 快速路径）；
 * - 签名块未闭合时（含只收到 `<sig` 这类半个开口标签）返回空串——宁可暂时不显示，
 *   也不能把签名正文抖到界面上；清洗后为空则调用方整行隐藏；
 * - 闭合标签后跳过紧随的换行，剩余文本才是可展示的思考。
 *
 * 纯函数、无 Node/Electron/React 依赖，main 的投影/live 通道与 renderer 共用并可单测。
 * 只用于展示：累积思考原文（`pendingAssistantThinking` / 流式游标）必须保留签名，
 * 每次对「全量累积文本」调用本函数，不要对 delta 调用。
 */

const SIGNATURE_OPEN = "<signature>";
const SIGNATURE_CLOSE = "</signature>";

/** 思考原文 → 展示文本（剥离开头思维签名块；未闭合时返回空串）。 */
export function reasoningText(text: string): string {
	if (text[0] !== "<") return text;
	if (SIGNATURE_OPEN.startsWith(text)) return "";
	if (!text.startsWith(SIGNATURE_OPEN)) return text;
	const end = text.indexOf(SIGNATURE_CLOSE, SIGNATURE_OPEN.length);
	if (end === -1) return "";
	let start = end + SIGNATURE_CLOSE.length;
	while (start < text.length) {
		if (text[start] === "\n") start += 1;
		else if (text[start] === "\r" && text[start + 1] === "\n") start += 2;
		else break;
	}
	return text.slice(start);
}
