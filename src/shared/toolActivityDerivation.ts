/**
 * 工具调用 → 待办 / 子代理 的通用推导（纯函数，零运行时依赖）。
 *
 * 为什么需要这一层：待办与子代理在 pi 走扩展 widget + 会话文件 record，在 DSH 走官方
 * projection，两者都有结构化真源；ACP 两者都没有——CLI 把「待办」和「子代理」当普通工具
 * 调用上报（CodeBuddy 的 TaskCreate/TaskUpdate、Claude 的 TodoWrite/Task、Codex 的
 * update_plan……），协议层没有任何专门字段。于是按**工具名 + 参数形状**把工具卡折叠成与
 * pi/DSH 同构的 `TodoItem[]` / `PiSubagentEntry[]`，渲染层直接复用既有展示组件。
 *
 * 设计约束：
 * - 只看工具卡（role === "tool"）的 meta：`toolName` / `args` / `status` / `result`，
 *   这是 ACP/DSH/PTC 共用且已经过投影器归一化的形状；不读 CLI 私有帧。
 * - 名称匹配一律「小写 + 去分隔符」归一：`TaskCreate` / `task_create` / `TASK-CREATE`
 *   同一把键，避免为每个 CLI 维护拼写表。
 * - **同名不同义必须以参数形状区分**：`TaskCreate`/`TaskUpdate` 是待办（camelCase
 *   `taskId` + `subject`），`TaskOutput`/`TaskStop` 是后台 shell 任务（snake_case
 *   `task_id`），绝不能因为共享 Task 前缀就互相串。
 * - 推导结果永远 best-effort：解析不出来就返回空，不抛、不猜语义。
 *
 * @module toolActivityDerivation
 */

import type { ChatMessage } from "./types/session";
import type { PiSubagentEntry, PiSubagentStatus } from "./types/subagents";
import type { TodoItem, TodoStatus } from "./types/todo";

/** 推导输入的最小形状：会话消息里只有工具卡参与推导。 */
export type ToolActivityMessage = {
	id: string;
	role: ChatMessage["role"];
	timestamp?: number;
	meta?: Record<string, unknown>;
};

/** 工具结果预览上限（与 ACP 工具卡截断、record 预览同口径）。 */
const RESULT_PREVIEW_MAX_CHARS = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 工具名归一：小写并去掉空格/下划线/连字符，三种拼写落到同一把键。 */
function normalizeToolKey(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[\s_-]/g, "");
}

/** 任意值 → 单行文本（数组拼 text 项，record 取 text 字段）；空串归一为 undefined。 */
function toText(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed || undefined;
	}
	if (Array.isArray(value)) {
		const joined = value
			.map((item) => toText(item))
			.filter((item): item is string => Boolean(item))
			.join("\n")
			.trim();
		return joined || undefined;
	}
	if (isRecord(value)) return toText(value.text);
	return undefined;
}

/** 依次取第一个非空文本字段（不同 CLI 同一语义用不同键名）。 */
function firstText(source: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
	if (!source) return undefined;
	for (const key of keys) {
		const text = toText(source[key]);
		if (text) return text;
	}
	return undefined;
}

/** 工具卡正文：`fullText`（content 归一）优先，其次 `result`（rawOutput）。 */
function resultText(meta: Record<string, unknown>): string | undefined {
	return toText(meta.fullText) ?? toText(meta.result);
}

/* ------------------------------------------------------------------ */
/* 待办（todo plan）                                                    */
/* ------------------------------------------------------------------ */

/** 整表工具：一次调用给全量清单（last-wins）。 */
const TODO_LIST_TOOLS: ReadonlySet<string> = new Set(["todowrite", "todo", "todos", "todolist", "updateplan", "writetodos", "settodos", "planwrite"]);
/** 增量工具：一次调用只增/改一条（CodeBuddy / Claude TaskCreate·TaskUpdate）。 */
const TODO_CREATE_TOOLS: ReadonlySet<string> = new Set(["taskcreate", "createtask", "taskadd", "addtask"]);
const TODO_UPDATE_TOOLS: ReadonlySet<string> = new Set(["taskupdate", "updatetask", "taskedit", "edittask"]);

/** 整表条目里承载正文的键（update_plan 用 step，TodoWrite 用 content，Task 系用 subject）。 */
const TODO_TEXT_KEYS = ["content", "subject", "title", "text", "task", "step", "description"] as const;
/** 整表清单可能的容器键。 */
const TODO_LIST_KEYS = ["todos", "plan", "items", "tasks", "entries"] as const;

