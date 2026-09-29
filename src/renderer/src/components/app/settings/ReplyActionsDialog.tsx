import { ArrowDown, ArrowUp, FileJson, GripVertical, ListPlus, Plus, RefreshCw, RotateCcw, Trash2, X, Type } from "lucide-react";
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { MAX_REPLY_ACTION_RULES } from "../../../../../shared/replyActions";
import type { ReplyActionRule, ReplyActionTrigger } from "../../../../../shared/types/replyActions";
import { useReplyActionEditor } from "../../../hooks/useReplyActionEditor";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Checkbox } from "../../ui-shadcn/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { Input } from "../../ui-shadcn/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../ui-shadcn/table";

/**
 * 回复快捷操作规则管理器。
 *
 * 这是配置表，不是普通的标签列表：列标题明确说明按钮文案、触发场景和关键词。
 * 触发条件使用可读的勾选项；textMatch 的 patterns 单独放在「关键词」列，
 * 不再用无文字的闪电下拉或把正则裸露在胶囊里。
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
									<col className="w-[24%]" />
									<col className="w-28" />
									<col className="w-28" />
									<col className="w-[36%]" />
									<col className="w-28" />
								</colgroup>
								<TableHeader>
									<TableRow className="bg-bg-muted hover:bg-bg-muted">
										<TableHead className="w-10 px-2" aria-label={t("settings.replyActionsColumnOrder")}>
											{t("settings.replyActionsColumnOrder")}
										</TableHead>
										<TableHead>{t("settings.replyActionsColumnText")}</TableHead>
										<TableHead className="text-center">{t("settings.replyActionsColumnOnStop")}</TableHead>
										<TableHead className="text-center">{t("settings.replyActionsColumnOnFailure")}</TableHead>
										<TableHead>{t("settings.replyActionsColumnPatterns")}</TableHead>
										<TableHead className="text-right">{t("settings.replyActionsColumnOperations")}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{rules.length === 0 ? (
										<TableRow>
											<TableCell colSpan={6} className="py-6 text-center text-caption text-muted-foreground">
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
	const stopTrigger = rule.triggers.some((trigger) => trigger.kind === "onStop");
	const failureTrigger = rule.triggers.some((trigger) => trigger.kind === "onFailure");
	const matchTrigger = rule.triggers.find((trigger) => trigger.kind === "textMatch");

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
			<TableCell className="text-center">
				<TriggerCheckbox checked={stopTrigger} label={t("settings.replyActionsTrigger.onStop")} onCheckedChange={(checked) => props.editor.setRuleTriggers(index, updateTrigger(rule.triggers, "onStop", checked))} />
			</TableCell>
			<TableCell className="text-center">
				<TriggerCheckbox checked={failureTrigger} label={t("settings.replyActionsTrigger.onFailure")} onCheckedChange={(checked) => props.editor.setRuleTriggers(index, updateTrigger(rule.triggers, "onFailure", checked))} />
			</TableCell>
			<TableCell className="max-w-0">
				{matchTrigger ? (
					<div className="flex min-w-0 items-center gap-1">
						<Input value={(matchTrigger.patterns ?? []).join(", ")} placeholder={t("settings.replyActionsTriggerPatterns")} title={t("settings.replyActionsTriggerPatternsHint")} onChange={(event) => props.editor.setRuleTriggers(index, updatePatterns(rule.triggers, event.target.value))} />
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							title={t("settings.replyActionsTriggerRemove")}
							aria-label={t("settings.replyActionsTriggerRemove")}
							onClick={() =>
								props.editor.setRuleTriggers(
									index,
									rule.triggers.filter((trigger) => trigger.kind !== "textMatch"),
								)
							}
						>
							<X data-icon="inline-start" aria-hidden="true" />
						</Button>
					</div>
				) : (
					<Button type="button" variant="ghost" size="sm" onClick={() => props.editor.setRuleTriggers(index, [...rule.triggers, { kind: "textMatch", patterns: [] }])}>
						<Type data-icon="inline-start" aria-hidden="true" />
						{t("settings.replyActionsTriggerAdd")}
					</Button>
				)}
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

function TriggerCheckbox(props: { checked: boolean; label: string; onCheckedChange: (checked: boolean) => void }) {
	return (
		<label className="inline-flex cursor-pointer items-center justify-center text-caption text-muted-foreground" title={props.label}>
			<Checkbox checked={props.checked} onCheckedChange={(checked) => props.onCheckedChange(checked === true)} aria-label={props.label} />
		</label>
	);
}

function updateTrigger(triggers: ReplyActionTrigger[], kind: "onStop" | "onFailure", checked: boolean): ReplyActionTrigger[] {
	if (checked) return triggers.some((trigger) => trigger.kind === kind) ? triggers : [...triggers, { kind }];
	return triggers.filter((trigger) => trigger.kind !== kind);
}

function updatePatterns(triggers: ReplyActionTrigger[], rawValue: string): ReplyActionTrigger[] {
	const patterns = rawValue
		.split(/[,，]/)
		.map((pattern) => pattern.trim())
		.filter(Boolean);
	return triggers.map((trigger) => (trigger.kind === "textMatch" ? { ...trigger, patterns } : trigger));
}
