import { memo, useCallback, useRef } from "react";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import { Download, Eye, FilePlus, MoreHorizontal, Pencil, Trash2, X } from "lucide-react";
import { remarkGfmNoSingleTilde } from "../../utils/markdownPlugins";
import { MarkdownStream } from "../session/MarkdownStream";
import { continueListOnNewline, normalizeOrderedLists, prepareTaskListPreview } from "./scratchPadLists";
import type { Plugin } from "unified";
import type { Root, Element, Text } from "hast";
import type { DraftMeta } from "../../../../shared/types";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Textarea } from "../ui-shadcn/textarea";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui-shadcn/dropdown-menu";

type Mode = "edit" | "preview";

type ScratchPadPanelProps = {
	drafts: DraftMeta[];
	currentDraftPath: string | null;
	content: string;
	mode: Mode;
	isClosing?: boolean;
	isSaving: boolean;
	hasError: boolean;
	onChangeContent: (value: string) => void;
	onSetMode: (mode: Mode) => void;
	onToggleCheckbox: (lineIndex: number) => void;
	onExport: () => void;
	onSelectDraft: (draftPath: string) => void;
	onCreateDraft: () => void;
	onDeleteDraft: (draftPath: string) => void;
	/** 关闭草稿本（不再有全屏遮罩，关闭入口收敛到面板右上角 X / Escape / ⌘⇧S）。 */
	onClose: () => void;
};

/*
 * 自写 rehype 插件：把文本节点里的 ==text== 模式转成 <mark>text</mark>。
 * 这是 unified v11 / remark v14+ 环境下的稳定方案。
 */
const rehypeHighlightMark: Plugin<[], Root> = () => {
	return (tree) => {
		const walker = (nodes: Root["children"]) => {
			for (let i = 0; i < nodes.length; i++) {
				const node = nodes[i];
				if (node.type === "element" && node.children) {
					walker(node.children as (Text | Element)[]);
				}
				if (node.type === "text") {
					const textNode = node as Text;
					const { value } = textNode;
					const regex = /==([^=\n]+)==/g;
					const children: (Text | Element)[] = [];
					let match: RegExpExecArray | null;
					let lastIndex = 0;

					while ((match = regex.exec(value)) !== null) {
						if (match.index > lastIndex) {
							children.push({ type: "text", value: value.slice(lastIndex, match.index) });
						}
						children.push({
							type: "element",
							tagName: "mark",
							properties: {},
							children: [{ type: "text", value: match[1] }],
						});
						lastIndex = regex.lastIndex;
					}

					if (children.length === 0) continue;
					if (lastIndex < value.length) {
						children.push({ type: "text", value: value.slice(lastIndex) });
					}
					nodes.splice(i, 1, ...children);
					i += children.length - 1;
				}
			}
		};
		walker(tree.children);
	};
};

/* 草稿列表项：hover 行时显示删除；仅一份草稿时不提供删除入口 */
const DraftItem = memo(function DraftItem({
	draft,
	isActive,
	canDelete,
	onSelect,
	onDelete,
}: {
	draft: DraftMeta;
	isActive: boolean;
	canDelete: boolean;
	onSelect: () => void;
	onDelete: () => void;
}) {
	return (
		<div
			className={`group mx-1 flex h-7 cursor-pointer select-none items-center gap-1 rounded-md px-2 text-xs transition-colors ${
				isActive
					? "bg-accent text-accent-foreground"
					: "text-foreground/80 hover:bg-muted hover:text-foreground"
			}`}
			onClick={onSelect}
			role="button"
			tabIndex={0}
			onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
		>
			<span className="min-w-0 flex-1 truncate" title={draft.name}>{draft.name}</span>
			{canDelete && (
				<button
					className="hidden h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-destructive group-hover:flex"
					title={t("scratchPad.deleteDraft")}
					onClick={(e) => { e.stopPropagation(); onDelete(); }}
					aria-label={t("scratchPad.deleteDraft")}
				>
					<Trash2 size={11} />
				</button>
			)}
		</div>
	);
});

