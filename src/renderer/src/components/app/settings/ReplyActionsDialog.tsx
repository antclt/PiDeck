import { ArrowDown, ArrowUp, FileJson, GripVertical, ListPlus, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { MAX_REPLY_ACTION_RULES } from "../../../../../shared/replyActions";
import type { ReplyActionRule, ReplyActionTrigger } from "../../../../../shared/types/replyActions";
import { useReplyActionEditor } from "../../../hooks/useReplyActionEditor";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../ui-shadcn/table";

/**
 * 回复快捷操作规则管理器。
 *
 * 一行一条规则，只回答两个问题：「按钮写什么」「什么时候显示」。
 * 触发场景合并成一个有文字说明的下拉（回复成功 / 回复失败 / 全部 / 命中关键词）——
 * 拆成「成功」「失败」两列勾选框时，用户既看不出每个开关单独管什么，也看不出勾几个是并集，
 * 合并后条件自解释、一次只能选一个，组合语义不再暴露给用户。
 */
export function ReplyActionsDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const editor = useReplyActionEditor();
	const { rules } = editor;
	const latestRef = useRef({ rules, open: props.open, reorderRules: editor.reorderRules });
	latestRef.current = { rules, open: props.open, reorderRules: editor.reorderRules };
	const dragRef = useRef<{ index: number; rules: ReplyActionRule[] } | null>(null);
	const [dropTarget, setDropTarget] = useState<number | null>(null);

	const clearDrag = useCallback(() => {
		dragRef.current = null;
		setDropTarget(null);
	}, []);

	useEffect(() => {
		clearDrag();
		return () => {
			dragRef.current = null;
		};
	}, [rules, props.open, clearDrag]);

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

	const canDrop = useCallback((target: number) => {
		const current = latestRef.current;
		const source = dragRef.current;
		return current.open && source !== null && source.rules === current.rules && source.index >= 0 && source.index < current.rules.length && Number.isInteger(target) && target >= 0 && target < current.rules.length;
	}, []);

	const dragOver = useCallback(
		(event: DragEvent<HTMLTableRowElement>, target: number) => {
			event.preventDefault();
			event.stopPropagation();
			const allowed = canDrop(target);
			event.dataTransfer.dropEffect = allowed ? "move" : "none";
			setDropTarget(allowed ? target : null);
		},
		[canDrop],
	);

	const drop = useCallback(
		(event: DragEvent<HTMLTableRowElement>, target: number) => {
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
			<DialogContent onOpenAutoFocus={(event) => event.preventDefault()} className="w-[min(960px,calc(100vw-48px))] max-w-none gap-3 sm:max-w-none">
				<DialogHeader>
					<DialogTitle>{t("settings.replyActions")}</DialogTitle>
					<DialogDescription>{t("settings.replyActionsDesc", { max: MAX_REPLY_ACTION_RULES })}</DialogDescription>
					<p className="text-caption text-muted-foreground">{t("settings.replyActionsConfigHint")}</p>
				</DialogHeader>

				{editor.loading ? (
					<p className="py-6 text-center text-caption text-muted-foreground">{t("settings.replyActionsLoading")}</p>
				) : (
					<div className="flex min-h-0 flex-col gap-2">
						<div className="max-h-[min(52vh,420px)] min-h-0 overflow-auto rounded-md border">
							<Table className="min-w-[760px] table-fixed">
								<colgroup>
									<col className="w-10" />
									<col className="w-[26%]" />
									<col className="w-[38%]" />
									<col className="w-24" />
								</colgroup>
								<TableHeader>
									<TableRow className="bg-bg-muted hover:bg-bg-muted">
										<TableHead className="w-10 px-2" aria-label={t("settings.replyActionsColumnOrder")}>
											{t("settings.replyActionsColumnOrder")}
										</TableHead>
										<TableHead>{t("settings.replyActionsColumnText")}</TableHead>
										<TableHead>{t("settings.replyActionsColumnTrigger")}</TableHead>
										<TableHead className="text-right">{t("settings.replyActionsColumnOperations")}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{rules.length === 0 ? (
										<TableRow>
											<TableCell colSpan={4} className="py-6 text-center text-caption text-muted-foreground">
												{t("settings.replyActionsEmpty")}
											</TableCell>
										</TableRow>
									) : (
										rules.map((rule, index) => <RuleRow key={index} rule={rule} index={index} rowCount={rules.length} dropTargetActive={dropTarget === index} editor={editor} startDrag={startDrag} dragOver={dragOver} drop={drop} dragLeave={() => setDropTarget(null)} clearDrag={clearDrag} />)
									)}
								</TableBody>
							</Table>
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<Button type="button" variant="outline" size="sm" disabled={editor.atLimit} onClick={editor.addRule}>
								<Plus data-icon="inline-start" aria-hidden="true" />
								{t("settings.replyActionsAdd")}
							</Button>
							<Button type="button" variant="outline" size="sm" disabled={editor.merging || editor.atLimit} title={t("settings.replyActionsMergeDefaultsHint")} onClick={() => void editor.mergeDefaults()}>
								<ListPlus data-icon="inline-start" aria-hidden="true" />
								{t(editor.merging ? "settings.replyActionsMerging" : "settings.replyActionsMergeDefaults")}
							</Button>
							{editor.atLimit ? <span className="text-caption text-muted-foreground">{t("settings.replyActionsLimit", { max: MAX_REPLY_ACTION_RULES })}</span> : null}
						</div>
					</div>
				)}

				<DialogFooter className="sm:justify-between">
					<div className="flex flex-wrap items-center gap-1">
						<Button type="button" variant="ghost" size="sm" disabled={!editor.defaultsAvailable || editor.merging} title={editor.defaultsAvailable ? t("settings.replyActionsResetHint") : t("settings.replyActionsDefaultsUnavailable")} onClick={() => void editor.resetDefaults()}>
							<RotateCcw data-icon="inline-start" aria-hidden="true" />
							{t("settings.replyActionsReset")}
						</Button>
						<Button type="button" variant="ghost" size="sm" disabled={editor.merging} title={t("settings.replyActionsReloadHint")} onClick={() => void editor.refresh()}>
							<RefreshCw data-icon="inline-start" aria-hidden="true" />
							{t("settings.replyActionsReload")}
						</Button>
						<Button type="button" variant="ghost" size="sm" onClick={() => void editor.openFile()}>
							<FileJson data-icon="inline-start" aria-hidden="true" />
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

/** 何时显示：与下拉选项一一对应的三态 + 命中关键词（第四态，需要 patterns）。 */
type TriggerMode = "onStop" | "onFailure" | "always" | "textMatch";

function RuleRow(props: {
	rule: ReplyActionRule;
	index: number;
	rowCount: number;
	dropTargetActive: boolean;
	editor: ReturnType<typeof useReplyActionEditor>;
	startDrag: (event: DragEvent<HTMLButtonElement>, index: number) => void;
	dragOver: (event: DragEvent<HTMLTableRowElement>, index: number) => void;
	drop: (event: DragEvent<HTMLTableRowElement>, index: number) => void;
	dragLeave: () => void;
	clearDrag: () => void;
}) {
	const { rule, index, rowCount } = props;
	const matchTrigger = rule.triggers.find((trigger) => trigger.kind === "textMatch");
	// 关键词输入是受控的中间态：还没写出第一个关键词前只留在本地（draft 非 null），
	// 不下发空的 textMatch——主进程会按「无 patterns」丢掉这个 trigger，整条规则跟着消失。
	const [patternDraft, setPatternDraft] = useState<string | null>(null);
	const mode: TriggerMode = patternDraft !== null ? "textMatch" : triggerModeOf(rule.triggers);

	/** 换「何时显示」：状态类条件写成单个 trigger（组合语义只留在文件里，不暴露给用户）。 */
	const applyMode = (next: TriggerMode) => {
		if (next === "textMatch") {
			setPatternDraft((matchTrigger?.patterns ?? []).join(", "));
			return;
		}
		setPatternDraft(null);
		props.editor.setRuleTriggers(index, [{ kind: next }]);
	};

	/** 关键词每次输入都下发，但空输入只更新草稿——保留旧 patterns 在文件里，不删规则。 */
	const applyPatterns = (rawValue: string) => {
		setPatternDraft(rawValue);
		const patterns = rawValue
			.split(/[,，]/)
			.map((pattern) => pattern.trim())
			.filter(Boolean);
		if (patterns.length === 0) return;
		props.editor.setRuleTriggers(index, [{ kind: "textMatch", patterns }]);
	};

	return (
		<TableRow onDragOver={(event) => props.dragOver(event, index)} onDragLeave={props.dragLeave} onDrop={(event) => props.drop(event, index)} data-state={props.dropTargetActive ? "selected" : undefined}>
			<TableCell className="w-10 px-2">
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
					className="cursor-grab text-muted-foreground active:cursor-grabbing"
				>
					<GripVertical data-icon="inline-start" aria-hidden="true" />
				</Button>
			</TableCell>
			<TableCell className="max-w-0">
				<Input value={rule.text} placeholder={t("settings.replyActionsPlaceholder")} onChange={(event) => props.editor.setRuleText(index, event.target.value)} />
			</TableCell>
			<TableCell className="max-w-0">
				<div className="flex items-center gap-1">
					<Select value={mode} onValueChange={(value) => applyMode(value as TriggerMode)}>
						<SelectTrigger size="sm" className="min-w-0 flex-1" aria-label={t("settings.replyActionsColumnTrigger")}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="onStop">{t("settings.replyActionsTrigger.onStop")}</SelectItem>
							<SelectItem value="onFailure">{t("settings.replyActionsTrigger.onFailure")}</SelectItem>
							<SelectItem value="always">{t("settings.replyActionsTrigger.always")}</SelectItem>
							<SelectItem value="textMatch">{t("settings.replyActionsTrigger.textMatch")}</SelectItem>
						</SelectContent>
					</Select>
					{mode === "textMatch" ? <Input className="min-w-0 flex-1" value={patternDraft ?? (matchTrigger?.patterns ?? []).join(", ")} placeholder={t("settings.replyActionsTriggerPatterns")} title={t("settings.replyActionsTriggerPatternsHint")} onChange={(event) => applyPatterns(event.target.value)} /> : null}
				</div>
			</TableCell>
			<TableCell className="text-right">
				<div className="flex justify-end gap-0.5">
					<Button type="button" variant="ghost" size="icon-sm" title={t("settings.replyActionsMoveUp")} aria-label={t("settings.replyActionsMoveUp")} disabled={index === 0} onClick={() => props.editor.moveRule(index, -1)}>
						<ArrowUp data-icon="inline-start" aria-hidden="true" />
					</Button>
					<Button type="button" variant="ghost" size="icon-sm" title={t("settings.replyActionsMoveDown")} aria-label={t("settings.replyActionsMoveDown")} disabled={index === rowCount - 1} onClick={() => props.editor.moveRule(index, 1)}>
						<ArrowDown data-icon="inline-start" aria-hidden="true" />
					</Button>
					<Button type="button" variant="ghost" size="icon-sm" title={t("settings.replyActionsRemove")} aria-label={t("settings.replyActionsRemove")} onClick={() => props.editor.removeRule(index)}>
						<Trash2 data-icon="inline-start" aria-hidden="true" />
					</Button>
				</div>
			</TableCell>
		</TableRow>
	);
}

/**
 * 规则里的 triggers → 下拉当前值。文件允许组合多个 trigger（手写文件的用户），
 * 界面按「最具体的」展示：有关键词看关键词，否则看成功/失败，都没有才算 always。
 */
function triggerModeOf(triggers: ReplyActionTrigger[]): TriggerMode {
	if (triggers.some((trigger) => trigger.kind === "textMatch")) return "textMatch";
	if (triggers.some((trigger) => trigger.kind === "onStop")) return "onStop";
	if (triggers.some((trigger) => trigger.kind === "onFailure")) return "onFailure";
	return "always";
}
