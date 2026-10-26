/**
 * 救回被 Markdown 解析器拆坏的「带空格链接目标」。
 *
 * 触发场景：AI 在会话里经常这样引用本地文件——
 *   `[README.md](C:/Program Files (x86)/My App/README.md)`
 * CommonMark 的 link destination 不允许裸空格（spec §2.3），解析器遇到 `(` 后第一个空格
 * 即判定「这不是链接目标」，整段降级成纯文本：用户看到原始 `[...](...)` 语法而不是可
 * 点击链接（GitHub 网页渲染同样如此，属于规范行为而非渲染器 bug）。
 *
 * 设计原则：**只按 CommonMark 语法定界，不对「路径长什么样」做任何假设**。
 * - 不用扩展名、不用盘符前缀、不用括号是否成对的形态检查去判断「像不像路径」；
 * - 唯一判据是「这里本来是一个链接，只是目标里有空格导致解析器放弃」；
 * - 定界完全交给 CommonMark 规则：目标在括号深度归零的 `)` 结束（括号成对合法）；
 *   深度始终归不了零（目标本身含未配对括号）时退化为本行最后一个 `)`——这样
 *   `C:/a(b/x.md`、`C:/x (1)/y.md` 这类写法同样能救回；
 * - fail-safe：救不了/不该救的一律保持原样（等于现状）。
 *
 * 刻意不处理的只有两类明确不该插手的：
 * - 代码（code / inlineCode）与数学（math / inlineMath）：必须保持原文；
 * - 作者显式转义的 `\[`：作者不想要链接。
 *
 * 另外：作者手写的盘符路径（`[a](C:/x/y.md)`）解析能成功、不会走恢复路径，但 href 保持
 * 裸盘符会被 sanitize 剥掉。这类 link 节点也在本插件里统一改写成 file://，
 * 与恢复出的链接、remarkLinkifyPaths 生成的链接同一口径。
 *
 * 修好的 url 用目标原文（不带 file://）：MarkdownLink 认本地路径形态，点击走
 * onOpenFile 文件门控；与 remarkLinkifyPaths 生成的 file:// 链接殊途同归。
 */

import { encodeFileLinkTarget } from "../components/session/MarkdownLinkCore.ts";

/** remark/mdast 节点的最小形状：只访问本插件需要的字段（第三方边界，不引入 mdast 类型包）。 */
type MdNode = {
	type: string;
	value?: string;
	url?: string;
	children?: MdNode[];
	position?: { start?: { offset?: number }; end?: { offset?: number } };
	__segs?: MdNode[];
	[key: string]: unknown;
};

/**
 * 找 link destination 结束的 `)`。
 *
 * 按 CommonMark 的裸目标规则：目标不允许换行与尖括号，括号必须转义或成对。
 * 两个独立原因会导致解析器放弃一个链接，必须分别处理：
 * 1. 目标含空格（括号成对也一样，如 `Program Files (x86)`）——这是最常见原因；
 * 2. 目标括号不成对（`C:/a(b/x.md`）。
 * 定界规则：
 * - 括号成对 → 深度归零处的 `)` 就是终点；
 * - 括号不成对 → 深度永远归不了零，取遇到的**第一个** `)`。取最后一个会跨过
 *   同行后续的第二个链接，把 `[x](C:/a(b/c.md) 和 [y](D:/e.md)` 整个吞成一个
 *   target（实测回归）。
 * 转义序列（`\)`）不参与配对。
 */
function findDestinationEnd(text: string, from: number): { end: number; balanced: boolean } | null {
	let depth = 1;
	let firstClose = -1;
	for (let i = from; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === "\\") {
			i += 1; // 转义：与其后一个字符一起跳过，不参与括号配对
			continue;
		}
		if (ch === "\n" || ch === "<" || ch === ">") break;
		if (ch === "(") depth += 1;
		else if (ch === ")") {
			depth -= 1;
			if (depth === 0) return { end: i, balanced: true };
			if (firstClose < 0) firstClose = i;
		}
	}
	return firstClose >= 0 ? { end: firstClose, balanced: false } : null;
}

/** 找 label 结束的未转义 `]`（label 不允许跨行）。 */
function findLabelEnd(text: string, from: number): number | null {
	for (let i = from; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === "\\") {
			i += 1;
			continue;
		}
		if (ch === "\n") return null;
		if (ch === "]") return i;
	}
	return null;
}

/** 盘符开头的 link 目标：sanitize 会把 `C:` 当成未知协议 `c:` 而剥掉 href。 */
const WINDOWS_DRIVE_TARGET = /^[a-zA-Z]:[\\/]/;

