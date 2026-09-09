import { useState, useCallback } from "react";
import { useAtom, useAtomValue } from "jotai";
import {
	Clock,
	ListFilter,
	History,
	Sliders,
	Plus,
	PlayCircle,
} from "lucide-react";
import {
	automationModalOpenAtom,
	automationActiveRunsAtom,
} from "../../atoms/automation-atoms";
import { t } from "../../i18n";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "../ui-shadcn/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui-shadcn/tabs";
import { Button } from "../ui-shadcn/button";
import { Badge } from "../ui-shadcn/badge";
import { AutomationTaskList } from "./AutomationTaskList";
import { AutomationTaskEditor } from "./AutomationTaskEditor";
import { AutomationHistoryList } from "./AutomationHistoryList";
import { AutomationSettingsTab } from "./AutomationSettingsTab";
import type { AutomationTask } from "../../../../shared/types";

interface AutomationModalProps {
	/** 点击查看执行会话时的跳转回调（切到目标项目、打开并常驻会话 Tab） */
	onViewSession?: (projectId: string, sessionId: string) => void;
}

/**
 * 定时任务与自动化管理中心全功能弹窗。
 */
export function AutomationModal({ onViewSession }: AutomationModalProps) {
	const [open, setOpen] = useAtom(automationModalOpenAtom);
	const activeRuns = useAtomValue(automationActiveRunsAtom);

	// 当前激活的选项卡
	const [activeTab, setActiveTab] = useState<
		"tasks" | "editor" | "history" | "settings"
	>("tasks");

	// 正在编辑的任务（null 表示新建或非编辑态）
	const [editingTask, setEditingTask] = useState<AutomationTask | null>(null);

	const handleOpenCreate = useCallback(() => {
		setEditingTask(null);
		setActiveTab("editor");
	}, []);

	const handleOpenEdit = useCallback((task: AutomationTask) => {
		setEditingTask(task);
		setActiveTab("editor");
	}, []);

	const handleEditorSave = useCallback(() => {
		setEditingTask(null);
		setActiveTab("tasks");
	}, []);

	const handleEditorCancel = useCallback(() => {
		setEditingTask(null);
		setActiveTab("tasks");
	}, []);

	const handleViewSession = useCallback(
		(projectId: string, sessionId: string) => {
			setOpen(false);
			onViewSession?.(projectId, sessionId);
		},
		[onViewSession, setOpen],
	);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				size="xl"
				stagger
				className="flex flex-col h-[min(720px,calc(100vh-64px))] max-w-[min(960px,calc(100vw-48px))] p-6 gap-3 overflow-hidden bg-background"
			>
				<DialogHeader className="flex flex-row items-center justify-between pb-2 border-b border-border/40 space-y-0">
					<div className="flex flex-col gap-1">
						<div className="flex items-center gap-2">
							<Clock className="size-5 text-[var(--color-accent)]" />
							<DialogTitle className="text-base font-semibold text-foreground">
								{t("automation.title")}
							</DialogTitle>
							{activeRuns.length > 0 && (
								<Badge className="h-5 bg-sky-500/15 text-sky-500 border-sky-500/30 px-1.5 text-[11px] font-normal animate-pulse gap-1">
									<PlayCircle className="size-3" />
									{t("automation.running")} ({activeRuns.length})
								</Badge>
							)}
						</div>
						<DialogDescription className="text-xs text-muted-foreground">
							{t("automation.subtitle")}
						</DialogDescription>
					</div>

					{activeTab === "tasks" && (
						<Button
							size="sm"
							onClick={handleOpenCreate}
							className="h-8 gap-1.5 text-xs mr-6"
						>
							<Plus className="size-3.5" />
							{t("automation.createTask")}
						</Button>
					)}
				</DialogHeader>

				<Tabs
					value={activeTab}
					onValueChange={(val) => setActiveTab(val as typeof activeTab)}
					className="flex flex-1 flex-col min-h-0 gap-3"
				>
					<TabsList className="w-auto self-start bg-bg-muted/70 p-0.5">
						<TabsTrigger
							value="tasks"
							className="text-xs h-7 px-3 gap-1.5 data-[state=active]:bg-background"
						>
							<ListFilter className="size-3.5" />
							{t("automation.tasksTab")}
						</TabsTrigger>
						<TabsTrigger
							value="history"
							className="text-xs h-7 px-3 gap-1.5 data-[state=active]:bg-background"
						>
							<History className="size-3.5" />
							{t("automation.historyTab")}
						</TabsTrigger>
						<TabsTrigger
							value="settings"
							className="text-xs h-7 px-3 gap-1.5 data-[state=active]:bg-background"
						>
							<Sliders className="size-3.5" />
							{t("automation.settingsTab")}
						</TabsTrigger>
						{activeTab === "editor" && (
							<TabsTrigger
								value="editor"
								className="text-xs h-7 px-3 gap-1.5 data-[state=active]:bg-background"
							>
								{editingTask
									? t("automation.editTask")
									: t("automation.createTask")}
							</TabsTrigger>
						)}
					</TabsList>

					<div className="flex-1 min-h-0 overflow-y-auto pr-1">
						<TabsContent value="tasks" className="m-0 focus-visible:outline-none">
							<AutomationTaskList
								onEditTask={handleOpenEdit}
								onCreateTask={handleOpenCreate}
							/>
						</TabsContent>

						<TabsContent
							value="editor"
							className="m-0 focus-visible:outline-none"
						>
							<AutomationTaskEditor
								task={editingTask}
								onSave={handleEditorSave}
								onCancel={handleEditorCancel}
							/>
						</TabsContent>

						<TabsContent
							value="history"
							className="m-0 focus-visible:outline-none"
						>
							<AutomationHistoryList onViewSession={handleViewSession} />
						</TabsContent>

						<TabsContent
							value="settings"
							className="m-0 focus-visible:outline-none"
						>
							<AutomationSettingsTab />
						</TabsContent>
					</div>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}
