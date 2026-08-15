import type { SessionEnvironment, SessionSource } from "./session";

export type AgentStatus = "starting" | "idle" | "running" | "error" | "closed";

/**
 * 运行时后端：pi（stdio JSON-RPC，现有）或 dsh（DeepSeek Harness，无 web 内嵌形态）。
 * 与 `SessionSource`（历史导入来源）是两个维度：source 描述会话文件从哪来，
 * backend 描述会话由哪个引擎驱动。缺省视为 "pi"，旧数据天然兼容。
 */
export type AgentBackend = "pi" | "dsh";

/**
 * 后端可选能力（核心接口方法之外的可选扩展）。
 * 能力缺失的后端必须显式声明不持有，UI 按能力禁用入口，禁止硬造等价物。
 */
export type AgentGatewayCapability =
	| "compact" // 手动压缩
	| "fork" // 从消息 fork 新会话
	| "getForkMessages" // fork 前置的消息列表
	| "editMessage" // 编辑历史消息
	| "deleteMessage" // 删除历史消息
	| "getCommands" // 会话内命令列表
	| "exportHtml"; // 导出 HTML

export type AgentTab = {
	id: string;
	projectId: string;
	cwd: string;
	title: string;
	status: AgentStatus;
	sessionId?: string;
	/** PiDeck 会话身份（与 CreateAgentInput.deckSessionId 同源），用于安全门 PIDECK_SESSION_ID 注入。 */
	deckSessionId?: string;
	sessionPath?: string;
	/** Identity used only for session/runtime matching; agentId remains the process handle. */
	sessionEnvironment?: SessionEnvironment;
	sessionSource?: SessionSource;
	/** 运行时后端；缺省 "pi"（旧数据/旧路径兼容）。 */
	backend?: AgentBackend;
	wslDistro?: string;
	wslUser?: string;
	importedSourceId?: string;
	noSession?: boolean;
	/** Monotonic binding generation assigned by SessionRuntimeCoordinator. */
	runtimeGeneration?: number;
	createdAt: number;
	/** 会话累计压缩次数，由主进程解析会话文件得到，用于前端展示“已压缩 N 次”。 */
	compactionCount?: number;
};

export type AgentRuntimeState = {
	modelName?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	/** DSH 会话当前权限预设（read-only / workspace-write / danger-full-access / custom）；
	 *  pi 后端无此概念。 */
	permissionPreset?: string;
	/** DSH 会话 plan 模式是否生效（/plan 命令，可能延迟到下一条消息的步骤生效）。 */
	planModeActive?: boolean;
	isStreaming?: boolean;
	isCompacting?: boolean;
	/** 是否正在执行工具调用（read/write/bash 等） */
	isExecutingTool?: boolean;
	/** 当前正在执行的工具名称，如 read、write、bash */
	executingToolName?: string;
	/** 工具状态事件的单调序号，用于忽略晚到的异步完整状态。 */
	toolStateSequence?: number;
	contextTokens?: number | null;
	contextWindow?: number | null;
	contextPercent?: number | null;
	inputTokens?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cacheTotal?: number;
	cacheHitPercent?: number | null;
	/** 当前会话平均缓存命中率：会话文件全部 assistant 消息 usage 的算术平均 */
	cacheHitAveragePercent?: number | null;
	/** 参与平均统计的 assistant 消息条数（与 cacheHitAveragePercent 同源） */
	cacheHitSampleCount?: number;
	cost?: number;
	/** 最近一次 assistant 回复的首 token 延迟（ms；message_start → 首个 text/thinking delta），由主进程本地计时 */
	ttftMs?: number;
	/** 最近一次 assistant 回复的总耗时（ms；message_start → message_end/done/error） */
	totalMs?: number;
	/** 最近一次 assistant 回复的生成速度（tokens/s；output tokens ÷ 生成期时长） */
	tps?: number;
	/** 性能指标结算时刻（Date.now()），渲染层据此判断是否为近期数据 */
	perfAt?: number;
};

export type AvailableModel = {
	id: string;
	name?: string;
	provider: string;
	/** 上下文窗口（token 数，来自 pi --list-models context 列） */
	contextWindow?: number;
	/** 单次输出上限（token 数，来自 max-out 列） */
	maxTokens?: number;
	reasoning?: boolean;
	/** 是否支持图片输入（来自 images 列；undefined = pi 未提供该列） */
	images?: boolean;
	/** 该模型支持的思考档位（DSH models catalog 的 reasoning.efforts；
	 *  选择器按它过滤档位——DSH deepseek 适配器只接受 off/high/max，
	 *  pi-ai provider 按模型声明，选不支持的档位会在下次请求抛 UNSUPPORTED_REASONING_EFFORT）。 */
	reasoningEfforts?: Array<{ id: string; name?: string; description?: string }>;
};

export type CreateAgentInput = {
	projectId: string;
	title?: string;
	sessionPath?: string;
	/** 运行时后端；缺省走当前装配的默认后端（pi），旧调用方无需改动。 */
	backend?: AgentBackend;
	/** DSH 会话身份（DSH host 的 sessionId）：backend=dsh 且已持久化时，attach 旧会话而非新建。 */
	dshSessionId?: string;
	/**
	 * PiDeck 会话身份（SessionRecord.id，可能为 UUID 或会话文件路径）。
	 * 会话级安全覆盖（SecurityStore.sessionOverrides）与 PIDECK_SESSION_ID 注入都使用这个 key；
	 * 与 pi 进程自身的 sessionId（AgentTab.sessionId / piSessionId）语义不同，不可混用。
	 */
	deckSessionId?: string;
	environment?: SessionEnvironment;
	source?: SessionSource;
	wslDistro?: string;
	wslUser?: string;
	importedSourceId?: string;
	noSession?: boolean;
};

export type AgentUiResponse = {
	value?: string | boolean;
	cancelled?: boolean;
	confirmed?: boolean;
};

export type AgentUiBatchQuestion = {
	id: string;
	type: "select" | "confirm" | "input" | "editor";
	question: string;
	options?: Array<string | { label: string; value?: string; description?: string }>;
	allowOther?: boolean;
	placeholder?: string;
	prefill?: string;
};

export type AgentUiRequest = {
	agentId: string;
	requestId: string;
	method: string;
	title: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	allowOther?: boolean;
	completed?: boolean;
	value?: string | boolean;
	confirmed?: boolean;
	cancelled?: boolean;
	message?: string;
	notifyType?: "info" | "warning" | "error";
	text?: string;
	widgetKey?: string;
	widgetLines?: string[];
	widgetPlacement?: "aboveEditor" | "belowEditor";
	/** A batched ask_question envelope rendered as tabs in the session timeline footer. */
	batchQuestions?: AgentUiBatchQuestion[];
	batchReview?: boolean;
};

/** 实时思考内容更新，用于流式展示模型推理过程。
 *  id 与 History 的 thinking-group id 相同（msg-thinking-${assistantMessageId}），
 *  保证 Live→History 不 remount。 */
export type ThinkingUpdate = {
	agentId: string;
	/** 稳定段 id：与 buildTurnDisplay 的 msg-thinking-* 一致 */
	id: string;
	/** 累积的思考文本 */
	text: string;
	startedAt: number;
	/** 0 表示仍在流式思考中 */
	endedAt: number;
	/** true：本段结束，渲染层可清 live 通道并回退到 History */
	done: boolean;
};

/** 输入框发送模式，决定消息直接执行还是以只读方式触发生成计划。 */
export type ComposerAgentMode = "normal" | "plan" | "imagegen";
