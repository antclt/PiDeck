import type React from "react";
import {
	isLocalPathRef,
	remarkLinkifyPaths,
} from "./MarkdownLinkCore";
import { useFilePathExists } from "./FileLinkBase";
import { extractFileLinkLocation } from "../../utils/filePathLinks";
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
		onOpenFile?: (path: string, line?: number) => void;
	},
) {
	const { onOpenExternal, onOpenFile, children, className, title, ...anchorProps } = props;
	// remarkLinkifyPaths 生成的文件路径链接走 file:// 协议，与普通外链区分展示；
	// 无协议 href（[text](path) 形式）也是本地路径引用，同样走 onOpenFile
	const isFileLink = props.href?.startsWith("file://") ?? false;
	const isLocalRef = !isFileLink && isLocalPathRef(props.href ?? "");
	// 显式 Markdown 链接可能写成 /C:/path/file.ts:42：先还原 Windows 盘符，
	// 再把行号从路径里拆出来。校验用纯路径，点击带上行号（打开后滚动定位）。
	const fileLinkRawPath = isFileLink
		? props.href!.slice(7)
		: isLocalRef
			? props.href
			: undefined;
	const fileLinkLocation = fileLinkRawPath === undefined
		? undefined
		: extractFileLinkLocation(fileLinkRawPath);
	const fileLinkPath = fileLinkLocation?.path;
	const fileLinkLine = fileLinkLocation?.line;
	const pathExists = useFilePathExists(fileLinkPath);
	const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
		e.preventDefault();
		if (!props.href) return;

		// 处理文件路径链接（file:// 协议 + 无协议的本地路径引用）
		if (isFileLink || isLocalRef) {
			if (onOpenFile && fileLinkPath) {
				void onOpenFile(fileLinkPath, fileLinkLine);
			}
		} else {
			// 普通 URL 链接：修饰键点击（Ctrl/Cmd）强制走系统浏览器。
			// 全局设置「内置浏览器」时，用户可临时用默认浏览器打开，无需改设置；
			// external 模式下 forceSystem 与默认行为一致，结果不变。
			void onOpenExternal(props.href, e.ctrlKey || e.metaKey || undefined);
		}
	};
	// false=已确认不存在：渲染纯文本；undefined=未知或校验中：维持普通文本链接，
	// 等存在性结果回来后只改变是否可点击，不引入胶囊式视觉跳变。
	if (isFileLink || isLocalRef) {
		if (pathExists === false) {
			return <span className="text-text-tertiary">{children}</span>;
		}
	}
	const linkClass =
		[
			className,
			isFileLink || isLocalRef
				? "cursor-pointer font-mono text-[var(--color-accent)] underline decoration-[var(--color-accent)]/50 underline-offset-2 hover:decoration-[var(--color-accent)]"
				: undefined,
		]
			.filter(Boolean)
			.join(" ") || undefined;
	return (
		<a
			{...anchorProps}
			className={linkClass}
			onClick={handleClick}
			// 文件链接 hover 展示解码后的完整路径，便于确认目标文件；
			// 普通链接不传 title，保留 markdown 自带 title 语法的原行为
			title={isFileLink ? fileLinkPath : title}
		>
			{children}
		</a>
	);
}
