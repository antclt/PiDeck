/**
 * PiDeck Todo Extension
 *
 * This extension owns a branch-scoped, durable current work plan. A plan changes
 * only through an explicit tool action: `replace` starts a new plan, `restore`
 * swaps back the immediately superseded plan, and `clear` intentionally removes
 * it. Completion, idle time, normal user messages, and session startup never
 * infer a plan boundary.
 *
 * State is persisted as custom entries and rebuilt on both `session_start` and
 * `session_tree`, so switching a session branch restores that branch's plan.
 * The widget stays line-based for the existing pi RPC transport; its first
 * machine-readable line carries the active plan identity and is ignored only by
 * PiDeck's own todo-widget parser. It therefore participates in the renderer's
 * dismiss fingerprint even if two plans have identical visible task text.
 *
 * This is intentionally independent from `pi-deck-plan-mode.ts`: plan mode has
 * a separate lifecycle and continues to publish the `pi-deck-plan-todos` widget.
 *
 * @packageDocumentation
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

interface Todo {
	id: number;
	text: string;
	done: boolean;
}

interface TodoPlan {
	id: number;
	todos: Todo[];
}

/** Durable v2 snapshot. `activePlan` is absent only after an explicit clear. */
interface TodoState {
	version: 2;
	activePlan?: TodoPlan;
	previousPlan?: TodoPlan;
	/** Stable across reloads for the branch that last mutated this plan. */
	widgetScopeId?: string;
	nextPlanId: number;
	nextTodoId: number;
}

type TodoAction = "list" | "add" | "toggle" | "replace" | "restore" | "clear";

/** Tool details deliberately expose only the current plan, not hidden undo content. */
interface TodoDetails {
	action: TodoAction;
	todos: Todo[];
	activePlanId?: number;
	previousPlanId?: number;
	nextPlanId: number;
	nextTodoId: number;
	error?: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "replace", "restore", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
	items: Type.Optional(
		Type.Array(
			Type.Object({
				text: Type.String({ description: "Todo text in a replacement plan" }),
				done: Type.Optional(Type.Boolean({ description: "Whether this replacement item is already complete" })),
			}),
			{ description: "Complete replacement plan (required for replace)" },
		),
	),
});

