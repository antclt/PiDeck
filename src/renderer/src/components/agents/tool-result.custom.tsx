import type { ReactNode } from "react";
import { Copy } from "lucide-react";
import { Button } from "../ui-shadcn/button";
import { writeClipboard } from "../../utils/clipboard";

/** 工具结果展示容器：保持结果可滚动，并提供统一的复制入口。 */
export interface ToolResultProps {
	children: ReactNode;
	showHeader?: boolean;
	tool?: ReactNode;
	title: string;
	status?: "running" | "success" | "error";
	kind?: string;
	maxHeight?: number;
	copyText?: string;
	copyClassName?: string;
	contentClassName?: string;
}

export function ToolResult(props: ToolResultProps) {
	const copy = async () => {
		if (props.copyText) await writeClipboard(props.copyText);
	};
	return (
		<section className="relative min-w-0" data-tool-kind={props.kind} data-status={props.status}>
			{props.showHeader !== false && (
				<div className="flex items-center gap-2 px-2 py-1.5 text-xs text-text-secondary">
					{props.tool}
					<strong className="truncate">{props.title}</strong>
				</div>
			)}
			<pre
				className={`m-0 overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-caption leading-relaxed ${props.contentClassName ?? "text-text-tertiary"}`}
				style={{ maxHeight: props.maxHeight }}
			>
				{props.children}
			</pre>
			{props.copyText && (
				<Button
					variant="ghost"
					size="icon-sm"
					className={`${props.copyClassName ?? "tool-card-copy"} absolute top-1 right-1 size-7 rounded-[4px] p-0 text-text-tertiary opacity-55 hover:text-[var(--color-accent)]`}
					onClick={() => void copy()}
					title="Copy result"
					aria-label="Copy result"
				>
					<Copy size={14} />
				</Button>
			)}
		</section>
	);
}
