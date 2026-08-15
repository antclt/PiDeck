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
	/** DSH 权限预设（permission/preset 事件最后值，last wins；缺失 = 未记录）。
	 *  值域：read-only / workspace-write / danger-full-access / custom（主机表外组合）。 */
	permissionPreset?: string;
	/** DSH plan 模式是否生效（plan/mode 事件最后值；缺失 = 关闭）。 */
	planModeActive: boolean;
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
	event: { type?: string; seq?: number; seq0?: number; data?: unknown; time?: unknown; time0?: unknown } | undefined,
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
		planModeActive: false,
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
	// 打包行（text-chunks / reasoning-chunks）的序号基准在 seq0（首个成员的 seq）。
	const seq0 = typeof event.seq0 === "number" ? event.seq0 : seq;

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
				next.pendingAssistantId ??= `dsh:${seq0}`;
				next.pendingAssistantText = base.pendingAssistantText + chunk.text;
				next.deltaText = chunk.text;
				next.isStreaming = true;
				next.stateChanged = true;
			} else if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
				next.pendingAssistantId ??= `dsh:${seq0}`;
				next.pendingAssistantThinking = base.pendingAssistantThinking + chunk.text;
				next.deltaReasoning = chunk.text;
				next.isStreaming = true;
				next.stateChanged = true;
			}
			break;
		}
		case "text-chunks":
		case "reasoning-chunks": {
			// 打包行形态（dsh-session packChunkRuns：连续同种 delta 合并成一行，
			// 载荷在 data.texts 数组，逐成员是 token 增量；mux 与 history 都可能出现，
			// 与 assistant/chunk 的 text-delta/reasoning-delta 是同一内容的两种形态，
			// 同一段 run 只会出现其中一种，不会双累积）。
			const texts = Array.isArray(data.texts)
				? data.texts.filter((entry): entry is string => typeof entry === "string")
				: [];
			if (texts.length === 0) break;
			const joined = texts.join("");
			next.pendingAssistantId ??= `dsh:${seq0}`;
			if (type === "text-chunks") {
				next.pendingAssistantText = base.pendingAssistantText + joined;
				next.deltaText = joined;
			} else {
				next.pendingAssistantThinking = base.pendingAssistantThinking + joined;
				next.deltaReasoning = joined;
			}
			next.isStreaming = true;
			next.stateChanged = true;
			break;
		}
		case "assistant/message": {
			// 终态：以组装后的完整内容块为准（delta 可能因适配器差异与终态不完全一致）
			const message = (data.message ?? {}) as { content?: unknown };
			const { text, reasoning } = splitBlocks(message.content);
			const finalText = text.trim() ? text : base.pendingAssistantText;
			// 流式累积兜底：终态 content 缺失 thinking 时用已流式渲染的累积文本
			// （打包行/短 run 差异下终态块可能不含 reasoning）。
			const finalThinking = reasoning.trim() ? reasoning : base.pendingAssistantThinking;
			// 纯工具调用消息（模型只发 tool-call、无正文无思考）不落 assistant 气泡：
			// 否则时间线出现空白 assistant 行，终态由后续 tool/call 卡片承接。
			// 有流式骨架（reasoning/text delta 已渲染）时不在此列——骨架已在时间线
			// 挂载 Live 思考/正文，终态必须更新它而不是丢弃。
			// （splitBlocks 不抽 tool-call 块，text/reasoning 均为空即命中。）
			const hasToolCalls = Array.isArray(message.content) && message.content.some(
				(block) => block !== null && typeof block === "object" && (block as { type?: unknown }).type === "tool-call",
			);
			if (hasToolCalls && !finalText.trim() && !finalThinking.trim() && !base.pendingAssistantId) {
				next.pendingAssistantId = undefined;
				next.pendingAssistantText = "";
				next.pendingAssistantThinking = "";
				next.isStreaming = false;
				next.stateChanged = true;
				break;
			}
			if (base.pendingAssistantId) {
				// 更新流式骨架：同 id 保持 Live→History 不 remount
				// （渲染层 thinking group id = msg-thinking-<消息 id>，id 变化会拆掉重建）。
				const messages = [...base.messages];
				const skeletonIndex = messages.findIndex(
					(candidate) => candidate.id === base.pendingAssistantId && candidate.role === "assistant",
				);
				if (skeletonIndex >= 0) {
					const previous = messages[skeletonIndex];
					messages[skeletonIndex] = {
						id: base.pendingAssistantId,
						agentId,
						role: "assistant",
						text: finalText,
						thinking: finalThinking.trim() ? finalThinking : undefined,
						timestamp: eventTime(event.time),
						stopReason: "stop",
						// 思考耗时：终态时间作为结束点（startedAt 已在骨架创建时记录）
						...((finalThinking.trim() || previous.thinkingStartedAt !== undefined)
							? { thinkingEndedAt: eventTime(event.time) }
							: {}),
						...((previous.thinkingStartedAt !== undefined)
							? { thinkingStartedAt: previous.thinkingStartedAt }
							: {}),
					};
					next.messages = messages;
				} else {
					// 骨架丢失（异常路径）：按终态正常 push，避免消息丢失
					next.messages = [
						...messages,
						{
							id: `dsh:${seq}`,
							agentId,
							role: "assistant",
							text: finalText,
							thinking: finalThinking.trim() ? finalThinking : undefined,
							timestamp: eventTime(event.time),
							stopReason: "stop",
						},
					];
				}
				next.messagesChanged = true;
			} else {
				next.messages = [
					...base.messages,
					{
						id: `dsh:${seq}`,
						agentId,
						role: "assistant",
						text: finalText,
						thinking: finalThinking.trim() ? finalThinking : undefined,
						timestamp: eventTime(event.time),
						stopReason: "stop",
					},
				];
				next.messagesChanged = true;
			}
			next.pendingAssistantId = undefined;
			next.pendingAssistantText = "";
			next.pendingAssistantThinking = "";
			next.isStreaming = false;
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
			const fullText = textFromBlocks(message.content);
			// 工具结果截断展示（渲染层工具卡展开区 2000 字符内），完整文本保留在
			// meta.fullText 供「查看完整输出」按需读取（A3：DSH 会话没有 pi 会话
			// 文件可定位，全文只能随投影消息走内存）。
			const truncated = fullText.length > TOOL_RESULT_MAX_CHARS;
			const text = fullText.slice(0, TOOL_RESULT_MAX_CHARS);
			if (base.executingTool) {
				// 更新最后一条 tool 消息为「工具名 + 结果摘要」，并摘掉 running 状态
				// （工具执行已结束，卡片动画停止；getToolStatus 无 running 即 done）。
				// 耗时 = result 事件时间 - call 事件时间（渲染层工具卡片显示 formatDuration）。
				const messages = [...base.messages];
				const last = messages[messages.length - 1];
				if (last && last.role === "tool") {
					const resultTime = eventTime(event.time);
					const callTime = typeof last.timestamp === "number" ? last.timestamp : resultTime;
					messages[messages.length - 1] = {
						...last,
						text: text ? `${last.text}: ${text}` : last.text,
						meta: last.meta
							? {
								...last.meta,
								status: "done",
								durationMs: Math.max(0, resultTime - callTime),
								// 截断标记与完整文本：渲染层 ToolCard 据此显示「查看完整输出」
								...(truncated ? { truncated: true as const, fullText } : {}),
							}
							: last.meta,
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
			// 中断/异常收口：无 assistant/message 终态时（如被停止/出错），把流式累积
			// 写回骨架——已渲染的思考/正文不因 turn/end 清 pending 而丢失。
			if (base.pendingAssistantId && (base.pendingAssistantText || base.pendingAssistantThinking)) {
				const messages = [...base.messages];
				const skeletonIndex = messages.findIndex(
					(candidate) => candidate.id === base.pendingAssistantId && candidate.role === "assistant",
				);
				if (skeletonIndex >= 0) {
					const previous = messages[skeletonIndex];
					messages[skeletonIndex] = {
						...previous,
						text: base.pendingAssistantText,
						thinking: base.pendingAssistantThinking.trim() ? base.pendingAssistantThinking : undefined,
						// 思考结束时间 = turn/end 时间（startedAt 已在骨架创建时记录）
						...(base.pendingAssistantThinking.trim() ? { thinkingEndedAt: eventTime(event.time) } : {}),
					};
					next.messages = messages;
					next.messagesChanged = true;
				}
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
		case "permission/preset": {
			// DSH 权限预设切换（/permission 命令或创建时 pin）：last wins。
			// 会话底栏据此显示当前预设（read-only/workspace-write/danger-full-access）。
			const preset = typeof data.preset === "string" ? data.preset.trim() : "";
			if (preset && preset !== base.permissionPreset) {
				next.permissionPreset = preset;
				next.stateChanged = true;
			}
			break;
		}
		case "plan/mode": {
			// DSH plan 模式开关（/plan 命令）：last wins；选中态可能延迟到下一次
			// 被接受的 pre-step 才落盘（dsh-plan-mode 语义：idle 立即、回合中 pending）。
			const active = data.active === true;
			if (active !== base.planModeActive) {
				next.planModeActive = active;
				next.stateChanged = true;
			}
			break;
		}
		default:
			break;
	}
	// 流式骨架（Live 挂载点）：首个正文/思考增量出现时，把 pendingAssistant 以空文本
	// 骨架消息入列。渲染层 buildTurnDisplay 对空文本 assistant 生成 interim-answer
	// 挂载点，Live 思考（msg-thinking-<骨架 id>）与 Live 正文（会话级流式槽）都挂它；
	// 终态 assistant/message 再原位更新为完整内容（同 id，不 remount）。
	// 无骨架时渲染层没有可挂的 assistant 条目——思考/正文只能等终态一次性出现
	// （表现为「思考/中间回答不渲染，等十几秒直接显示最后回答」）。
	if (next.pendingAssistantId && !base.pendingAssistantId && !next.messagesChanged) {
		// 思考开始时间 = 首个增量时间（思考块耗时 endedAt - startedAt）。
		// 纯正文回合该字段无害（无 thinking 就不渲染思考块）；live 阶段主进程
		// 发的 startedAt 优先（atom），终态回退到消息字段。
		next.messages = [
			...base.messages,
			{
				id: next.pendingAssistantId,
				agentId,
				role: "assistant",
				text: "",
				timestamp: eventTime(event.time),
				stopReason: "pending",
				thinkingStartedAt: eventTime(event.time),
			},
		];
		next.messagesChanged = true;
	}
	return next;
}

function eventTime(time: unknown): number {
	return typeof time === "number" ? time : Date.now();
}
