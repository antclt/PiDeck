import { matchPlainFilePaths } from "../../utils/filePathLinks.ts";

/**
 * 本地复刻 react-markdown 的 defaultUrlTransform（迁移 streamdown 后不再依赖 react-markdown 包）：
 * 无协议/相对链接原样返回；非白名单协议清空（javascript:/data: 等危险协议被拦截）。
 * 白名单与 react-markdown 一致：http/https/irc/ircs/mailto/xmpp。
 */
const SAFE_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i;
export function defaultUrlTransform(value: string): string {
	// Windows 盘符路径（F:/... 或 F:\\...）是本地文件链接，不是协议：必须先放行，
	// 否则 "F:" 会被当作未知协议清空 href → 显式本地链接点了无反应。
	// 与 isLocalPathRef 的盘符判定同一口径。
	if (/^[a-zA-Z]:[\\/]/.test(value)) return value;
	const colon = value.indexOf(":");
	const questionMark = value.indexOf("?");
	const numberSign = value.indexOf("#");
	const slash = value.indexOf("/");

	if (
		// 无协议：相对链接
		colon === -1 ||
		// 首个冒号在 ?/#// 之后：不是协议（如 ./a:b.ts、path?x=1:2）
		(slash !== -1 && colon > slash) ||
		(questionMark !== -1 && colon > questionMark) ||
		(numberSign !== -1 && colon > numberSign) ||
		// 是协议且在安全白名单内
		SAFE_PROTOCOL.test(value.slice(0, colon))
	) {
		return value;
	}
	return "";
}

/**
 * Markdown 内的链接默认会在 Electron 窗口内导航,这里拦截点击统一用系统浏览器打开。
 * 支持文件路径链接（file:// 协议）点击打开文件。
 */
export function markdownUrlTransform(url: string): string {
	// react-markdown 默认会清空 file:// 协议；这里只放行本地文件链接，普通外链仍使用默认安全过滤。
	return url.startsWith("file://") ? url : defaultUrlTransform(url);
}

/**
 * mdast 插件：把裸文件路径转成 file:// 链接。
 * 只处理 type === "text" 的叶子节点，天然跳过 code / inlineCode / link 内的文本。
 * 匹配规则与存在性校验共用 utils/filePathLinks 的 matchPlainFilePaths（含 URL 尾巴排除），
 * 保证「渲染出的链接」与「后续 stat 校验的对象」永远同一份字符串。
 */
export const remarkLinkifyPaths = () => {
	return (tree: any) => {
		const visit = (node: any) => {
			if (!node || typeof node !== "object") return;
			const type: string = node.type;
			if (type === "code" || type === "inlineCode" || type === "link") return;
			if (type === "text" && typeof node.value === "string") {
				const text: string = node.value;
				const matches = matchPlainFilePaths(text);
				if (matches.length === 0) return;
				const segs: any[] = [];
				let last = 0;
				for (const match of matches) {
					if (match.start > last) segs.push({ type: "text", value: text.slice(last, match.start) });
					segs.push({
						type: "link",
						url: `file://${encodeURIComponent(match.path).replace(/%2F/g, "/").replace(/%3A/g, ":")}`,
						children: [{ type: "text", value: match.path }],
					});
					last = match.end;
				}
				node.__segs = segs;
				return;
			}
			const children: any[] | undefined = node.children;
			if (Array.isArray(children)) {
				const next: any[] = [];
				for (const child of children) {
					visit(child);
					if (child && (child as any).__segs) {
						const segs = (child as any).__segs;
						delete (child as any).__segs;
						next.push(...segs);
					} else {
						next.push(child);
					}
				}
				node.children = next;
			}
		};
		visit(tree);
	};
};

/**
 * 判断是否为本地文件路径引用（无协议的相对/绝对路径）：
 * markdown 链接 [text](docs/guide.md) 的 href 无协议，此前被当作外链交给系统浏览器
 * 打开（打开方式错误/无法打开）——这里识别为本地路径，点击走 onOpenFile。
 */
export function isLocalPathRef(url: string): boolean {
	if (!url) return false;
	// Windows 盘符路径（D:\x 或 D:/x）→ 本地路径（先于协议判断，避免 D: 被当协议）
	if (/^[a-zA-Z]:[\\/]/.test(url)) return true;
	// 有协议（http/https/ftp/mailto/file/data/javascript 等）→ 外链
	if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
	// 锚点 / 协议相对 URL → 不拦截（保持默认行为）
	if (url.startsWith("#") || url.startsWith("//")) return false;
	return true;
}
