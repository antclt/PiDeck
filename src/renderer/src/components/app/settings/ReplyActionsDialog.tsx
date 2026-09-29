import { ArrowDown, ArrowUp, FileJson, GripVertical, ListPlus, Plus, RefreshCw, RotateCcw, Trash2, Zap, ZapOff, AlertTriangle, Type, MessagesSquare } from "lucide-react";
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { MAX_REPLY_ACTION_RULES } from "../../../../../shared/replyActions";
import type { ReplyActionRule, ReplyActionTrigger } from "../../../../../shared/types/replyActions";
import { useReplyActionEditor } from "../../../hooks/useReplyActionEditor";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";

/**
 * 「回复快捷操作」管理弹框：规则清单的增删/排序/触发条件编辑/补充内置/恢复默认/重新读取/打开规则文件。
 *
 * 版式沿用 QuickMessagesDialog（一行一条 + 拖动排序 + 底部工具行），每行多一列触发条件：
 * 触发条件决定按钮何时出现（回复结束 onStop / 失败 onFailure / 命中关键词 textMatch），
 * 文案就是点击后发送的内容。
 *
 * 规则是结构化对象，任何改动都立即整份落盘（useReplyActionEditor），本组件只负责排版与事件转发；
 * 列表 key 用下标：文案随输入实时变化，用文本做 key 会在编辑过程中重建节点、丢输入焦点。
 */
export function ReplyActionsDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const editor = useReplyActionEditor();
	const { rules } = editor;
	const latestRef = useRef({ rules, open: props.open, reorderRules: editor.reorderRules });
	latestRef.current = { rules, open: props.open, reorderRules: editor.reorderRules };
	const dragRef = useRef<{ index: number; rules: ReplyActionRule[] } | null>(null);
	const [dropTarget, setDropTarget] = useState<number | null>(null);

	/** ref 是内部拖放的唯一来源；外部载荷即使伪造下标也不能触发排序。 */
	const clearDrag = useCallback(() => {
		dragRef.current = null;
		setDropTarget(null);
	}, []);

	useEffect(() => {
		// 下标只对开始拖动时那份列表有意义；增删/编辑/刷新和关闭都取消本次拖动。
		clearDrag();
		return () => {
			dragRef.current = null;
		};
	}, [rules, props.open, clearDrag]);

	/** 只允许把柄启动原生 HTML drag；自定义 MIME 仅让浏览器启动拖放，不携带规则正文。 */
	const startDrag = useCallback((event: DragEvent<HTMLButtonElement>, index: number) => {
		const current = latestRef.current;
		if (!current.open || index < 0 || index >= current.rules.length) {
			event.preventDefault();
			return;
		}
		event.stopPropagation();
		dragRef.current = { index, rules: current.rules };
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("application/x-pideck-reply-action", "move");
	}, []);

	/** 拖放期间使用最新 ref 校验列表身份，不能让过期事件移动到另一条规则。 */
	const canDrop = useCallback((target: number) => {
		const current = latestRef.current;
		const source = dragRef.current;
		return current.open && source !== null && source.rules === current.rules && source.index >= 0 && source.index < current.rules.length && Number.isInteger(target) && target >= 0 && target < current.rules.length;
	}, []);

	const dragOver = useCallback(
		(event: DragEvent<HTMLDivElement>, target: number) => {
			// 同时拦住输入框默认接收文本/文件的行为，不把外部 drop 交给宿主处理。
			event.preventDefault();
			event.stopPropagation();
			const allowed = canDrop(target);
			event.dataTransfer.dropEffect = allowed ? "move" : "none";
			setDropTarget(allowed ? target : null);
		},
		[canDrop],
	);

	const drop = useCallback(
		(event: DragEvent<HTMLDivElement>, target: number) => {
			event.preventDefault();
			event.stopPropagation();
			const source = dragRef.current;
			const allowed = canDrop(target);
			clearDrag();
			if (allowed && source) latestRef.current.reorderRules(source.index, target);
		},
		[canDrop, clearDrag],
	);

	return (
		<Dialog
			open={props.open}
			onOpenChange={(open) => {
				if (!open) clearDrag();
				props.onOpenChange(open);
			}}
		>
			<DialogContent className="sm:max-w-[min(1040px,calc(100vw-48px))] gap-3">
				<DialogHeader>
					<DialogTitle>{t("settings.replyActions")}</DialogTitle>
					<DialogDescription>{t("settings.replyActionsDesc", { max: MAX_REPLY_ACTION_RULES })}</DialogDescription>
					<p className="text-caption text-muted-foreground">{t("settings.replyActionsConfigHint")}</p>
				</DialogHeader>

				{editor.loading ? (
					<p className="py-6 text-center text-caption text-muted-foreground">{t("settings.replyActionsLoading")}</p>
				) : (
					<div className="flex min-h-0 flex-col gap-2">
						<div className="flex max-h-[min(52vh,420px)] min-h-0 flex-col gap-1.5 overflow-y-auto pr-1">
							{rules.length === 0 ? <p className="py-3 text-caption text-muted-foreground">{t("settings.replyActionsEmpty")}</p> : null}
							{rules.map((rule, index) => (
								<RuleRow key={index} rule={rule} index={index} rowCount={rules.length} dropTargetActive={dropTarget === index} editor={editor} startDrag={startDrag} dragOver={dragOver} drop={drop} dragLeave={() => setDropTarget(null)} clearDrag={clearDrag} />
							))}
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<Button type="button" variant="outline" size="sm" disabled={editor.atLimit} onClick={editor.addRule}>
								<Plus size={14} strokeWidth={2} aria-hidden="true" />
								{t("settings.replyActionsAdd")}
							</Button>
							<Button type="button" variant="outline" size="sm" disabled={editor.merging || editor.atLimit} title={t("settings.replyActionsMergeDefaultsHint")} onClick={() => void editor.mergeDefaults()}>
								<ListPlus size={14} strokeWidth={2} aria-hidden="true" />
								{t(editor.merging ? "settings.replyActionsMerging" : "settings.replyActionsMergeDefaults")}
							</Button>
							{editor.atLimit ? <span className="text-caption text-muted-foreground">{t("settings.replyActionsLimit", { max: MAX_REPLY_ACTION_RULES })}</span> : null}
						</div>
					</div>
				)}

				<DialogFooter className="sm:justify-between">
					<div className="flex flex-wrap items-center gap-1">
						<Button type="button" variant="ghost" size="sm" disabled={!editor.defaultsAvailable || editor.merging} title={editor.defaultsAvailable ? t("settings.replyActionsResetHint") : t("settings.replyActionsDefaultsUnavailable")} onClick={() => void editor.resetDefaults()}>
							<RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
							{t("settings.replyActionsReset")}
						</Button>
						<Button type="button" variant="ghost" size="sm" disabled={editor.merging} title={t("settings.replyActionsReloadHint")} onClick={() => void editor.refresh()}>
							<RefreshCw size={14} strokeWidth={2} aria-hidden="true" />
							{t("settings.replyActionsReload")}
						</Button>
						<Button type="button" variant="ghost" size="sm" onClick={() => void editor.openFile()}>
							<FileJson size={14} strokeWidth={2} aria-hidden="true" />
							{t("settings.replyActionsOpenFile")}
						</Button>
					</div>
					<DialogClose asChild>
						<Button type="button" variant="default" size="sm">
							{t("settings.replyActionsDone")}
						</Button>
					</DialogClose>
				</DialogFooter>

				{editor.filePath ? <p className="break-all text-caption text-muted-foreground">{t("settings.replyActionsFileHint", { path: editor.filePath })}</p> : null}
				{editor.error ? <p className="text-caption text-destructive">{editor.error}</p> : null}
			</DialogContent>
		</Dialog>
	);
}