/** 状态词表：容错各家拼写；"deleted" 单独标记为删除。 */
function parseTodoStatus(value: unknown): TodoStatus | "deleted" | undefined {
	if (typeof value !== "string") return undefined;
	const key = value.trim().toLowerCase().replace(/[\s-]/g, "_");
	switch (key) {
		case "in_progress":
		case "inprogress":
		case "active":
		case "working":
			return "in_progress";
		case "completed":
		case "complete":
		case "done":
		case "finished":
			return "completed";
		case "pending":
		case "todo":
		case "open":
		case "not_started":
		case "waiting":
			return "pending";
		case "deleted":
		case "removed":
		case "cancelled":
		case "canceled":
			return "deleted";
		default:
			return undefined;
	}
}

type PlanItem = { key: string; content: string; status: TodoStatus };

/** 整表工具参数 → 清单；非整表形状返回 undefined（区别于「整表清空」的空数组）。 */
function readTodoList(args: Record<string, unknown>): PlanItem[] | undefined {
	for (const key of TODO_LIST_KEYS) {
		const raw = args[key];
		if (!Array.isArray(raw)) continue;
		const items: PlanItem[] = [];
		for (const candidate of raw) {
			if (!isRecord(candidate)) continue;
			const content = firstText(candidate, TODO_TEXT_KEYS);
			if (!content) continue;
			const status = parseTodoStatus(candidate.status ?? candidate.state);
			if (status === "deleted") continue;
			items.push({ key: String(items.length + 1), content, status: status ?? "pending" });
		}
		return items;
	}
	return undefined;
}

/** 创建回执里可能带回真实 id（`Task #3 created`）：有就以它为准，没有用序号。 */
function readCreatedTaskId(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const match = /task\s*#\s*(\d+)/i.exec(text);
	return match?.[1];
}

/**
 * 会话消息 → 当前待办清单。
 *
 * 规则按到达顺序折叠：整表工具覆盖全部；增量工具按 id 增/改/删。没有可识别的工具卡时
 * 返回空数组（渲染层据此隐藏任务条）。
 */
export function deriveTodoPlan(messages: readonly ToolActivityMessage[]): TodoItem[] {
	let items: PlanItem[] = [];
	// 增量工具的隐式 id 序号：CLI 不回报真实 id 时按创建顺序 1..n 编号
	let sequence = 0;

	for (const message of messages) {
		if (message.role !== "tool" || !message.meta) continue;
		const toolName = typeof message.meta.toolName === "string" ? message.meta.toolName : "";
		const key = normalizeToolKey(toolName);
		if (!key) continue;
		const args = isRecord(message.meta.args) ? message.meta.args : undefined;

		if (TODO_LIST_TOOLS.has(key)) {
			const list = readTodoList(args ?? {});
			if (list) {
				items = list;
				sequence = list.length;
			}
			continue;
		}

		if (TODO_CREATE_TOOLS.has(key)) {
			const content = firstText(args, TODO_TEXT_KEYS);
			if (!content) continue;
			sequence += 1;
			const explicitId = readCreatedTaskId(resultText(message.meta));
			items = [...items, { key: explicitId ?? String(sequence), content, status: "pending" }];
			if (explicitId) sequence = Math.max(sequence, Number(explicitId) || sequence);
			continue;
		}

		if (TODO_UPDATE_TOOLS.has(key)) {
			const id = firstText(args, ["taskId", "task_id", "id", "task"]);
			if (!id) continue;
			const index = items.findIndex((item) => item.key === id);
			if (index < 0) continue;
			const status = parseTodoStatus(args?.status ?? args?.state);
			if (!status) continue;
			if (status === "deleted") {
				items = items.filter((_, position) => position !== index);
				continue;
			}
			items = items.map((item, position) => (position === index ? { ...item, status } : item));
		}
	}

	return items.map((item) => ({ content: item.content, status: item.status }));
}

/* ------------------------------------------------------------------ */
/* 子代理（subagent）                                                   */
/* ------------------------------------------------------------------ */

/** 精确名表：Claude 的 Task、CodeBuddy 的 Agent、pi 的 acp_delegate 等。 */
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(["task", "agent", "subagent", "runagent", "spawnagent", "dispatchagent", "delegatetask", "delegatesubtask", "useagent", "launchagent", "acpdelegate"]);

/** 子代理工具名判定：精确名优先，`subagent*` 前缀兜底，但排除查询/停止类派生工具。 */
export function isSubagentToolName(toolName: string): boolean {
	const key = normalizeToolKey(toolName);
	if (!key) return false;
	if (SUBAGENT_TOOLS.has(key)) return true;
	if (!key.startsWith("subagent")) return false;
	return !/(inspect|status|list|output|stop|cancel|get|history)$/.test(key);
}

