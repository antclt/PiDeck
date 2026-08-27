import { memo, useMemo, type MouseEvent } from "react";
import { splitByPaths } from "../../utils/toolResultPaths";
import { useFilePathExists } from "./FileLinkBase";

/**
 * 工具结果（bash/find/grep 等纯文本输出）里的文件路径链接化。
 *
 * 与正文（markdown 药丸 chip）不同：工具输出是等宽终端文本，`# / * >` 等不能被
 * markdown 误解析，且药丸 chip 观感太重——这里用**纯文本链接**（强调色 + 下划线，
 * 无图标/无背景边框），点击走与正文同源的 handleOpenLinkedFile。
 * 存在性校验（useFilePathExists）与正文同源：判定不存在的路径降级纯文本、不硬点。
 */
export { splitByPaths } from "../../utils/toolResultPaths";

/** 单个工具结果路径段的可点击链接（死链降级纯文本） */
function ToolResultPathLink(props: { path: string; onOpenFile?: (path: string) => void }) {
	const exists = useFilePathExists(props.path);
	if (exists === false) return <>{props.path}</>;
	const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
		e.preventDefault();
		props.onOpenFile?.(props.path);
	};
	return (
		<a
			href="#"
			onClick={onClick}
			title={props.path}
			className="cursor-pointer text-[var(--color-accent)] underline decoration-[var(--color-accent)]/50 underline-offset-2 hover:decoration-[var(--color-accent)]"
		>
			{props.path}
		</a>
	);
}

export const ToolResultText = memo(function ToolResultText(props: {
	text: string;
	onOpenFile?: (path: string) => void;
}) {
	const segments = useMemo(() => splitByPaths(props.text), [props.text]);
	// 无路径：直接返回字符串，避免包一层 span 影响 <pre> 排版与选中复制
	if (segments.length === 1 && segments[0].type === "text") {
		return <>{segments[0].value}</>;
	}
	return (
		<>
			{segments.map((seg, i) =>
				seg.type === "text" ? (
					<span key={i}>{seg.value}</span>
				) : (
					<ToolResultPathLink key={i} path={seg.path} onOpenFile={props.onOpenFile} />
				),
			)}
		</>
	);
});