// Widget key and custom entry type remain stable so existing clients and snapshots keep working.
const WIDGET_KEY = "pi-deck-todo";
const ENTRY_TYPE = "pi-deck-todo";
const SELF_MARKER = "pi-deck-todo";
const TODO_CONTEXT_ENTRY_TYPE = "pi-deck-todo-context";
// This is a private PiDeck widget-line contract, not user-facing text. Keep it first in the array.
const PLAN_METADATA_PREFIX = "[[pid:todo-plan:";
const PLAN_METADATA_SUFFIX = "]]";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTodoPlanContextMessage(message: unknown): boolean {
	return isRecord(message) && message.customType === TODO_CONTEXT_ENTRY_TYPE;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cloneTodos(items: Todo[]): Todo[] {
	return items.map((item) => ({ ...item }));
}

function clonePlan(plan: TodoPlan): TodoPlan {
	return { id: plan.id, todos: cloneTodos(plan.todos) };
}

function highestTodoId(plans: Array<TodoPlan | undefined>): number {
	let highest = 0;
	for (const plan of plans) {
		for (const todo of plan?.todos ?? []) {
			highest = Math.max(highest, todo.id);
		}
	}
	return highest;
}

function readTodos(value: unknown): Todo[] {
	if (!Array.isArray(value)) return [];
	const todos: Todo[] = [];
	for (const candidate of value) {
		if (!isRecord(candidate)) continue;
		const id = positiveInteger(candidate.id);
		if (!id || typeof candidate.text !== "string" || typeof candidate.done !== "boolean") continue;
		const text = candidate.text.trim();
		if (!text) continue;
		todos.push({ id, text, done: candidate.done });
	}
	return todos;
}

function readPlan(value: unknown): TodoPlan | undefined {
	if (!isRecord(value)) return undefined;
	const id = positiveInteger(value.id);
	const todos = readTodos(value.todos);
	return id && todos.length > 0 ? { id, todos } : undefined;
}

function emptyState(): TodoState {
	return { version: 2, nextPlanId: 1, nextTodoId: 1 };
}

/**
 * Decode V2 snapshots and migrate the previous `{ todos, nextId }` shape in memory.
 * The migration never writes on session restore; the next explicit mutation persists V2.
 */
function readState(value: unknown): TodoState {
	if (!isRecord(value)) return emptyState();

	if (value.version === 2) {
		const activePlan = readPlan(value.activePlan);
		const previousPlan = readPlan(value.previousPlan);
		const widgetScopeId = nonEmptyString(value.widgetScopeId);
		const largestPlanId = Math.max(activePlan?.id ?? 0, previousPlan?.id ?? 0);
		const highestId = highestTodoId([activePlan, previousPlan]);
		return {
			version: 2,
			...(activePlan ? { activePlan } : {}),
			...(previousPlan ? { previousPlan } : {}),
			...(widgetScopeId ? { widgetScopeId } : {}),
			nextPlanId: Math.max(positiveInteger(value.nextPlanId) ?? 1, largestPlanId + 1),
			nextTodoId: Math.max(positiveInteger(value.nextTodoId) ?? 1, highestId + 1),
		};
	}

	const todos = readTodos(value.todos);
	const activePlan = todos.length > 0 ? { id: 1, todos } : undefined;
	const legacyNextTodoId = positiveInteger(value.nextId) ?? 1;
	return {
		version: 2,
		...(activePlan ? { activePlan } : {}),
		nextPlanId: activePlan ? 2 : 1,
		nextTodoId: Math.max(legacyNextTodoId, highestTodoId([activePlan]) + 1),
	};
}

export default function piDeckTodoExtension(pi: ExtensionAPI): void {
	let activePlan: TodoPlan | undefined;
	let previousPlan: TodoPlan | undefined;
	let widgetScopeId: string | undefined;
	let nextPlanId = 1;
	let nextTodoId = 1;
	// A third-party `todo` tool owns the name once it replaces ours. Stop publishing our widget then.
	let yielded = false;

	function resetState(): void {
		activePlan = undefined;
		previousPlan = undefined;
		widgetScopeId = undefined;
		nextPlanId = 1;
		nextTodoId = 1;
	}

	function currentTodos(): Todo[] {
		return activePlan?.todos ?? [];
	}

	function isOwnTodo(): boolean {
		const tool = pi.getAllTools().find((candidate) => candidate.name === "todo");
		const sourceInfo = isRecord(tool?.sourceInfo) ? tool.sourceInfo : undefined;
		const path = typeof sourceInfo?.path === "string" ? sourceInfo.path : "";
		const source = typeof sourceInfo?.source === "string" ? sourceInfo.source : "";
		return path.includes(SELF_MARKER) || source.includes(SELF_MARKER);
	}

	function persistedState(): TodoState {
		return {
			version: 2,
			...(activePlan ? { activePlan: clonePlan(activePlan) } : {}),
			...(previousPlan ? { previousPlan: clonePlan(previousPlan) } : {}),
			...(widgetScopeId ? { widgetScopeId } : {}),
			nextPlanId,
			nextTodoId,
		};
	}

	function persistState(): void {
		pi.appendEntry(ENTRY_TYPE, persistedState());
	}

	function planMetadataLine(planId: number): string {
		const identity = widgetScopeId
			? `${encodeURIComponent(widgetScopeId)}:${planId}`
			: String(planId);
		return `${PLAN_METADATA_PREFIX}${identity}${PLAN_METADATA_SUFFIX}`;
	}

	/** Extensions always publish complete item rows. Disclosure is renderer-owned. */
	function updateWidget(ctx: ExtensionContext): void {
		if (!activePlan || activePlan.todos.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(WIDGET_KEY, [
			planMetadataLine(activePlan.id),
			...activePlan.todos.map((todo) => `${todo.done ? "☑" : "☐"} #${todo.id} ${todo.text}`),
		]);
	}

	/** Restore only the latest custom snapshot in the selected session branch. */
	function reconstructState(ctx: ExtensionContext): void {
		let lastData: unknown;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (!isRecord(entry)) continue;
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) lastData = entry.data;
		}
		const state = readState(lastData);
		activePlan = state.activePlan ? clonePlan(state.activePlan) : undefined;
		previousPlan = state.previousPlan ? clonePlan(state.previousPlan) : undefined;
		widgetScopeId = state.widgetScopeId;
		nextPlanId = state.nextPlanId;
		nextTodoId = state.nextTodoId;
	}

	function ensureActivePlan(): TodoPlan {
		if (!activePlan) {
			activePlan = { id: nextPlanId, todos: [] };
			nextPlanId += 1;
		}
		return activePlan;
	}

	/**
	 * Persist a branch-local scope on each successful mutation. A fork inherits the
	 * parent's snapshot, but its next mutation has a distinct leaf and therefore a
	 * distinct widget dismissal identity without guessing a plan boundary.
	 */
	function refreshWidgetScope(ctx: ExtensionContext): void {
		widgetScopeId = nonEmptyString(ctx.sessionManager.getLeafId());
	}

	/** Build a replacement before mutating so an invalid item leaves the existing plan intact. */
	function buildReplacement(items: unknown): Todo[] | string {
		if (!Array.isArray(items) || items.length === 0) return "items required for replace";
		const replacement: Todo[] = [];
		let candidateId = nextTodoId;
		for (let index = 0; index < items.length; index += 1) {
			const item = items[index];
			if (!isRecord(item) || typeof item.text !== "string") {
				return `items[${index}].text required for replace`;
			}
			const text = item.text.trim();
			if (!text) return `items[${index}].text required for replace`;
			replacement.push({ id: candidateId, text, done: item.done === true });
			candidateId += 1;
		}
		return replacement;
	}

	function details(action: TodoAction, error?: string): TodoDetails {
		return {
			action,
			todos: cloneTodos(currentTodos()),
			...(activePlan ? { activePlanId: activePlan.id } : {}),
			...(previousPlan ? { previousPlanId: previousPlan.id } : {}),
			nextPlanId,
			nextTodoId,
			...(error ? { error } : {}),
		};
	}

	function todoListText(): string {
		const todos = currentTodos();
		return todos.length
			? todos.map((todo) => `[${todo.done ? "x" : " "}] #${todo.id}: ${todo.text}`).join("\n")
			: "No todos";
	}

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage the current todo plan. Actions: list, add, toggle, replace (atomically begin a new plan), restore (undo the latest replacement), and clear (intentionally remove it).",
		promptSnippet: "Manage the current todo plan (add / toggle / replace / restore / clear)",
		promptGuidelines: [
			"Use the todo tool to maintain the current actionable plan. Add items for continuation work and toggle them as work completes.",
			"Start a new or materially re-scoped task with one todo replace call containing the complete new plan. Never infer that boundary from completed items, idle time, a user message, or session start.",
			"If a replacement was mistaken, call todo restore immediately. Use clear only when intentionally discarding the active plan.",
			"Todo state is per-branch: switching branches restores that branch's plan. Call list when the current IDs or plan are uncertain.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let error: string | undefined;
			let addedTodo: Todo | undefined;
			let toggledTodo: Todo | undefined;

			switch (params.action) {
				case "add": {
					const text = typeof params.text === "string" ? params.text.trim() : "";
					if (!text) {
						error = "text required for add";
						break;
					}
					const plan = ensureActivePlan();
					addedTodo = { id: nextTodoId, text, done: false };
					nextTodoId += 1;
					plan.todos.push(addedTodo);
					break;
				}
				case "toggle": {
					if (params.id === undefined) {
						error = "id required for toggle";
						break;
					}
					const target = currentTodos().find((todo) => todo.id === params.id);
					if (!target) {
						error = `#${params.id} not found`;
						break;
					}
					target.done = !target.done;
					toggledTodo = target;
					break;
				}
				case "replace": {
					const replacement = buildReplacement(params.items);
					if (typeof replacement === "string") {
						error = replacement;
						break;
					}
					previousPlan = activePlan ? clonePlan(activePlan) : undefined;
					activePlan = { id: nextPlanId, todos: replacement };
					nextPlanId += 1;
					nextTodoId += replacement.length;
					break;
				}
				case "restore": {
					if (!previousPlan) {
						error = "no replaced plan is available to restore";
						break;
					}
					const outgoingPlan = activePlan ? clonePlan(activePlan) : undefined;
					activePlan = clonePlan(previousPlan);
					previousPlan = outgoingPlan;
					break;
				}
				case "clear":
					activePlan = undefined;
					previousPlan = undefined;
					break;
				case "list":
					break;
			}

			if (params.action !== "list" && !error) {
				if (params.action === "clear") widgetScopeId = undefined;
				else refreshWidgetScope(ctx);
				persistState();
			}
			updateWidget(ctx);

			let text: string;
			if (error) {
				text = `Error: ${error}`;
			} else if (params.action === "list") {
				text = todoListText();
			} else if (params.action === "add") {
				text = `Added todo #${addedTodo?.id}: ${addedTodo?.text}`;
			} else if (params.action === "toggle") {
				text = `Todo #${toggledTodo?.id} ${toggledTodo?.done ? "completed" : "uncompleted"}`;
			} else if (params.action === "replace") {
				text = `Replaced the current plan with ${currentTodos().length} todos`;
			} else if (params.action === "restore") {
				text = `Restored todo plan #${activePlan?.id}`;
			} else {
				text = "Cleared the current todo plan";
			}

			return {
				content: [{ type: "text" as const, text }],
				details: details(params.action, error),
			};
		},
	});

	pi.registerCommand("todo", {
		description: "查看、清空或恢复当前分支待办计划",
		handler: async (args, ctx) => {
			if (!isOwnTodo()) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				ctx.ui.notify("Todo 工具由其他扩展提供，请使用其对应命令（如 /todos）查看。", "info");
				return;
			}
			const command = String(args ?? "").trim().toLowerCase();
			if (command === "clear") {
				activePlan = undefined;
				previousPlan = undefined;
				widgetScopeId = undefined;
				persistState();
				updateWidget(ctx);
				ctx.ui.notify("已清空当前待办计划。", "info");
				return;
			}
			if (command === "restore") {
				if (!previousPlan) {
					ctx.ui.notify("没有可恢复的被替换计划。", "info");
					return;
				}
				const outgoingPlan = activePlan ? clonePlan(activePlan) : undefined;
				activePlan = clonePlan(previousPlan);
				previousPlan = outgoingPlan;
				refreshWidgetScope(ctx);
				persistState();
				updateWidget(ctx);
				ctx.ui.notify(`已恢复待办计划 #${activePlan.id}。`, "info");
				return;
			}
			if (command === "collapse" || command === "expand") {
				ctx.ui.notify("待办计划可在 PiDeck 输入框上方展开或折叠。", "info");
				return;
			}
			if (!activePlan) {
				ctx.ui.notify("还没有待办计划，可以告诉 AI 添加或替换计划。", "info");
				return;
			}
			const todos = currentTodos();
			const done = todos.filter((todo) => todo.done).length;
			ctx.ui.notify(
				`Todos ${done}/${todos.length}\n${todos.map((todo) => `${todo.done ? "☑" : "☐"} #${todo.id} ${todo.text}`).join("\n")}`,
				"info",
			);
		},
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!isOwnTodo()) {
			yielded = true;
			resetState();
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		if (yielded || !activePlan || activePlan.todos.length === 0) return;
		return {
			message: {
				customType: TODO_CONTEXT_ENTRY_TYPE,
				content: `[CURRENT TODO PLAN #${activePlan.id}]\nThis is the current plan, not a history-based task boundary. Continue it with add/toggle when it still applies. For a new or materially re-scoped request, call todo replace with the complete new plan even if old items are unfinished. Do not clear because items are complete or because a new user message arrived. Call todo restore after an accidental replacement.\n\n${todoListText()}`,
				display: false,
			},
		};
	});

	pi.on("context", async (event) => {
		let latestTodoContextIndex = -1;
		for (let index = 0; index < event.messages.length; index += 1) {
			if (isTodoPlanContextMessage(event.messages[index])) latestTodoContextIndex = index;
		}
		const keepLatestTodoContext = !yielded && isOwnTodo() && activePlan !== undefined;
		const messages = event.messages.filter((message, index) => {
			return !isTodoPlanContextMessage(message) || (keepLatestTodoContext && index === latestTodoContextIndex);
		});
		return messages.length === event.messages.length ? undefined : { messages };
	});

	function restoreForCurrentBranch(ctx: ExtensionContext): void {
		if (!isOwnTodo()) {
			yielded = true;
			resetState();
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		yielded = false;
		reconstructState(ctx);
		updateWidget(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		restoreForCurrentBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreForCurrentBranch(ctx);
	});
}
