/**
 * 救回被 Markdown 解析器拆坏的「带空格本地路径」行内链接。
 *
 * 触发场景：AI 在会话里经常这样引用本地文件——
 *   `[README.md](C:/Program Files (x86)/My App/README.md)`
 * CommonMark 的链接目标语法不允许裸空格与未配对的括号，解析器遇到 `(` 后的第一个
 * 空格即判定「这不是链接目标」，整段降级成纯文本：用户看到的是原始 `[...](...)`
 * 语法而不是可点击链接（GitHub 网页渲染同样如此，属于规范行为而非渲染器 bug）。
 *
 * 判定刻意收得紧（宁可少救，绝不把正文改坏）：
 * - 目标以盘符 `/` `./` `../` 开头（相对裸文件名与正文里的普通词组无法区分）；
 * - 目标必须含空格（不含空格的写法解析器本来就能处理，不需要插手）；
 * - 末段必须带扩展名 + 括号成对（见 LOCAL_TARGET_SHAPE / hasBalancedParentheses 的形态校验）；
 * - 作者写了转义（`\[`）时原文与节点值不同，跳过——作者显式不想让它成为链接。
 *
 * 修好的 url 用原始绝对路径（不带 file://）：MarkdownLink 的 isLocalPathRef 认盘符，
 * 点击走 onOpenFile 文件门控；与 remarkLinkifyPaths 生成的 file:// 链接殊途同归。
 */

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
 * 行内链接文本：不允许嵌套方括号/换行。
 * 目标段必须含空格（其余交给 CommonMark 自己解析），且以盘符、`/`、`./`、`../` 开头。
 * 目标内部不允许尖括号与反斜杠转义——含转义说明作者在用规范写法，不该插手。
 * 括号允许出现（`Program Files (x86)` 是 Windows 标准目录名，场景高频），
 * 由括号配对校验兜底防止误匹配到正文里的 `(备注)` 尾巴。
 */
const RECOVERABLE_INLINE_LINK = /\[([^\]\n]*)\]\(((?:\/(?!\/)|\.{1,2}\/|[a-zA-Z]:[\\/])[^\n<>]*\s[^\n<>]*)\)/gu;

/**
 * 目标形态校验：必须以强前缀（盘符 / 绝对 / `./`、`../`）开头，且末段带扩展名
 * （`xxx.md`、`x.tar.gz`）。
 * 不复用 matchPlainFilePaths：那个函数是「从长正文里扫出路径」的工具，会把带空格的
 * 目标按空格切成多段，用它做整串校验会把所有该救的场景全部拒掉。
 * 这里只回答一个二元问题：这一整串像不像一个本地路径。
 */
const LOCAL_TARGET_SHAPE = /^(?:[a-zA-Z]:[\\/]|\/(?!\/)|\.{1,2}\/)/;
const TARGET_HAS_EXTENSION = /\.[A-Za-z0-9]+$/;

/**
 * 括号必须成对且不嵌套错位：`(x86)`、`(1)` 合法，`a (b`、`a )b` 这类半截括号
 * 说明我们已经从路径里滑到了正文（如 `[x](/tmp/a b)（备注）` 的尾巴），不救。
 */
function hasBalancedParentheses(target: string): boolean {
	let depth = 0;
	for (const ch of target) {
		if (ch === "(") depth += 1;
		else if (ch === ")") {
			depth -= 1;
			if (depth < 0) return false;
		}
	}
	return depth === 0;
}

/**
 * 单个 text 节点内的恢复处理：把 `[text](带空格本地路径)` 切成普通文本 + link 节点。
 * 与 MarkdownLinkCore 的 __segs 整体替换模式一致——父节点消费 __segs 后整体替换，
 * 因此补回命中区间之外的原文是必须的，少一段就会丢正文。
 */
export function recoverInlineLinkSegments(value: string): MdNode[] | undefined {
	RECOVERABLE_INLINE_LINK.lastIndex = 0;
	const matches = [...value.matchAll(RECOVERABLE_INLINE_LINK)];
	const segs: MdNode[] = [];
	let last = 0;
	let recovered = false;
	for (const match of matches) {
		const target = match[2] ?? "";
		// 形态判定：强前缀 + 末段带扩展名。不是像样的本地路径就不救
		// （防止把正文里的 `[词](某 些 词)` 误改成链接；带空格是前提，无空格的正常写法
		//   CommonMark 自己就能解析，根本不会走到这里）。
		if (!LOCAL_TARGET_SHAPE.test(target) || !TARGET_HAS_EXTENSION.test(target) || !hasBalancedParentheses(target)) continue;
		if (match.index > last) segs.push({ type: "text", value: value.slice(last, match.index) });
		segs.push({ type: "link", url: target, children: [{ type: "text", value: match[1] ?? "" }] });
		last = match.index + match[0].length;
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
		if (source === "") return;

		const visit = (node: MdNode) => {
			if (!node || typeof node !== "object") return;
			const type: string = node.type;
			// 已经是链接 / 代码 / 数学内容的不动：链接是作者显式声明的，代码必须保持原文
			if (type === "link" || type === "code" || type === "inlineCode" || type === "math" || type === "inlineMath") return;
			if (type === "text" && typeof node.value === "string") {
				// 原文与节点值逐字相同才动手：作者写了转义（`\[x](...)`）时 position 区间含反斜杠，
				// slice 出来与 value 不同，此时作者显式不想要链接，保持原样。
				const start = node.position?.start?.offset;
				const end = node.position?.end?.offset;
				if (typeof start !== "number" || typeof end !== "number" || source.slice(start, end) !== node.value) return;
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
