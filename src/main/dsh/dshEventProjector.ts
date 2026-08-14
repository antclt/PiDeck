import type { ChatMessage } from "../../shared/types";

/**
 * DSH SessionEvent → PiDeck ChatMessage 投影（纯函数，无副作用，可单测）。
 *
 * 事件形状（PoC 实测）：SessionEvent = { type, seq, time, data }，正文在 data：
 * - user/message.data.content[]：内容块（{type:'text', text}）
 * - assistant/chunk.data.chunk：StreamChunk delta（text-delta / reasoning-delta / finish）
 * - assistant/message.data.message.content[]：组装后的完整内容块（终态权威）
 * - tool/call.data / tool/result.data：工具调用与结果
 * - turn/start / turn/end.data.reason：回合边界；reason.kind === 'error' 表示失败
 *
 * 设计约束：
 * - 消息 id 用事件 seq（稳定、可去重）；assistant 终态消息以 assistant/message 为准，
 *   delta 只用于流式提示（deltaText/deltaReasoning 信号）。
 * - 投影器不持 agentId；消息归属由调用方（DshAgentManager）传入。
 */
export type DshProjection = {
	messages: ChatMessage[];
	/** 累积中的 assistant 消息（流式 delta 期间存在；终态后清空）。 */
	pendingAssistantId?: string;
	pendingAssistantText: string;
	pendingAssistantThinking: string;
	/** 最近一次工具调用的名称（执行中）。 */
	executingTool?: string;
	isStreaming: boolean;
	model?: { provider: string; model: string };
	/** 本条事件的增量信号（供调用方逐帧转发）。 */
	deltaText?: string;
	deltaReasoning?: string;
	/** 本条事件是否改变状态（调用方据此推 runtime-state）。 */
	stateChanged: boolean;
	/** 本条事件是否为回合结束。 */
	turnEnded: boolean;
	/** 本条事件是否改变消息数组（调用方据此 flush）。 */
	messagesChanged: boolean;
};

const TOOL_RESULT_MAX_CHARS = 2000;

/** 运行时收窄：仅当值是对象且非数组时返回（用于可选字段的安全读取）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 按类型拆分内容块：text 与 reasoning 分开提取（两者不能混在同一条正文里）。 */
function splitBlocks(blocks: unknown): { text: string; reasoning: string } {
	if (!Array.isArray(blocks)) return { text: "", reasoning: "" };
	let text = "";
	let reasoning = "";
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const value = block as { type?: unknown; text?: unknown; reasoning?: unknown };
		if (value.type === "text" && typeof value.text === "string") text += value.text;
		if (value.type === "reasoning" && typeof value.reasoning === "string") reasoning += value.reasoning;
	}
	return { text, reasoning };
}

function textFromBlocks(blocks: unknown): string {
	return splitBlocks(blocks).text;
}

/** 归一化模型路由（request/context.data.provider + model）。 */
function modelFromEvent(event: { data?: unknown }): { provider: string; model: string } | undefined {
	const data = (event.data ?? {}) as { provider?: unknown; model?: unknown };
	if (typeof data.provider === "string" && typeof data.model === "string") {
		return { provider: data.provider, model: data.model };
	}
	return undefined;
}