/** 单条规则行：把柄 + 文案 + 触发条件编辑 + 上移/下移/删除。独立组件避免整表因单行输入重渲染。 */
function RuleRow(props: {
	rule: ReplyActionRule;
	index: number;
	rowCount: number;
	dropTargetActive: boolean;
	editor: ReturnType<typeof useReplyActionEditor>;
	startDrag: (event: DragEvent<HTMLButtonElement>, index: number) => void;
	dragOver: (event: DragEvent<HTMLDivElement>, index: number) => void;
	drop: (event: DragEvent<HTMLDivElement>, index: number) => void;
	dragLeave: () => void;
	clearDrag: () => void;
}) {
	const { rule, index, rowCount } = props;
	return (
		<div onDragOver={(event) => props.dragOver(event, index)} onDragLeave={props.dragLeave} onDrop={(event) => props.drop(event, index)} className={`flex min-w-0 items-center gap-1 rounded-md ${props.dropTargetActive ? "bg-accent ring-1 ring-inset ring-primary" : ""}`}>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				tabIndex={-1}
				draggable
				title={t("settings.replyActionsDragHandle")}
				aria-label={t("settings.replyActionsDragHandle")}
				onDragStart={(event) => props.startDrag(event, index)}
				onDragEnd={props.clearDrag}
				className="shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing"
			>
				<GripVertical size={14} strokeWidth={1.8} aria-hidden="true" />
			</Button>
			<Input value={rule.text} placeholder={t("settings.replyActionsPlaceholder")} onChange={(event) => props.editor.setRuleText(index, event.target.value)} className="min-w-0 flex-1" />
			<TriggerEditor triggers={rule.triggers} onChange={(triggers) => props.editor.setRuleTriggers(index, triggers)} />
			<Button type="button" variant="ghost" size="icon-sm" title={t("settings.replyActionsMoveUp")} aria-label={t("settings.replyActionsMoveUp")} disabled={index === 0} onClick={() => props.editor.moveRule(index, -1)}>
				<ArrowUp size={14} strokeWidth={1.8} aria-hidden="true" />
			</Button>
			<Button type="button" variant="ghost" size="icon-sm" title={t("settings.replyActionsMoveDown")} aria-label={t("settings.replyActionsMoveDown")} disabled={index === rowCount - 1} onClick={() => props.editor.moveRule(index, 1)}>
				<ArrowDown size={14} strokeWidth={1.8} aria-hidden="true" />
			</Button>
			<Button type="button" variant="ghost" size="icon-sm" title={t("settings.replyActionsRemove")} aria-label={t("settings.replyActionsRemove")} onClick={() => props.editor.removeRule(index)}>
				<Trash2 size={14} strokeWidth={1.8} aria-hidden="true" />
			</Button>
		</div>
	);
}