export const ScratchPadPanel = memo(function ScratchPadPanel(props: ScratchPadPanelProps) {
	const {
		drafts,
		currentDraftPath,
		content,
		mode,
		isClosing,
		onChangeContent,
		onSetMode,
		onToggleCheckbox,
		onExport,
		onSelectDraft,
		onCreateDraft,
		onDeleteDraft,
		onClose,
	} = props;

	const empty = !content.trim();
	const lines = content.split("\n");
	const editorRef = useRef<HTMLTextAreaElement>(null);

	const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
		const ta = e.currentTarget;
		const res = continueListOnNewline(ta.value, ta.selectionStart);
		if (!res) return;
		e.preventDefault();
		onChangeContent(res.next);
		requestAnimationFrame(() => {
			ta.selectionStart = ta.selectionEnd = res.cursor;
		});
	}, [onChangeContent]);

	const handleContentChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
		const textarea = event.currentTarget;
		const next = normalizeOrderedLists(textarea.value);
		onChangeContent(next);
		if (next === textarea.value) return;
		const cursor = Math.min(textarea.selectionStart, next.length);
		requestAnimationFrame(() => {
			textarea.selectionStart = textarea.selectionEnd = cursor;
		});
	}, [onChangeContent]);

	/* 点击删除按钮（仅剩一份草稿时不删除，保留最后一份） */
	const handleDeleteDraft = useCallback((draftPath: string) => {
		if (drafts.length <= 1) {
			return;
		}
		onDeleteDraft(draftPath);
	}, [drafts.length, onDeleteDraft]);

	const canDeleteCurrent = Boolean(currentDraftPath) && drafts.length > 1;

	return (
		<div
			className={"scratch-pad-panel" + (isClosing ? " closing" : "")}
			onClick={(event) => event.stopPropagation()}
		>
			<header className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-muted/60 pl-4 pr-2">
				<div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
					<Pencil size={13} className="text-muted-foreground" aria-hidden="true" />
					<span>{t("scratchPad.title")}</span>
					<kbd className="ml-1 font-mono text-[11px] font-normal text-muted-foreground">⌘⇧S</kbd>
				</div>
				{/* 编辑/预览分段切换：高频操作独立展示 */}
				<div
					className="ml-auto flex items-center gap-0.5 rounded-md bg-muted p-0.5"
					role="tablist"
					aria-label={t("scratchPad.title")}
				>
					<button
						type="button"
						role="tab"
						aria-selected={mode === "edit"}
						onClick={() => onSetMode("edit")}
						className={`flex items-center gap-1 rounded-[5px] px-2 py-1 text-xs transition-colors ${
							mode === "edit"
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground"
						}`}
					>
						<Pencil size={12} aria-hidden="true" />{t("scratchPad.edit")}
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={mode === "preview"}
						onClick={() => onSetMode("preview")}
						className={`flex items-center gap-1 rounded-[5px] px-2 py-1 text-xs transition-colors ${
							mode === "preview"
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground"
						}`}
					>
						<Eye size={12} aria-hidden="true" />{t("scratchPad.preview")}
					</button>
				</div>
				{/* 低频操作（新建/导出/删除）收进 ⋯ 菜单；关闭保持独立入口 */}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon-sm"
							className="size-7"
							title={t("tabs.moreActions")}
							aria-label={t("tabs.moreActions")}
						>
							<MoreHorizontal className="size-4" aria-hidden="true" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-36">
						<DropdownMenuItem onClick={onCreateDraft}>
							<FilePlus size={14} aria-hidden="true" />{t("scratchPad.newDraft")}
						</DropdownMenuItem>
						<DropdownMenuItem onClick={onExport}>
							<Download size={14} aria-hidden="true" />{t("scratchPad.export")}
						</DropdownMenuItem>
						{canDeleteCurrent && (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									className="text-destructive focus:text-destructive"
									onClick={() => { if (currentDraftPath) handleDeleteDraft(currentDraftPath); }}
								>
									<Trash2 size={14} aria-hidden="true" />{t("scratchPad.deleteDraft")}
								</DropdownMenuItem>
							</>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
				{/* X 是唯一可见的关闭入口（Escape/⌘⇧S 仍有效） */}
				<Button
					variant="ghost"
					size="icon-sm"
					className="size-7"
					title={t("common.close")}
					aria-label={t("common.close")}
					onClick={onClose}
				>
					<X className="size-4" aria-hidden="true" />
				</Button>
			</header>

			<div className="flex min-h-0 flex-1">
				{/* 草稿列表常驻左侧：省去「显示文件列表」开关 */}
				{drafts.length > 0 && (
					<aside className="flex w-40 shrink-0 flex-col border-r border-border bg-muted/30">
						<div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1.5">
							{drafts.map((d) => (
								<DraftItem
									key={d.path}
									draft={d}
									isActive={d.path === currentDraftPath}
									canDelete={drafts.length > 1}
									onSelect={() => onSelectDraft(d.path)}
									onDelete={() => handleDeleteDraft(d.path)}
								/>
							))}
						</div>
						<div className="border-t border-border p-1.5">
							<Button
								variant="ghost"
								size="sm"
								className="w-full justify-start gap-1.5 text-xs text-muted-foreground"
								onClick={onCreateDraft}
							>
								<FilePlus size={13} aria-hidden="true" />{t("scratchPad.newDraft")}
							</Button>
						</div>
					</aside>
				)}

				<div className="flex min-w-0 flex-1 flex-col">
					{mode === "edit" ? (
						<Textarea
							ref={editorRef}
							className="flex-1 rounded-none border-0 bg-transparent p-4 font-mono text-sm leading-relaxed shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
							value={content}
							placeholder={t("scratchPad.placeholder")}
							onChange={handleContentChange}
							onKeyDown={handleKeyDown}
							autoFocus
							spellCheck={false}
						/>
					) : (
						<div className="min-h-0 flex-1 overflow-y-auto p-4 text-foreground">
							{empty ? (
								<div className="grid h-full place-items-center text-sm text-muted-foreground">
									<em>{t("scratchPad.empty")}</em>
								</div>
							) : (
								<div className="scratch-pad-md">
									<MarkdownStream
										key={`scratch-pad-${content}`}
										text={prepareTaskListPreview(content)}
										onOpenExternal={() => undefined}
										remarkPlugins={[remarkGfmNoSingleTilde, remarkMath, remarkBreaks]}
										rehypePlugins={[rehypeKatex, rehypeHighlightMark]}
										components={{
											/* GFM task list：用 AST 节点行号直接定位源码行，避免 render-order 计数器漂移 */
											li: ({ node, className, children, ...liProps }) => {
												const classes = String(className ?? "");
												const lineIndex = typeof node?.position?.start?.line === "number" ? node.position.start.line - 1 : undefined;
												const isTaskItem = typeof lineIndex === "number" && /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(lines[lineIndex] ?? "");
												if (!isTaskItem) {
													return <li {...liProps} className={classes}>{children}</li>;
												}
												return (
													<li
														{...liProps}
														className={classes}
														/* 勾选只响应方框本身：只有点击 checkbox 才切换，点文字不触发 */
														onClick={(event) => {
															const target = event.target as HTMLElement;
															if (!target.closest('input[type="checkbox"]')) return;
															onToggleCheckbox(lineIndex);
														}}
													>
														{children}
													</li>
												);
											},
											input: ({ className, ...inputProps }) => {
												if (inputProps.type === "checkbox") {
													/* 任务项 checkbox 不能用共享 Input：h-9 w-full 会把方框
													   撑成整行，文字被挤到下一行 */
													return (
														<input
															{...inputProps}
															className={className ? `scratch-pad-checkbox ${className}` : "scratch-pad-checkbox"}
															disabled={false}
															readOnly
															tabIndex={-1}
														/>
													);
												}
												return <Input {...inputProps} className={className} />;
											},
										}}
									/>
								</div>
							)}
						</div>
					)}
				</div>
			</div>

		</div>
	);
});
