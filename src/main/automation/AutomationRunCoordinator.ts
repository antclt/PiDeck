import { randomUUID } from "node:crypto";
import type {
	AutomationRun,
	AutomationRunStatus,
	AutomationTask,
	SessionRuntimeEvent,
	SessionRuntimeTarget,
} from "../../shared/types";
import { isAutomationRunTerminal } from "../../shared/types";
import type { GitService } from "../git/GitService";
import type { AppLogger } from "../logging/AppLogger";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import { compareQueuedAutomationRuns, hasActiveAutomationRun } from "./automationPolicy";
import type { AutomationStore } from "./AutomationStore";

const RUNTIME_METRIC_THROTTLE_MS = 1_000;

type ActiveRunTracker = {
	runId: string;
	taskId: string;
	projectId: string;
	timeoutMs: number;
	maxTokens?: number;
	maxCostUsd?: number;
	maxSteps?: number;
	target?: SessionRuntimeTarget;
	timeoutHandle?: NodeJS.Timeout;
	stepCount: number;
	wasExecutingTool: boolean;
	lastMetricUpdate: number;
	dispatched: boolean;
	completed: boolean;
};

export type AutomationRunCoordinatorDeps = {
	store: AutomationStore;
	catalog: SessionCatalog;
	sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	projectStore: ProjectStore;
	gitService?: GitService;
	logger?: AppLogger;
	notifyRunFinished?: (run: AutomationRun, task: AutomationTask) => void;
};

/**
 * Manages automation queue execution, creates fresh draft sessions in SessionCatalog,
 * dispatches prompts through SessionRuntimeCoordinator, enforces budgets, and audits runs.
 */
export class AutomationRunCoordinator {
	private readonly store: AutomationStore;
	private readonly catalog: SessionCatalog;
	private readonly sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	private readonly projectStore: ProjectStore;
	private readonly gitService?: GitService;
	private readonly logger?: AppLogger;
	private readonly notifyRunFinished?: (run: AutomationRun, task: AutomationTask) => void;

	private activeTrackers = new Map<string, ActiveRunTracker>();
	private draining = false;

	constructor(deps: AutomationRunCoordinatorDeps) {
		this.store = deps.store;
		this.catalog = deps.catalog;
		this.sessionRuntimeCoordinator = deps.sessionRuntimeCoordinator;
		this.projectStore = deps.projectStore;
		this.gitService = deps.gitService;
		this.logger = deps.logger;
		this.notifyRunFinished = deps.notifyRunFinished;
	}

	async enqueueRun(
		task: AutomationTask,
		scheduledFor?: number,
		trigger: AutomationRun["trigger"] = "schedule",
		now = Date.now(),
	): Promise<AutomationRun> {
		const runs = this.store.listRuns();
		if (hasActiveAutomationRun(runs, task.id)) {
			return this.store.createRun({
				task,
				trigger,
				scheduledFor,
				status: "skipped",
				skippedReason: "task-already-running",
				error: "Task already has an active run",
			}, now);
		}

		const run = await this.store.createRun({
			task,
			trigger,
			scheduledFor,
			status: "queued",
		}, now);

		void this.drainQueue();
		return run;
	}

	async runNow(taskId: string, now = Date.now()): Promise<AutomationRun> {
		const task = this.store.getTask(taskId);
		if (!task) throw new Error("Automation task not found");
		return this.enqueueRun(task, undefined, "manual", now);
	}

	async abortRun(runId: string, reason = "Manual abort"): Promise<boolean> {
		const run = this.store.getRun(runId);
		if (!run || isAutomationRunTerminal(run.status)) return false;

		const tracker = this.activeTrackers.get(runId);
		if (tracker?.timeoutHandle) clearTimeout(tracker.timeoutHandle);

		if (tracker?.target) {
			try {
				await this.sessionRuntimeCoordinator.abortRuntime(tracker.target);
			} catch (err) {
				void this.logger?.warn("automation", "Failed to abort runtime target", {
					runId,
					target: tracker.target,
					error: String(err),
				});
			}
		}

		await this.finalizeRun(runId, "aborted", reason, { at: Date.now() });
		return true;
	}

