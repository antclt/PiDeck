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
 * 解码扩展为桌面端约定的「标题|说明」选项。
 * Plan Mode 用这个轻量协议给“开始执行/先不执行”补充说明；
 * 普通 ask 选项没有分隔符时保持原文，避免误拆用户输入中的竖线。
 */
export function splitAskOption(option: string): { label: string; description?: string } {
	const pipeSeparator = option.indexOf("|");
	if (pipeSeparator > 0) {
		const label = option.slice(0, pipeSeparator).trim();
		const description = option.slice(pipeSeparator + 1).trim();
		return description ? { label, description } : { label };
	}

	// 普通 ask_question 扩展会用「标题 — 说明」把对象选项压成 RPC 字符串；
	// 只接受两侧都有空白的长横线，避免误拆用户输入中的普通连字符。
	const dashMatch = option.match(/^(.+?)\s+—\s+(.+)$/u);
	if (dashMatch) {
		const [, label, description] = dashMatch;
		return { label: label.trim(), description: description.trim() };
	}
	return { label: option };
}

/**
 * 安全确认请求的标题前缀（与扩展 resources/extensions/pi-deck-security-gate.ts 一致）。
 * 前缀后跟 JSON 负载 {tool, level, detail}。
 */
export const SECURITY_CONFIRM_MARKER = "[PI_DECK_SECURITY_CONFIRM]";

/** 安全确认请求的结构化字段（解析自标题 JSON 负载）。 */
export type SecurityConfirmInfo = {
	tool: string;
	level: string;
	detail: string;
};

/**
 * 解析安全确认请求标题；非安全确认返回 null。
 * JSON 损坏时兑底返回原始负载文本（tool/level 为空），避免解析失败让确认卡消失。
 */
export function parseSecurityConfirmTitle(title: string): SecurityConfirmInfo | null {
	const raw = title.trim();
	if (!raw.startsWith(SECURITY_CONFIRM_MARKER)) return null;
	const payloadText = raw.slice(SECURITY_CONFIRM_MARKER.length).trim();
	try {
		const parsed = JSON.parse(payloadText) as Record<string, unknown>;
		return {
			tool: typeof parsed.tool === "string" ? parsed.tool : "",
			level: typeof parsed.level === "string" ? parsed.level : "",
			detail: typeof parsed.detail === "string" ? parsed.detail : "",
		};
	} catch {
		return { tool: "", level: "", detail: payloadText };
	}
}

/**
 * 安全确认请求的人类可读摘要（通知/Web/历史兑底用；纯逻辑不依赖 i18n）。
 * 安全门扩展自身用中文文案，这里保持与之一致。
 */
export function formatSecurityConfirmSummary(info: SecurityConfirmInfo): string {
	return info.tool ? `安全确认：${info.tool}` : "安全确认";
}

/**
 * 移除 Plan Mode / 安全确认给桌面端识别用的内部标题标记，兑底为人类可读内容。
 * - Plan Mode：[PI_DECK_PLAN_NEXT] 前缀剥掉，保留后面的计划内容；
 * - 安全确认：[PI_DECK_SECURITY_CONFIRM] + JSON 负载，换成「安全确认：<工具>」摘要。
 */
export function formatAskTitle(title: string): string {
	const trimmed = title.trim();
	if (trimmed.startsWith("[PI_DECK_PLAN_NEXT]")) {
		return trimmed.slice("[PI_DECK_PLAN_NEXT]".length).trim();
	}
	const security = parseSecurityConfirmTitle(trimmed);
	if (security) return formatSecurityConfirmSummary(security);
	return trimmed;
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

/**
 * 页面上是否有未折叠的划选文本。
 * 选项 / 允许 / 拒绝是 `<button>`：划选结束后 mouseup 落在按钮上会冒充 click，误答提问。
 * 提交前若检测到划选则跳过，让用户先完成复制。
 * 不复用 messageSelection.ts：那是消息树多选，不是 window 划选探测。
 * input/textarea 内的选区走 selectionStart，不会进入 window.getSelection，故键盘 Enter 提交不受影响。
 */
export function hasTextSelection(): boolean {
	if (typeof window === "undefined") return false;
	return Boolean(window.getSelection()?.toString().trim());
}
