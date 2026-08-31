/**
 * 会话 todo 快照解析（跨进程共用纯函数）。
 *
 * pi-deck-todo.ts 扩展在每次 todo 变更时通过 pi.appendEntry("pi-deck-todo", state)
 * 把 version-2 快照持久化到会话文件；分支上最后一条即最新状态。
 * 本模块供 main（会话 todo 快照 IPC）解析快照 data，无运行时依赖，可被 node 单测直接加载。
 */
import type { SessionTodoSnapshot } from "./types/sessionTodo.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析 pi-deck-todo 快照 data：
 * - 无 activePlan（clear 后）或格式非法 → undefined（渲染层显示空态）；
 * - todos 逐项校验（id 限数字、text 限非空字符串、done 限布尔），坏项丢弃而非整体失败。
 */
export function parseTodoSnapshotData(data: unknown): SessionTodoSnapshot | undefined {
	if (!isRecord(data)) return undefined;
	const plan = isRecord(data.activePlan) ? data.activePlan : undefined;
	if (!plan) return undefined;
	const planId = typeof plan.id === "number" && Number.isFinite(plan.id) ? plan.id : 0;
	if (!Array.isArray(plan.todos)) return { planId, todos: [] };
	const todos: SessionTodoSnapshot["todos"] = [];
	for (const raw of plan.todos) {
		if (!isRecord(raw)) continue;
		if (typeof raw.id !== "number" || !Number.isFinite(raw.id)) continue;
		if (typeof raw.text !== "string" || !raw.text.trim()) continue;
		todos.push({ id: raw.id, text: raw.text, done: raw.done === true });
	}
	return { planId, todos };
}