	observeRuntimeEvent(event: SessionRuntimeEvent): void {
		if (this.activeTrackers.size === 0) return;

		for (const [runId, tracker] of this.activeTrackers.entries()) {
			if (tracker.target && tracker.target.sessionId === event.sessionId) {
				this.handleTrackerEvent(runId, tracker, event);
				break;
			}
		}
	}

	async drainQueue(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			const snapshot = this.store.getSnapshot();
			const maxConcurrent = snapshot.settings.maxConcurrentRuns;
			const runningCount = Array.from(this.activeTrackers.values()).length;
			const availableSlots = Math.max(0, maxConcurrent - runningCount);
			if (availableSlots <= 0) return;

			const queuedRuns = snapshot.runs
				.filter((r) => r.status === "queued")
				.sort(compareQueuedAutomationRuns);

			for (const run of queuedRuns) {
				if (this.activeTrackers.size >= maxConcurrent) break;
				// Single-flight check: ensure no other run for this task is running
				const isTaskRunning = Array.from(this.activeTrackers.values()).some((t) => t.taskId === run.taskId);
				if (isTaskRunning) continue;

				const task = this.store.getTask(run.taskId);
				if (!task) {
					await this.finalizeRun(run.id, "failed", "Task definition was deleted", { at: Date.now() });
					continue;
				}

				if (!task.enabled && run.trigger !== "manual") {
					await this.finalizeRun(run.id, "skipped", "Task is disabled", {
						at: Date.now(),
						skippedReason: "task-disabled",
					});
					continue;
				}

				void this.executeRun(run, task);
			}
		} finally {
			this.draining = false;
		}
	}

	dispose(): void {
		for (const tracker of this.activeTrackers.values()) {
			if (tracker.timeoutHandle) clearTimeout(tracker.timeoutHandle);
		}
		this.activeTrackers.clear();
	}

	private async executeRun(run: AutomationRun, task: AutomationTask): Promise<void> {
		const runId = run.id;
		const now = Date.now();
		const tracker: ActiveRunTracker = {
			runId,
			taskId: task.id,
			projectId: task.projectId,
			timeoutMs: task.budget.timeoutMs,
			maxTokens: task.budget.maxTokens,
			maxCostUsd: task.budget.maxCostUsd,
			maxSteps: task.budget.maxSteps,
			stepCount: 0,
			wasExecutingTool: false,
			lastMetricUpdate: now,
			dispatched: false,
			completed: false,
		};
		this.activeTrackers.set(runId, tracker);

		await this.store.updateRun(runId, {
			status: "starting",
			startedAt: now,
			updatedAt: now,
		}, { type: "starting", at: now });

		const project = this.projectStore.get(task.projectId);
		if (!project) {
			await this.finalizeRun(runId, "failed", "Project not found", { at: Date.now() });
			return;
		}

		const dateLabel = new Date(now).toLocaleString("zh-CN", { hour12: false });
		const title = `[定时] ${task.name} (${dateLabel})`;
		const environment = project.environment === "wsl" ? "wsl" : "native";

		let sessionDraft: import("../../shared/types").SessionRecord;
		try {
			sessionDraft = await this.catalog.createDraft({
				projectId: project.id,
				title,
				environment,
				source: "pi",
				backend: task.backend ?? "pi",
				model: task.model,
				thinkingLevel: task.thinkingLevel,
				permissionPreset: task.permissionPreset,
			});
		} catch (err) {
			await this.finalizeRun(runId, "failed", `Failed to create session: ${err instanceof Error ? err.message : String(err)}`, { at: Date.now() });
			return;
		}

		const sessionId = sessionDraft.id;
		await this.store.updateRun(runId, {
			sessionId,
			updatedAt: Date.now(),
		}, { type: "session-created", message: `Session ${sessionId} created`, at: Date.now() });

		// Setup timeout watch
		tracker.timeoutHandle = setTimeout(() => {
			void this.handleTimeout(runId);
		}, tracker.timeoutMs);
		if (typeof tracker.timeoutHandle.unref === "function") {
			tracker.timeoutHandle.unref();
		}

		const requestId = randomUUID();
		try {
			const result = await this.sessionRuntimeCoordinator.send({
				sessionId,
				requestId,
				message: task.prompt,
				description: `Automation: ${task.name}`,
				agentMessage: `[Automation: ${task.name}] Please complete this task autonomously without waiting for follow-up inputs.`,
			});

			if (!result.accepted) {
				await this.finalizeRun(runId, "failed", result.error || "Prompt dispatch rejected", { at: Date.now() });
				return;
			}

			if (result.agentId && result.runtimeGeneration !== undefined) {
				tracker.target = {
					sessionId,
					agentId: result.agentId,
					runtimeGeneration: result.runtimeGeneration,
				};
				tracker.dispatched = true;
				await this.store.updateRun(runId, {
					status: "running",
					agentId: result.agentId,
					runtimeGeneration: result.runtimeGeneration,
					updatedAt: Date.now(),
				}, { type: "prompt-accepted", at: Date.now() });
			} else {
				// Query target if omitted from result
				const target = this.sessionRuntimeCoordinator.getTarget(sessionId);
				if (target) {
					tracker.target = target;
				}
				tracker.dispatched = true;
				if (target) {
					await this.store.updateRun(runId, {
						status: "running",
						agentId: target.agentId,
						runtimeGeneration: target.runtimeGeneration,
						updatedAt: Date.now(),
					}, { type: "prompt-accepted", at: Date.now() });
				}
			}
		} catch (err) {
			await this.finalizeRun(runId, "failed", err instanceof Error ? err.message : String(err), { at: Date.now() });
		}
	}

	private handleTrackerEvent(runId: string, tracker: ActiveRunTracker, event: SessionRuntimeEvent): void {
		if (tracker.completed) return;
		const now = Date.now();
		// Debug logging to diagnose test flow
		// console.log("handleTrackerEvent called:", event.sourceChannel, event.payload);

		// Handle agent runtime state (tokens, cost, turn active, tool step)
		if (typeof event.sourceChannel === "string" && event.sourceChannel.includes("runtime-state") && isRecord(event.payload)) {
			const state = event.payload.state as Record<string, unknown> | undefined;
			if (state && isRecord(state)) {
				const isTurnActive = state.isTurnActive === true;
				const isExecutingTool = state.isExecutingTool === true;
				const inputTokens = typeof state.inputTokens === "number" ? state.inputTokens : 0;
				const outputTokens = typeof state.outputTokens === "number" ? state.outputTokens : 0;
				const costUsd = typeof state.cost === "number" ? state.cost : 0;

				// Track tool step count on false -> true edge
				if (!tracker.wasExecutingTool && isExecutingTool) {
					tracker.stepCount += 1;
				}
				tracker.wasExecutingTool = isExecutingTool;

				// Budget verification
				if (tracker.maxTokens && (inputTokens + outputTokens) >= tracker.maxTokens) {
					void this.handleBudgetExhausted(runId, "tokens", `Exceeded token budget (${inputTokens + outputTokens} >= ${tracker.maxTokens})`);
					return;
				}
				if (tracker.maxCostUsd && costUsd >= tracker.maxCostUsd) {
					void this.handleBudgetExhausted(runId, "cost", `Exceeded cost budget ($${costUsd} >= $${tracker.maxCostUsd})`);
					return;
				}
				if (tracker.maxSteps && tracker.stepCount >= tracker.maxSteps) {
					void this.handleBudgetExhausted(runId, "steps", `Exceeded tool step budget (${tracker.stepCount} >= ${tracker.maxSteps})`);
					return;
				}

				// Throttled metric updates to store
				if (now - tracker.lastMetricUpdate >= RUNTIME_METRIC_THROTTLE_MS) {
					tracker.lastMetricUpdate = now;
					void this.store.updateRun(runId, {
						inputTokens,
						outputTokens,
						costUsd,
						stepCount: tracker.stepCount,
						updatedAt: now,
					});
				}

				// Turn ended: if dispatched and turn is now inactive, consider run succeeded
				if (tracker.dispatched && !isTurnActive && !isExecutingTool) {
					void this.finalizeRun(runId, "succeeded", undefined, {
						at: now,
						inputTokens,
						outputTokens,
						costUsd,
						stepCount: tracker.stepCount,
					});
					return;
				}
			}
		}

		// Handle error states
		if (typeof event.sourceChannel === "string" && event.sourceChannel.includes("state") && isRecord(event.payload)) {
			const status = event.payload.status;
			if (status === "error") {
				const errorMsg = typeof event.payload.error === "string" ? event.payload.error : "Runtime error";
				void this.finalizeRun(runId, "failed", errorMsg, { at: now });
			}
		}
	}

	private async handleTimeout(runId: string): Promise<void> {
		const tracker = this.activeTrackers.get(runId);
		if (!tracker || tracker.completed) return;
		if (tracker.target) {
			try {
				await this.sessionRuntimeCoordinator.abortRuntime(tracker.target);
			} catch {
				// Ignore abort errors on timeout
			}
		}
		await this.finalizeRun(runId, "timed-out", `Execution timed out after ${tracker.timeoutMs}ms`, { at: Date.now() });
	}

	private async handleBudgetExhausted(runId: string, reason: "tokens" | "cost" | "steps", message: string): Promise<void> {
		const tracker = this.activeTrackers.get(runId);
		if (!tracker || tracker.completed) return;
		if (tracker.target) {
			try {
				await this.sessionRuntimeCoordinator.abortRuntime(tracker.target);
			} catch {
				// Ignore abort errors
			}
		}
		await this.finalizeRun(runId, "budget-exhausted", message, {
			at: Date.now(),
			budgetReason: reason,
		});
	}

	private async finalizeRun(
		runId: string,
		status: AutomationRunStatus,
		error?: string,
		extra?: {
			at?: number;
			budgetReason?: "tokens" | "cost" | "steps";
			skippedReason?: "task-already-running" | "task-disabled";
			inputTokens?: number;
			outputTokens?: number;
			costUsd?: number;
			stepCount?: number;
		},
	): Promise<void> {
		const tracker = this.activeTrackers.get(runId);
		if (tracker) {
			tracker.completed = true;
			if (tracker.timeoutHandle) clearTimeout(tracker.timeoutHandle);
			this.activeTrackers.delete(runId);
		}

		const run = this.store.getRun(runId);
		const endedAt = extra?.at ?? Date.now();
		const durationMs = run?.startedAt ? Math.max(0, endedAt - run.startedAt) : undefined;

		let changedFiles: number | undefined;
		if (tracker && this.gitService) {
			const project = this.projectStore.get(tracker.projectId);
			if (project) {
				try {
					const statusRes = await this.gitService.getStatus(project.path);
					changedFiles = statusRes.workingTree.length + statusRes.untracked.length + statusRes.merge.length + statusRes.index.length;
				} catch {
					// Ignore non-git or inaccessible project directories
				}
			}
		}

		// Optionally stop the runtime if target was acquired and task finished, to free agent child process
		if (tracker?.target && status === "succeeded") {
			try {
				await this.sessionRuntimeCoordinator.stopRuntime(tracker.target);
			} catch {
				// Non-fatal if runtime stop fails
			}
		}

		const updatedRun = await this.store.updateRun(runId, {
			status,
			endedAt,
			durationMs,
			updatedAt: endedAt,
			...(error ? { error } : {}),
			...(extra?.budgetReason ? { budgetReason: extra.budgetReason } : {}),
			...(extra?.skippedReason ? { skippedReason: extra.skippedReason } : {}),
			...(extra?.inputTokens !== undefined ? { inputTokens: extra.inputTokens } : {}),
			...(extra?.outputTokens !== undefined ? { outputTokens: extra.outputTokens } : {}),
			...(extra?.costUsd !== undefined ? { costUsd: extra.costUsd } : {}),
			...(extra?.stepCount !== undefined ? { stepCount: extra.stepCount } : {}),
			...(changedFiles !== undefined ? { changedFiles } : {}),
		}, {
			type: statusToEventType(status),
			at: endedAt,
			message: error || (status === "succeeded" ? "Run completed successfully" : undefined),
		});

		// Trigger desktop notification when configured
		if (this.notifyRunFinished && updatedRun) {
			const task = this.store.getTask(updatedRun.taskId);
			if (task) {
				try {
					this.notifyRunFinished(updatedRun, task);
				} catch {
					// Ignore notification errors
				}
			}
		}

		void this.drainQueue();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusToEventType(status: AutomationRunStatus): import("../../shared/types").AutomationRunEventType {
	if (status === "budget-exhausted") return "budget-exhausted";
	if (status === "timed-out") return "timed-out";
	if (status === "interrupted") return "interrupted";
	if (status === "skipped") return "skipped";
	if (status === "aborted") return "aborted";
	if (status === "failed") return "failed";
	if (status === "succeeded") return "completed";
	return "completed";
}