/** 触发条件编辑器：每条 trigger 一个胶囊（图标 + 类型），点 × 移除；下拉加新条件。 */
function TriggerEditor(props: { triggers: ReplyActionTrigger[]; onChange: (triggers: ReplyActionTrigger[]) => void }) {
	const triggers = props.triggers;

	const addTrigger = (kind: ReplyActionTrigger["kind"]) => {
		if (triggers.some((trigger) => trigger.kind === kind)) return;
		props.onChange([...triggers, kind === "textMatch" ? { kind, patterns: [] } : { kind }]);
	};

	const removeTrigger = (kind: ReplyActionTrigger["kind"]) => {
		props.onChange(triggers.filter((trigger) => trigger.kind !== kind));
	};

	const setPatterns = (patterns: string[]) => {
		props.onChange(triggers.map((trigger) => (trigger.kind === "textMatch" ? { ...trigger, patterns } : trigger)));
	};

	const matchTrigger = triggers.find((trigger) => trigger.kind === "textMatch");

	return (
		<div className="flex shrink-0 items-center gap-1">
			{triggers.map((trigger) => (
				<span key={trigger.kind} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground" title={t(`settings.replyActionsTrigger.${trigger.kind}`)}>
					{trigger.kind === "onStop" ? <MessagesSquare size={12} strokeWidth={1.8} aria-hidden="true" /> : trigger.kind === "onFailure" ? <AlertTriangle size={12} strokeWidth={1.8} aria-hidden="true" /> : <Type size={12} strokeWidth={1.8} aria-hidden="true" />}
					{t(`settings.replyActionsTrigger.${trigger.kind}`)}
					<button type="button" className="ml-0.5 text-muted-foreground hover:text-foreground" aria-label={t("settings.replyActionsTriggerRemove")} onClick={() => removeTrigger(trigger.kind)}>
						<ZapOff size={12} strokeWidth={1.8} aria-hidden="true" />
					</button>
				</span>
			))}
			<Select value="" onValueChange={(kind) => addTrigger(kind as ReplyActionTrigger["kind"])}>
				<SelectTrigger size="sm" className="h-7 w-7 px-0" title={t("settings.replyActionsTriggerAdd")} aria-label={t("settings.replyActionsTriggerAdd")}>
					<Zap size={12} strokeWidth={1.8} aria-hidden="true" />
				</SelectTrigger>
				<SelectContent>
					{(["onStop", "onFailure", "textMatch"] as const)
						.filter((kind) => !triggers.some((trigger) => trigger.kind === kind))
						.map((kind) => (
							<SelectItem key={kind} value={kind}>
								{t(`settings.replyActionsTrigger.${kind}`)}
							</SelectItem>
						))}
				</SelectContent>
			</Select>
			{matchTrigger ? (
				<Input
					value={(matchTrigger.patterns ?? []).join(", ")}
					placeholder={t("settings.replyActionsTriggerPatterns")}
					onChange={(event) =>
						setPatterns(
							event.target.value
								.split(/[,，]/)
								.map((pattern) => pattern.trim())
								.filter(Boolean),
						)
					}
					className="h-7 w-44 shrink-0 text-caption"
					title={t("settings.replyActionsTriggerPatternsHint")}
				/>
			) : null}
		</div>
	);
}
