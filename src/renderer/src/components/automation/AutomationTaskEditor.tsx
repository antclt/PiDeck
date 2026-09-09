import { useState, useEffect } from "react";
import { useAtomValue } from "jotai";
import { Clock, Info, Check, Sparkles } from "lucide-react";
import { projectInventoryAtom } from "../../atoms/project-atoms";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Textarea } from "../ui-shadcn/textarea";
import { Label } from "../ui-shadcn/label";
import { Switch } from "../ui-shadcn/switch";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui-shadcn/select";
import type {
	AutomationTask,
	CreateAutomationTaskInput,
	UpdateAutomationTaskInput,
} from "../../../../shared/types";

interface AutomationTaskEditorProps {
	task?: AutomationTask | null;
	onSave: () => void;
	onCancel: () => void;
}

const CRON_PRESETS = [
	{ label: "automation.cronPreset.daily9am", expr: "0 9 * * 1-5" },
	{ label: "automation.cronPreset.hourly", expr: "0 * * * *" },
	{ label: "automation.cronPreset.every30m", expr: "*/30 * * * *" },
	{ label: "automation.cronPreset.midnight", expr: "0 0 * * *" },
] as const;

/**
 * 格式化时间戳为易读本地时间
 */
function formatPreviewTime(timestamp: number): string {
	const d = new Date(timestamp);
	return d.toLocaleString(undefined, {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		weekday: "short",
	});
}

/**
 * 定时任务新建与编辑表单组件。
 */