/**
 * 把盘符路径的 link 目标统一改成 file:// 形式。
 * 为什么必须改：rehype-sanitize 的协议白名单只看 URL 首段冒号前的部分，`C:/...` 会被
 * 当成未知协议 `c:` 而剥掉 href，渲染出没有 href 的 <a>（点不动、无右键菜单）。
 * 统一到 file:// 后与 remarkLinkifyPaths、以及本插件恢复出的链接同一个口径。
 *
 * 先解码再编码：mdast 的 url 是作者书写的原文，可能已含百分号编码（作者手写 `%20`），
 * 直接 encodeURIComponent 会二次编码（`%20` → `%2520`）。解码失败时（非法序列）保持原样。
 */
function toFileLinkUrl(url: string): string {
	let decoded = url;
	try {
		decoded = decodeURIComponent(url);
	} catch {
		// 含非法百分号序列：按原样编码，不猜测作者意图
	}
	return encodeFileLinkTarget(decoded);
}

/**
 * 单个 text 节点内的恢复处理：把 `[text](带空格目标)` 切成普通文本 + link 节点。
 * 与 MarkdownLinkCore 的 __segs 整体替换模式一致——父节点消费 __segs 后整体替换，
 * 因此补回命中区间之外的原文是必须的，少一段就会丢正文。
 */
export function recoverInlineLinkSegments(value: string): MdNode[] | undefined {
	const segs: MdNode[] = [];
	let last = 0;
	let recovered = false;
	let cursor = 0;
	while (cursor < value.length) {
		const open = value.indexOf("[", cursor);
		if (open < 0) break;
		const close = findLabelEnd(value, open + 1);
		// `](` 必须紧邻：`[a] (b)` 这种写法 CommonMark 也不认
		if (close === null || value[close + 1] !== "(") {
			cursor = open + 1;
			continue;
		}
		const dest = findDestinationEnd(value, close + 2);
		if (dest === null) {
			cursor = open + 1;
			continue;
		}
		const target = value.slice(close + 2, dest.end);
		// 只按「CommonMark 为何放弃这个链接」判断，不看路径形态：
		// ① 目标含空白——裸目标不允许空格；② 括号不配对——规范要求成对或转义。
		// 这两个原因之外能走到这里的（如无空格的正常写法）解析器本来就能处理，不必插手。
		const failedPerSpec = !dest.balanced || /\s/u.test(target);
		if (target === "" || !failedPerSpec) {
			cursor = open + 1;
			continue;
		}
		if (open > last) segs.push({ type: "text", value: value.slice(last, open) });
		segs.push({ type: "link", url: encodeFileLinkTarget(target), children: [{ type: "text", value: value.slice(open + 1, close) }] });
		last = dest.end + 1;
		cursor = last;
		recovered = true;
	}
	if (!recovered) return undefined;
	// 命中之后的正文必须原样补回（见 MarkdownLinkCore 同款注释的历史回归）
	if (last < value.length) segs.push({ type: "text", value: value.slice(last) });
	return segs;
}

export const remarkRecoverInlineLinks = () => {
	return (tree: MdNode, file?: { value?: unknown }) => {
		const source = typeof file?.value === "string" ? file.value : "";

		const visit = (node: MdNode) => {
			if (!node || typeof node !== "object") return;
			const type: string = node.type;
			if (type === "link") {
				// 作者手写的盘符路径（解析能成功、不走恢复路径）同样需要改成 file://，
				// 否则 sanitize 会按未知协议剥掉 href（同一症状、不同入口）。
				if (typeof node.url === "string" && WINDOWS_DRIVE_TARGET.test(node.url)) {
					node.url = toFileLinkUrl(node.url);
				}
				return;
			}
			// 代码 / 数学内容不动：必须保持原文
			if (type === "code" || type === "inlineCode" || type === "math" || type === "inlineMath") return;
			if (type === "text" && typeof node.value === "string") {
				// 只识别作者显式转义的 `\[`：源文里该 text 节点起始处是反斜杠，说明作者
				// 不想要链接。不用「整段原文与节点值逐字相等」去判断——CommonMark 会在节点值
				// 里解析掉 `\\` `\)` 等转义，逐字比对会误杀 UNC/带转义字符的正常路径。
				const start = node.position?.start?.offset;
				if (typeof start === "number" && source[start] === "\\") return;
				const segs = recoverInlineLinkSegments(node.value);
				if (segs) node.__segs = segs;
				return;
			}
			const children: MdNode[] | undefined = node.children;
			if (!Array.isArray(children)) return;
			const next: MdNode[] = [];
			for (const child of children) {
				visit(child);
				if (child && child.__segs) {
					const segs = child.__segs;
					delete child.__segs;
					next.push(...segs);
				} else {
					next.push(child);
				}
			}
			node.children = next;
		};

		visit(tree);
	};
};