const SUBAGENT_TEXT_KEYS = ["description", "task", "prompt", "message", "instruction", "query", "objective", "subject"] as const;
/** 显式声明子代理类型的键（Task 工具 schema）；既是判定依据，也是类型的首选来源。 */
const SUBAGENT_DECLARED_TYPE_KEYS = ["subagent_type", "subagentType", "agent_type", "agentType"] as const;
const SUBAGENT_TYPE_KEYS = [...SUBAGENT_DECLARED_TYPE_KEYS, "agent", "type", "role", "name"] as const;

/**
 * 子代理调用判定：名字 + 参数形状双判据。
 *
 * 光看名字不够——Claude Code / CodeBuddy 的 Task 工具在 ACP 侧的 title 常被 CLI 写成
 * **子代理类型名**（实测 "general-purpose"），完全不叫 Task；但它的参数一定带
 * `subagent_type`（Task 工具 schema 的必填项）。名字表负责 Task/Agent/subagent 这类
 * 常规写法，参数判据负责 title 被改写的场景。
 */
export function isSubagentToolCall(toolName: string, args?: Record<string, unknown>): boolean {
	if (args) {
		for (const key of SUBAGENT_DECLARED_TYPE_KEYS) {
			if (toText(args[key])) return true;
		}
	}
	return isSubagentToolName(toolName);
}

/** 工具卡状态 → 子代理生命周期（ACP 只有 running/completed/error 三态）。 */
function parseSubagentStatus(meta: Record<string, unknown>): PiSubagentStatus {
	const raw = typeof meta.status === "string" ? meta.status.trim().toLowerCase() : "";
	switch (raw) {
		case "completed":
		case "complete":
		case "done":
			return "completed";
		case "error":
		case "failed":
			return "error";
		case "aborted":
		case "cancelled":
		case "canceled":
			return "aborted";
		case "stopped":
			return "stopped";
		case "pending":
		case "queued":
			return "queued";
		default:
			return "running";
	}
}

function isTerminalSubagentStatus(status: PiSubagentStatus): boolean {
	return status === "completed" || status === "error" || status === "stopped" || status === "aborted" || status === "steered";
}

/**
 * 会话消息 → 子代理条目。
 *
 * 与 pi 的 record/桥接链同构：id 用工具调用 id（同一次调用的多次 update 在投影器里已经
 * 原位合并成一张卡，这里再按 id last-wins 兜一次重放）。终态条目保留结果预览（2000
 * 字符），与 record 预览一致。
 */
export function deriveSubagents(messages: readonly ToolActivityMessage[]): PiSubagentEntry[] {
	const byId = new Map<string, PiSubagentEntry>();

	for (const message of messages) {
		if (message.role !== "tool" || !message.meta) continue;
		const meta = message.meta;
		const toolName = typeof meta.toolName === "string" ? meta.toolName : "";
		const args = isRecord(meta.args) ? meta.args : undefined;
		if (!isSubagentToolCall(toolName, args)) continue;
		const toolCallId = typeof meta.toolCallId === "string" && meta.toolCallId ? meta.toolCallId : message.id;
		if (!toolCallId) continue;
		const status = parseSubagentStatus(meta);
		const result = resultText(meta);
		byId.set(toolCallId, {
			id: toolCallId,
			type: firstText(args, SUBAGENT_TYPE_KEYS) ?? toolName,
			description: firstText(args, SUBAGENT_TEXT_KEYS) ?? "",
			status,
			...(status === "error" ? { error: result?.slice(0, RESULT_PREVIEW_MAX_CHARS) } : {}),
			...(isTerminalSubagentStatus(status) && result ? { result: result.slice(0, RESULT_PREVIEW_MAX_CHARS) } : {}),
			...(typeof message.timestamp === "number" ? { startedAt: message.timestamp } : {}),
			source: "toolcall",
			...(normalizeToolKey(toolName) === "acpdelegate" ? { via: "acp-delegate" as const } : {}),
		});
	}

	// 排序与 pi 三源合并同口径：运行中置顶，其余按开始时间倒序（最近的在上面）
	return [...byId.values()].sort((left, right) => {
		const leftActive = left.status === "running" || left.status === "queued";
		const rightActive = right.status === "running" || right.status === "queued";
		if (leftActive !== rightActive) return leftActive ? -1 : 1;
		return (right.startedAt ?? 0) - (left.startedAt ?? 0);
	});
}
