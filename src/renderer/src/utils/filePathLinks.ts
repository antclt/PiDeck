/**
 * AI 回复中裸文件路径的「识别 + 解析」纯函数模块（零依赖，可被 node:test 直接导入）。
 *
 * 背景：remarkLinkifyPaths 把回复里的裸路径渲染成 file:// 链接，但模型提到的
 * 路径经常不存在（幻觉、跨项目绝对路径、文件已删/已移动），点击后主进程
 * ENOENT 返回空串 → 编辑器一片空白。参考 VS Code Copilot Chat 的
 * filePathLinkifier 做法（候选先 stat 校验、存在才保留链接、否则维持纯文本），
 * 渲染侧与校验侧共用同一份匹配/解析逻辑，保证「所见链接」=「校验对象」=
 * 「点击打开的路径」。
 */

/** 裸文件路径识别正则：
 * - 前缀支持盘符（大小写）、~ 家目录缩写、./ …、POSIX 根与「段段/」形式
 * - 排除空白 + ASCII 标点 + 全角标点/符号（，。；：！？、（）【】《》「」『』“”‘’·…—～￥×÷→←↑↓⇒／）
 * - 排除全角区（\u{FF00}-\u{FFEF}）、连字符/破折号区（\u{2010}-\u{2027}）、
 *   一般标点区（\u{2030}-\u{205E}）——避免 "src/a.ts，" 把全角逗号吞进路径
 * - 目录段与扩展名支持 Unicode 字母（中文/日文文件名）
 */
export const FILE_PATH_RE =
	/(?:[A-Za-z]:[\\/]|~[\\/]|(?:\.\.?[\\/]|[\\/])|(?:[\p{L}_][\p{L}\p{N}_.-]*[\\/])+)[^\s<>"'`|?*\[\](){}，。；：！？、（）【】《》「」『』“”‘’·…—～￥×÷→←↑↓⇒／\u{FF00}-\u{FFEF}\u{2010}-\u{2027}\u{2030}-\u{205E}]+\.[\p{L}\p{N}]+/gu;

/** 完整 URL（含 scheme 的任意协议）。打码用，只认形态不验证协议合法性。 */
const URL_RE = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`)\]]+/g;

export interface PlainFilePathMatch {
	path: string;
	start: number;
	end: number;
}

/**
 * 提取文本中的裸文件路径候选。
 * 完整 URL 先整体替换成等长空格再匹配：URL 尾巴（example.com/docs/a.md）长得
 * 就像嵌套路径，逐字符守卫（"://" 前缀、"//" 开头）总能被切分位置绕过；
 * 打码后索引不变，命中的 path 从原文按区间截取，调用方拿到的仍是原文本。
 */
export function matchPlainFilePaths(text: string): PlainFilePathMatch[] {
	const masked = text.replace(URL_RE, (matched) => " ".repeat(matched.length));
	const matches: PlainFilePathMatch[] = [];
	FILE_PATH_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = FILE_PATH_RE.exec(masked)) !== null) {
		matches.push({ path: text.slice(m.index, m.index + m[0].length), start: m.index, end: m.index + m[0].length });
	}
	return matches;
}

/** ~ 及 ~/ 开头视为绝对引用：~ 固定指用户家目录，不随项目 base 变化。 */
function isTildePath(path: string): boolean {
	return path === "~" || path.startsWith("~/") || path.startsWith("~\\");
}

/**
 * 规范化 Markdown 显式本地链接的目标（仅返回路径）。
 *
 * AI 常把 Windows 绝对路径写成 Markdown URL 形式 `/C:/...:42`；前导 `/`
 * 是 URL 表示法的一部分，不是 Windows 路径的一部分，末尾 `:42`/`:42:7`
 * 是位置标记，也不能参与 stat 或文件打开。校验与点击必须共用此结果，
 * 否则链接会先以未知状态显示，随后因 stat 错误降级成不可点击文本。
 */
export function normalizeFileLinkPath(path: string): string {
	return extractFileLinkLocation(path).path;
}

/** 解析结果：路径 + 可选行号/列号（1 起，位置标记来自 `path:line[:col]`）。 */
export interface FileLinkLocation {
	path: string;
	line?: number;
	column?: number;
}

/**
 * 解析 Markdown 显式本地链接的目标：分开「真实文件路径」与「行[:列] 位置标记」。
 * 调用方既能用 path 做存在性校验/打开文件，也能用 line 打开后滚动定位
 * （对齐 Claude Code / VS Code 的 file.ts:42 语义）。normalizeFileLinkPath
 * 委托本函数，保证「校验的路径」=「点击打开的路径」= 本函数返回的 path。
 */
export function extractFileLinkLocation(path: string): FileLinkLocation {
	let normalized = path;
	try {
		normalized = decodeURIComponent(path);
	} catch {
		// 非完整 URI 编码时保留原文；主流程仍会按原路径做安全校验。
	}
	if (/^\/[A-Za-z]:[\\/]/.test(normalized)) normalized = normalized.slice(1);
	const locationMatch = /:(\d+)(?::(\d+))?$/.exec(normalized);
	if (!locationMatch) return { path: normalized };
	const line = Number(locationMatch[1]);
	const column = locationMatch[2] === undefined ? undefined : Number(locationMatch[2]);
	const result: FileLinkLocation = { path: normalized.slice(0, locationMatch.index) };
	if (Number.isFinite(line)) result.line = line;
	if (column !== undefined && Number.isFinite(column)) result.column = column;
	return result;
}

export function isAbsoluteFilePath(path: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || isTildePath(path);
}

/**
 * 相对路径 → 绝对路径（base 检测分隔符选 \ 或 /）。
 * - 绝对路径（含盘符/根/~）原样直通：~ 不随项目 base 拼——它永远指用户家目录，
 *   主进程 stat 展不开会得到 false，链接自然降级为纯文本，这里只负责不改写。
 * - 无 base 的相对路径无从解析，返回 null——调用方按「未知」处理，不做存在性校验。
 * 与 App.handleOpenLinkedFile 点击链路同源，保证「校验的路径」=「点击打开的路径」。
 */
export function resolveFileLinkPath(path: string, basePath?: string): string | null {
	const normalized = normalizeFileLinkPath(path);
	if (!normalized) return null;
	if (isAbsoluteFilePath(normalized)) return normalized;
	if (!basePath) return null;
	const separator = basePath.includes("\\") ? "\\" : "/";
	return `${basePath.replace(/[\\/]+$/, "")}${separator}${normalized.replace(/^[\\/]+/, "")}`;
}
