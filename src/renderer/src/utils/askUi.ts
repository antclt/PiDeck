import type { AgentUiRequest, AgentUiResponse } from "../../../shared/types";

/**
 * Ask 提问 UI 的纯逻辑（与渲染解耦，便于单测与 E2E 断言）。
 * 对应 SessionRuntimeUiOverlay / BatchAskInlineBar 的决策与应答构造。
 */

export type AskRequestEntry = {
	status: string;
	request: AgentUiRequest;
};

/**
 * 从全部请求中选择当前应展示的一个。
 * 规则：只取 pending/responding 的请求，多个并存时展示**最新到达**的——
 * 否则 Plan 模式的 select 若一直挂着，后续真正需要用户回答的 ask 会被遮蔽。
 */
export function pickActiveAskRequest(
	entries: Readonly<Record<string, AskRequestEntry>> | undefined,
): AgentUiRequest | undefined {
	if (!entries) return undefined;
	const active = Object.values(entries).filter(
		(entry) => entry.status === "pending" || entry.status === "responding",
	);
	return active[active.length - 1]?.request;
}

/** select 的选项是否可点击（有选项时才渲染选项按钮） */
export function hasSelectableOptions(request: AgentUiRequest | undefined): boolean {
	return Boolean(
		request?.method === "select" &&
		request.options &&
		request.options.length > 0,
	);
}

/**
 * 归类 ask 卡片的终态（供卡片决定是否继续渲染交互区）：
 * - answered：明确收到回答且未取消
 * - cancelled：已取消或出错（error 视为取消，避免残留可交互输入误导用户）
 * - waiting：仍在等待用户响应
 * cancelled 由调用方从 response 推导（answered 状态但 response.cancelled=true 视为取消）。
 */
export function classifyAskCardStatus(
	status: string | undefined,
	cancelled: boolean,
): "waiting" | "answered" | "cancelled" {
	const normalized = status ?? "pending";
	if (normalized === "answered" && !cancelled) return "answered";
	if (normalized === "cancelled" || normalized === "error") return "cancelled";
	return "waiting";
}

/**
 * 构造 4 种提问方式的回答 payload（与 pi extension_ui_response 协议一致）：
 * - select/input/editor → { value }
 * - confirm → { confirmed, value }
 * - 取消 → { cancelled: true }
 */
export function buildAskResponse(
	method: string,
	value: string | boolean | undefined,
	options?: { confirmed?: boolean; cancelled?: boolean },
): AgentUiResponse {
	if (options?.cancelled) return { cancelled: true };
	if (method === "confirm") {
		const confirmed = options?.confirmed ?? Boolean(value);
		return { confirmed, value: confirmed };
	}
	return { value: value ?? "" };
}

export type BatchAnswerValue = string | boolean | null | undefined;

/** 与原有 batchAnswerLabel 一致：布尔转 true/false 文案，其余原样 */
export function batchAnswerLabel(value: BatchAnswerValue): string {
	if (typeof value === "boolean") return value ? "true" : "false";
	return value ?? "";
}

/**
 * 序列化批量提问的答案（BatchAskInlineBar 提交给主进程的 envelope 格式）。
 * 主进程收到后原样作为 input 答案返回给 pi 扩展。
 * meta 提供每个问题的展示 label 与自定义标记（可选）。
 */
export function serializeBatchAnswers(
	questions: ReadonlyArray<{ id: string; type: string }>,
	answers: Readonly<Record<string, BatchAnswerValue>>,
	meta?: Readonly<Record<string, { label?: string; wasCustom?: boolean }>>,
): string {
	const result = questions.map((question) => {
		const value = answers[question.id] ?? null;
		const itemMeta = meta?.[question.id];
		return {
			id: question.id,
			type: question.type,
			value,
			label: itemMeta?.label ?? batchAnswerLabel(value),
			wasCustom: Boolean(itemMeta?.wasCustom),
		};
	});
	return JSON.stringify({ answers: result });
}
