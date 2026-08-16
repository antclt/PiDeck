import type { SessionProcessEvent } from "../../shared/types/trajectory";

/**
 * DSH SessionEvent → 轨迹过程事件（纯函数，可单测）。
 *
 * pi 的轨迹账本有 JSONL 过程事件（session/model_change/compaction/custom），
 * DSH 会话没有会话文件，过程事件从 mux 事件流按语义收集：
 * - request/context（provider/model）→ modelChange（模型切换/首轮路由）；
 * - permission/preset → custom(permission)（权限预设切换）；
 * - plan/mode → custom(plan)（plan 模式开关）；
 * - goal/change → custom(goal)（目标创建/操作/clear）；
 * - user/message 且文本以 /compact 开头 → compaction（压缩命令回合）。
 *
 * 只返回「相对上一条新增」的过程事件；调用方（DshAgentManager）按序追加并封顶，
 * 与 pi 的 parseSessionProcessEvents（MAX_EVENTS=240）同语义。
 */

export const DSH_PROCESS_EVENTS_LIMIT = 240;

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventTime(time: unknown): number {
	return typeof time === "number" && Number.isFinite(time) ? time : Date.now();
}

/** user/message 正文拼接（与 dshEventProjector 的 textFromBlocks 同规则）。 */
function textFromBlocks(blocks: unknown): string {
	if (!Array.isArray(blocks)) return "";
	let text = "";
	for (const block of blocks) {
		if (!isRecord(block) || block.type !== "text") continue;
		if (typeof block.text === "string") text += block.text;
	}
	return text;
}

/** request/context 的 provider/model（与 dshEventProjector 的 modelFromEvent 同规则）。 */
function modelFromEvent(event: { data?: unknown }): { provider: string; model: string } | undefined {
	const data = (event.data ?? {}) as { provider?: unknown; model?: unknown };
	if (typeof data.provider === "string" && typeof data.model === "string") {
		return { provider: data.provider, model: data.model };
	}
	return undefined;
}

/**
 * 从单条 SessionEvent 推导过程事件；无对应语义时返回 undefined。
 * prev 仅用于「同内容不重复记录」的幂等判断（如权限/plan 事件重复推送时跳过）。
 */
export function collectDshProcessEvent(
	prev: SessionProcessEvent[],
	event: { type?: string; seq?: number; data?: unknown; time?: unknown } | undefined,
): SessionProcessEvent | undefined {
	if (!event?.type) return undefined;
	const type = event.type;
	const seq = typeof event.seq === "number" ? event.seq : 0;
	const id = `dsh-process:${type}:${seq}`;
	const timestamp = eventTime(event.time);
	const data = (event.data ?? {}) as Record<string, unknown>;

	switch (type) {
		case "request/context": {
			const model = modelFromEvent(event);
			if (!model) return undefined;
			// 幂等：连续 request/context 同模型不重复记账（首轮路由 + 每轮请求都可能触发）。
			const last = prev[prev.length - 1];
			if (last?.kind === "modelChange" && last.provider === model.provider && last.modelId === model.model) {
				return undefined;
			}
			return {
				id,
				kind: "modelChange",
				timestamp,
				summary: `${model.provider}/${model.model}`,
				detail: `${model.provider}/${model.model}`,
				provider: model.provider,
				modelId: model.model,
			};
		}
		case "permission/preset": {
			const preset = asString(data.preset);
			if (!preset) return undefined;
			const last = prev[prev.length - 1];
			if (last?.customType === "permission" && last.summary === `permission ${preset}`) return undefined;
			return {
				id,
				kind: "custom",
				timestamp,
				summary: `permission ${preset}`,
				detail: `permission ${preset}`,
				customType: "permission",
			};
		}
		case "plan/mode": {
			const active = data.active === true;
			const summary = `plan ${active ? "on" : "off"}`;
			const last = prev[prev.length - 1];
			if (last?.customType === "plan" && last.summary === summary) return undefined;
			return {
				id,
				kind: "custom",
				timestamp,
				summary,
				detail: summary,
				customType: "plan",
			};
		}
		case "goal/change": {
			const meta = data as { operation?: unknown; goal?: unknown; cleared?: unknown };
			const operation = asString(meta.operation);
			const objective = isRecord(meta.goal) ? asString((meta.goal as Record<string, unknown>).objective) : undefined;
			const summary = operation === "clear"
				? "goal cleared"
				: `goal ${operation ?? "changed"}${objective ? `: ${objective}` : ""}`;
			return {
				id,
				kind: "custom",
				timestamp,
				summary,
				detail: summary,
				customType: "goal",
			};
		}
		case "user/message": {
			// /compact 命令回合：slash 桥把压缩指令作为 queue 消息发出，轨迹记一条压缩过程。
			const text = textFromBlocks(data.content).trim();
			if (!text.startsWith("/compact")) return undefined;
			const prompt = text.replace(/^\/compact\s*/, "").trim();
			const last = prev[prev.length - 1];
			if (last?.kind === "compaction" && timestamp - last.timestamp < 5_000) return undefined;
			return {
				id,
				kind: "compaction",
				timestamp,
				summary: prompt ? `compact: ${prompt}` : "compact",
				detail: text,
			};
		}
		default:
			return undefined;
	}
}

/** 追加一条过程事件并封顶（与 pi 的 MAX_EVENTS 同语义）。 */
export function pushDshProcessEvent(
	current: SessionProcessEvent[],
	next: SessionProcessEvent | undefined,
): SessionProcessEvent[] {
	if (!next) return current;
	const result = [...current, next];
	if (result.length > DSH_PROCESS_EVENTS_LIMIT) {
		return result.slice(result.length - DSH_PROCESS_EVENTS_LIMIT);
	}
	return result;
}

/** 由 sessions.list 的 projections.values 恢复 context 占用初值（attach/restart 时）。 */
export function parseContextPressureProjection(
	values: unknown,
): { pressureTokens?: number; projectedTokens?: number; contextWindow?: number } | undefined {
	if (!isRecord(values)) return undefined;
	const raw = values.contextPressure;
	if (!isRecord(raw)) return undefined;
	const result: { pressureTokens?: number; projectedTokens?: number; contextWindow?: number } = {};
	const pressureTokens = asNumber(raw.pressureTokens);
	const projectedTokens = asNumber(raw.projectedTokens);
	const contextWindow = asNumber(raw.contextWindow);
	if (pressureTokens !== undefined) result.pressureTokens = pressureTokens;
	if (projectedTokens !== undefined) result.projectedTokens = projectedTokens;
	if (contextWindow !== undefined) result.contextWindow = contextWindow;
	return Object.keys(result).length > 0 ? result : undefined;
}

/** 由 sessions.list 的 projections.values 恢复 context 构成初值（attach/restart 时）。 */
export function parseContextBreakdownProjection(
	values: unknown,
): { systemTokens: number; toolsTokens: number; messageTokens: number } | undefined {
	if (!isRecord(values)) return undefined;
	const raw = values.contextBreakdown;
	if (!isRecord(raw)) return undefined;
	const systemTokens = asNumber(raw.systemTokens);
	const toolsTokens = asNumber(raw.toolsTokens);
	const messageTokens = asNumber(raw.messageTokens);
	if (systemTokens === undefined && toolsTokens === undefined && messageTokens === undefined) return undefined;
	return {
		systemTokens: systemTokens ?? 0,
		toolsTokens: toolsTokens ?? 0,
		messageTokens: messageTokens ?? 0,
	};
}