export function projectDshEvent(
	prev: DshProjection | undefined,
	event: { type?: string; seq?: number; data?: unknown; time?: unknown } | undefined,
	agentId: string,
	/** host 为事件计算的下发 view（session/event 帧与 history 条目的 view 字段，
	 *  dsh-web 渲染工具卡片用的就是它；对 tool/call 投影进 meta.view）。 */
	view?: unknown,
): DshProjection {
	const base: DshProjection = prev ?? {
		messages: [],
		pendingAssistantText: "",
		pendingAssistantThinking: "",
		isStreaming: false,
		stateChanged: false,
		turnEnded: false,
		messagesChanged: false,
	};
	if (!event) return { ...base, deltaText: undefined, deltaReasoning: undefined };
	const next: DshProjection = {
		...base,
		messages: base.messages,
		deltaText: undefined,
		deltaReasoning: undefined,
		stateChanged: false,
		turnEnded: false,
		messagesChanged: false,
	};
	const type = event.type ?? "?";
	const data = (event.data ?? {}) as Record<string, unknown>;
	const seq = typeof event.seq === "number" ? event.seq : 0;

	switch (type) {
		case "user/message": {
			// DSH 会话模型把工作区上下文（AGENTS.md、runtime context、skills 清单等）也作为
			// user/message 注入会话日志，source.kind 区分：真实用户消息 = "user"（带 rpcId 对账），
			// 系统注入 = "agent-instructions"/"plugin" 等。注入上下文对用户无阅读价值且会造成
			// 「发一条消息冒出多条用户消息」的错觉，不投影进时间线；source 缺失时保守按真实
			// 用户消息投影（pre-react-loop 迁移的历史数据无 source 字段，不能丢消息）。
			const sourceKind = isRecord(data.source) ? data.source.kind : undefined;
			if (sourceKind !== undefined && sourceKind !== "user") break;
			const text = textFromBlocks(data.content);
			next.messages = [
				...base.messages,
				{
					id: `dsh:${seq}`,
					agentId,
					role: "user",
					text,
					timestamp: eventTime(event.time),
				},
			];
			next.messagesChanged = true;
			break;
		}
		case "assistant/chunk": {
			const chunk = (data.chunk ?? {}) as { type?: string; text?: unknown };
			if (chunk.type === "text-delta" && typeof chunk.text === "string") {
				next.pendingAssistantId ??= `dsh:${seq}`;
				next.pendingAssistantText = base.pendingAssistantText + chunk.text;
				next.deltaText = chunk.text;
				next.isStreaming = true;
				next.stateChanged = true;
			} else if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
				next.pendingAssistantThinking = base.pendingAssistantThinking + chunk.text;
				next.deltaReasoning = chunk.text;
			}
			break;
		}
		case "assistant/message": {
			// 终态：以组装后的完整内容块为准（delta 可能因适配器差异与终态不完全一致）
			const message = (data.message ?? {}) as { content?: unknown };
			const { text, reasoning } = splitBlocks(message.content);
			const finalText = text.trim() ? text : base.pendingAssistantText;
			// 纯工具调用消息（模型只发 tool-call、无正文无思考）不落 assistant 气泡：
			// 否则时间线出现空白 assistant 行，终态由后续 tool/call 卡片承接。
			// （splitBlocks 不抽 tool-call 块，text/reasoning 均为空即命中。）
			const hasToolCalls = Array.isArray(message.content) && message.content.some(
				(block) => block !== null && typeof block === "object" && (block as { type?: unknown }).type === "tool-call",
			);
			if (hasToolCalls && !finalText.trim() && !reasoning.trim()) {
				next.pendingAssistantId = undefined;
				next.pendingAssistantText = "";
				next.pendingAssistantThinking = "";
				next.isStreaming = false;
				next.stateChanged = true;
				break;
			}
			next.messages = [
				...base.messages,
				{
					id: `dsh:${seq}`,
					agentId,
					role: "assistant",
					text: finalText,
					thinking: reasoning.trim() ? reasoning : undefined,
					timestamp: eventTime(event.time),
					stopReason: "stop",
				},
			];
			next.pendingAssistantId = undefined;
			next.pendingAssistantText = "";
			next.pendingAssistantThinking = "";
			next.isStreaming = false;
			next.messagesChanged = true;
			next.stateChanged = true;
			break;
		}
		case "tool/call": {
			const toolName = typeof data.toolName === "string"
				? data.toolName
				: typeof data.name === "string"
					? data.name
					: "tool";
			const callId = typeof data.callId === "string" ? data.callId : undefined;
			// DSH 的 arguments 是 JSON 字符串（模型调用侧约定，host 侧 presentCall 也
			// JSON.parse 后消费）。解析成对象投影进 meta.args——PiDeck 工具卡片的
			// 副标题（command/path/pattern/query/url）、详情、文件 diff 与 SKILL 识别
			// 全部读 meta.args；解析失败时保留原始字符串（渲染层 parseToolArgs 双兼容）。
			const rawArgs = data.arguments;
			let args: unknown;
			if (typeof rawArgs === "string") {
				try {
					args = JSON.parse(rawArgs);
				} catch {
					args = rawArgs;
				}
			} else {
				args = rawArgs;
			}
			next.messages = [
				...base.messages,
				{
					id: `dsh:${seq}`,
					agentId,
					role: "tool",
					text: toolName,
					timestamp: eventTime(event.time),
					// status=running 驱动渲染层工具卡片的旋转动画；tool/result 到达后清掉。
					meta: {
						toolCallId: callId,
						toolName,
						status: "running",
						...(args !== undefined ? { args } : {}),
						...(view !== undefined ? { view } : {}),
					},
				},
			];
			next.executingTool = toolName;
			next.messagesChanged = true;
			next.stateChanged = true;
			break;
		}
		case "tool/result": {
			const message = (data.message ?? {}) as { content?: unknown };
			const text = textFromBlocks(message.content).slice(0, TOOL_RESULT_MAX_CHARS);
			if (base.executingTool) {
				// 更新最后一条 tool 消息为「工具名 + 结果摘要」，并摘掉 running 状态
				// （工具执行已结束，卡片动画停止；getToolStatus 无 running 即 done）。
				const messages = [...base.messages];
				const last = messages[messages.length - 1];
				if (last && last.role === "tool") {
					messages[messages.length - 1] = {
						...last,
						text: text ? `${last.text}: ${text}` : last.text,
						meta: last.meta ? { ...last.meta, status: "done" } : last.meta,
					};
					next.messages = messages;
					next.messagesChanged = true;
				}
			}
			next.executingTool = undefined;
			next.stateChanged = true;
			break;
		}
		case "turn/start": {
			next.isStreaming = true;
			next.stateChanged = true;
			break;
		}
		case "turn/end": {
			const reason = (data.reason ?? {}) as { kind?: string; error?: { message?: string } };
			if (reason.kind === "error" && reason.error?.message) {
				next.messages = [
					...base.messages,
					{
						id: `dsh:${seq}`,
						agentId,
						role: "error",
						text: reason.error.message,
						timestamp: eventTime(event.time),
					},
				];
				next.messagesChanged = true;
			}
			next.pendingAssistantId = undefined;
			next.pendingAssistantText = "";
			next.pendingAssistantThinking = "";
			next.isStreaming = false;
			next.turnEnded = true;
			next.stateChanged = true;
			break;
		}
		case "request/context": {
			const model = modelFromEvent(event);
			if (model) {
				next.model = model;
				next.stateChanged = true;
			}
			break;
		}
		default:
			break;
	}
	return next;
}

function eventTime(time: unknown): number {
	return typeof time === "number" ? time : Date.now();
}