export function AutomationTaskEditor({
	task,
	onSave,
	onCancel,
}: AutomationTaskEditorProps) {
	const projects = useAtomValue(projectInventoryAtom);

	// 表单状态
	const [name, setName] = useState(task?.name ?? "");
	const [projectId, setProjectId] = useState(
		task?.projectId ?? (projects[0]?.id || ""),
	);
	const [cronExpression, setCronExpression] = useState(
		task?.schedule.type === "cron" ? task.schedule.expression : "0 9 * * 1-5",
	);
	const [prompt, setPrompt] = useState(task?.prompt ?? "");
	const [modelInput, setModelInput] = useState(
		task?.model ? `${task.model.provider}/${task.model.modelId}` : "",
	);
	const [thinkingLevel, setThinkingLevel] = useState(
		task?.thinkingLevel ?? "",
	);
	const [enabled, setEnabled] = useState(task?.enabled ?? true);

	// 预算设置（UI 以分钟展示超时）
	const initialTimeoutMinutes =
		task?.budget?.timeoutMs != null
			? String(Math.round(task.budget.timeoutMs / 60000))
			: "";
	const [timeoutMinutes, setTimeoutMinutes] = useState<string>(
		initialTimeoutMinutes,
	);
	const [maxTokens, setMaxTokens] = useState<string>(
		task?.budget?.maxTokens ? String(task.budget.maxTokens) : "",
	);
	const [maxCostUsd, setMaxCostUsd] = useState<string>(
		task?.budget?.maxCostUsd ? String(task.budget.maxCostUsd) : "",
	);
	const [maxSteps, setMaxSteps] = useState<string>(
		task?.budget?.maxSteps ? String(task.budget.maxSteps) : "",
	);

	// Cron 预览状态（时间戳数组）
	const [cronPreviews, setCronPreviews] = useState<number[]>([]);
	const [cronError, setCronError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	// 实时计算 Cron 预览
	useEffect(() => {
		let isCancelled = false;
		const trimmed = cronExpression.trim();
		if (!trimmed) {
			setCronPreviews([]);
			setCronError(null);
			return;
		}

		desktopApi.automation
			.previewCron(trimmed, 3)
			.then((res) => {
				if (isCancelled) return;
				if (res.valid) {
					setCronPreviews(res.nextRuns);
					setCronError(null);
				} else {
					setCronPreviews([]);
					setCronError(res.error || t("automation.cronInvalid"));
				}
			})
			.catch(() => {
				if (isCancelled) return;
				setCronPreviews([]);
				setCronError(t("automation.cronInvalid"));
			});

		return () => {
			isCancelled = true;
		};
	}, [cronExpression]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim()) {
			showNotice(t("automation.namePlaceholder"), 2000);
			return;
		}
		if (!projectId) {
			showNotice(t("automation.projectSelect"), 2000);
			return;
		}
		if (!prompt.trim()) {
			showNotice(t("automation.promptPlaceholder"), 2000);
			return;
		}
		if (cronError || cronPreviews.length === 0) {
			showNotice(t("automation.cronInvalid"), 2000);
			return;
		}

		setIsSubmitting(true);
		try {
			const timeoutMinNum = timeoutMinutes.trim() ? Number(timeoutMinutes) : undefined;
			const budget = {
				timeoutMs: timeoutMinNum ? timeoutMinNum * 60000 : 30 * 60000,
				maxTokens: maxTokens.trim() ? Number(maxTokens) : undefined,
				maxCostUsd: maxCostUsd.trim() ? Number(maxCostUsd) : undefined,
				maxSteps: maxSteps.trim() ? Number(maxSteps) : undefined,
			};

			let parsedModel: { provider: string; modelId: string } | undefined;
			if (modelInput.trim()) {
				const parts = modelInput.trim().split("/");
				if (parts.length >= 2) {
					parsedModel = {
						provider: parts[0],
						modelId: parts.slice(1).join("/"),
					};
				} else {
					parsedModel = {
						provider: "openai",
						modelId: modelInput.trim(),
					};
				}
			}

			if (task) {
				const patch: UpdateAutomationTaskInput = {
					name: name.trim(),
					projectId,
					schedule: {
						type: "cron",
						expression: cronExpression.trim(),
					},
					prompt: prompt.trim(),
					model: parsedModel,
					thinkingLevel: thinkingLevel.trim() || undefined,
					enabled,
					budget,
				};
				await desktopApi.automation.updateTask(task.id, patch);
			} else {
				const input: CreateAutomationTaskInput = {
					name: name.trim(),
					projectId,
					schedule: {
						type: "cron",
						expression: cronExpression.trim(),
					},
					prompt: prompt.trim(),
					model: parsedModel,
					thinkingLevel: thinkingLevel.trim() || undefined,
					enabled,
					budget,
				};
				await desktopApi.automation.createTask(input);
			}

			showNotice(t("automation.taskSaved"), 2000);
			onSave();
		} catch (error) {
			showNotice(
				error instanceof Error ? error.message : String(error),
				3500,
			);
		} finally {
			setIsSubmitting(false);
		}
	};

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4 py-1">
			<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
				{/* 任务名称 */}
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="task-name" className="text-xs font-medium">
						{t("automation.name")} <span className="text-destructive">*</span>
					</Label>
					<Input
						id="task-name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder={t("automation.namePlaceholder")}
						className="h-8 text-xs"
						required
					/>
				</div>

				{/* 关联项目 */}
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="task-project" className="text-xs font-medium">
						{t("automation.project")} <span className="text-destructive">*</span>
					</Label>
					<Select value={projectId} onValueChange={setProjectId}>
						<SelectTrigger id="task-project" className="h-8 text-xs">
							<SelectValue placeholder={t("automation.projectSelect")} />
						</SelectTrigger>
						<SelectContent>
							{projects.map((p) => (
								<SelectItem key={p.id} value={p.id} className="text-xs">
									{p.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			{/* Cron 表达式与预设 */}
			<div className="flex flex-col gap-1.5 rounded-lg border border-border/50 bg-bg-panel/40 p-3">
				<div className="flex items-center justify-between">
					<Label htmlFor="cron-expr" className="text-xs font-medium flex items-center gap-1.5">
						<Clock className="size-3.5 text-sky-500" />
						{t("automation.cronExpression")} <span className="text-destructive">*</span>
					</Label>
					<div className="flex items-center gap-1">
						{CRON_PRESETS.map((preset) => (
							<Button
								key={preset.expr}
								type="button"
								variant="ghost"
								size="sm"
								className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
								onClick={() => setCronExpression(preset.expr)}
							>
								{t(preset.label as any)}
							</Button>
						))}
					</div>
				</div>

				<Input
					id="cron-expr"
					value={cronExpression}
					onChange={(e) => setCronExpression(e.target.value)}
					placeholder="0 9 * * 1-5"
					className="h-8 text-xs font-mono"
					required
				/>

				<div className="flex items-center justify-between text-[11px] text-muted-foreground">
					<span>{t("automation.cronHelp")}</span>
					{cronError ? (
						<span className="text-destructive">{cronError}</span>
					) : (
						cronPreviews.length > 0 && (
							<span className="flex items-center gap-1 text-emerald-500">
								<Check className="size-3" />
								{t("automation.cronPreview")}:{" "}
								{cronPreviews.map(formatPreviewTime).join(" ➔ ")}
							</span>
						)
					)}
				</div>
			</div>

			{/* Prompt 提示词 */}
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="task-prompt" className="text-xs font-medium">
					{t("automation.prompt")} <span className="text-destructive">*</span>
				</Label>
				<Textarea
					id="task-prompt"
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					placeholder={t("automation.promptPlaceholder")}
					rows={4}
					className="text-xs font-mono"
					required
				/>
			</div>

			{/* 模型与思考档位 */}
			<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="task-model" className="text-xs font-medium">
						{t("automation.model")}
					</Label>
					<Input
						id="task-model"
						value={modelInput}
						onChange={(e) => setModelInput(e.target.value)}
						placeholder="provider/model-id"
						className="h-8 text-xs font-mono"
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor="task-thinking" className="text-xs font-medium">
						{t("automation.thinkingLevel")}
					</Label>
					<Input
						id="task-thinking"
						value={thinkingLevel}
						onChange={(e) => setThinkingLevel(e.target.value)}
						placeholder="e.g. low / medium / high"
						className="h-8 text-xs font-mono"
					/>
				</div>
			</div>

			{/* 预算与超限保护 */}
			<div className="flex flex-col gap-2 rounded-lg border border-border/50 bg-bg-panel/40 p-3">
				<Label className="text-xs font-medium flex items-center gap-1.5">
					<Sparkles className="size-3.5 text-amber-500" />
					{t("automation.budgets")}
				</Label>
				<div className="grid grid-cols-2 md:grid-cols-4 gap-3">
					<div className="flex flex-col gap-1">
						<span className="text-[11px] text-muted-foreground">{t("automation.timeoutMinutes")}</span>
						<Input
							type="number"
							min="1"
							value={timeoutMinutes}
							onChange={(e) => setTimeoutMinutes(e.target.value)}
							placeholder="30"
							className="h-7 text-xs font-mono"
						/>
					</div>
					<div className="flex flex-col gap-1">
						<span className="text-[11px] text-muted-foreground">{t("automation.maxTokens")}</span>
						<Input
							type="number"
							min="1000"
							value={maxTokens}
							onChange={(e) => setMaxTokens(e.target.value)}
							placeholder="e.g. 500000"
							className="h-7 text-xs font-mono"
						/>
					</div>
					<div className="flex flex-col gap-1">
						<span className="text-[11px] text-muted-foreground">{t("automation.maxCostUsd")}</span>
						<Input
							type="number"
							step="0.01"
							min="0.01"
							value={maxCostUsd}
							onChange={(e) => setMaxCostUsd(e.target.value)}
							placeholder="e.g. 1.00"
							className="h-7 text-xs font-mono"
						/>
					</div>
					<div className="flex flex-col gap-1">
						<span className="text-[11px] text-muted-foreground">{t("automation.maxSteps")}</span>
						<Input
							type="number"
							min="1"
							value={maxSteps}
							onChange={(e) => setMaxSteps(e.target.value)}
							placeholder="e.g. 50"
							className="h-7 text-xs font-mono"
						/>
					</div>
				</div>
			</div>

			{/* 启用开关与保存/取消 */}
			<div className="flex items-center justify-between pt-2 border-t border-border/40">
				<div className="flex items-center gap-2">
					<Switch
						id="task-enabled"
						checked={enabled}
						onCheckedChange={setEnabled}
					/>
					<Label htmlFor="task-enabled" className="text-xs cursor-pointer">
						{enabled ? t("automation.enabled") : t("automation.disabled")}
					</Label>
				</div>

				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-8 text-xs"
						onClick={onCancel}
						disabled={isSubmitting}
					>
						{t("automation.cancel")}
					</Button>
					<Button
						type="submit"
						size="sm"
						className="h-8 text-xs"
						disabled={isSubmitting || !!cronError}
					>
						{t("automation.saveTask")}
					</Button>
				</div>
			</div>
		</form>
	);
}
