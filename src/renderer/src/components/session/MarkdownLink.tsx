import type React from "react";
import { FileText } from "lucide-react";
import {
	isLocalPathRef,
	remarkLinkifyPaths,
} from "./MarkdownLinkCore";
import { useFilePathExists } from "./FileLinkBase";
export {
	isLocalPathRef,
	markdownUrlTransform,
	remarkLinkifyPaths,
} from "./MarkdownLinkCore";

/**
 * 链接渲染：file:// 前缀为 remarkLinkifyPaths 生成的文件路径链接，其余为普通外链。
 * 无协议 href（[text](path) 形式）识别为本地路径引用，点击走 onOpenFile。
 */
export function MarkdownLink(
	props: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
		onOpenExternal: (url: string, forceSystem?: boolean) => void;
		onOpenFile?: (path: string) => void;
	},
) {
	const { onOpenExternal, onOpenFile, children, className, title, ...anchorProps } = props;
	// remarkLinkifyPaths 生成的文件路径链接走 file:// 协议，与普通外链区分展示；
	// 无协议 href（[text](path) 形式）也是本地路径引用，同样走 onOpenFile
	const isFileLink = props.href?.startsWith("file://") ?? false;
	const isLocalRef = !isFileLink && isLocalPathRef(props.href ?? "");
	// 存在性判定只针对本地路径锚点：模型提到的路径经常不存在（幻觉/已删/跨项目），
	// VS Code 同款策略——校验不存在时降级为纯文本，不再渲染成点开后空白的死链。
	const fileLinkRawPath = props.href?.startsWith("file://")
		? decodeURIComponent(props.href.slice(7))
		: isLocalRef
			? (props.href ?? undefined)
			: undefined;
	const pathExists = useFilePathExists(fileLinkRawPath);
	const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
		e.preventDefault();
		if (!props.href) return;

		// 处理文件路径链接（file:// 协议 + 无协议的本地路径引用）
		if (props.href.startsWith("file://")) {
			const filePath = decodeURIComponent(props.href.slice(7));
			if (onOpenFile) {
				void onOpenFile(filePath);
			}
		} else if (isLocalPathRef(props.href)) {
			// [text](docs/guide.md) 这类 markdown 本地文档链接：按相对 cwd 解析打开
			if (onOpenFile) {
				void onOpenFile(props.href);
			}
		} else {
			// 普通 URL 链接：修饰键点击（Ctrl/Cmd）强制走系统浏览器。
			// 全局设置「内置浏览器」时，用户可临时用默认浏览器打开，无需改设置；
			// external 模式下 forceSystem 与默认行为一致，结果不变。
			void onOpenExternal(props.href, e.ctrlKey || e.metaKey || undefined);
		}
	};
	// false=已确认不存在：渲染纯文本（无图标/无 hover/title）；undefined=未知或校验中：维持链接现状
	if (isFileLink || isLocalRef) {
		if (pathExists === false) {
			return <span className="text-text-tertiary">{children}</span>;
		}
	}
	const linkClass =
		[className, isFileLink || isLocalRef ? "markdown-link-file" : undefined]
			.filter(Boolean)
			.join(" ") || undefined;
	return (
		<a
			{...anchorProps}
			className={linkClass}
			onClick={handleClick}
			// 文件链接 hover 展示解码后的完整路径，便于确认目标文件；
			// 普通链接不传 title，保留 markdown 自带 title 语法的原行为
			title={isFileLink ? decodeURIComponent(props.href!.slice(7)) : title}
		>
			{isFileLink ? (
				<>
					<FileText size={12} className="markdown-link-file-icon" />
					<span>{children}</span>
				</>
			) : (
				children
			)}
		</a>
	);
}
