/**
 * mcp.json 配置契约（只描述文件形状，不复刻 pi 的 MCP 运行时）。
 * pi 0.99 起 MCP 由内置扩展提供，读取同一份 `~/.pi/agent/mcp.json`；
 * 2026-09 之前靠 pi-mcp-adapter 扩展时写的 legacy 字段（lifecycle/directTools 等）
 * 仍保留在类型里做 round-trip，保存时不丢，但 pi 0.99 已不再识别。
 * PiDeck 只读写 Pi 拥有的 `~/.pi/agent/mcp.json`，其它层只读展示。
 */

/** stdio / HTTP / Unix socket 三选一；socket 仅 pi-mcp-adapter 时代识别。 */
export type McpServerTransport = "stdio" | "http" | "socket";

export type McpServerLifecycle = "lazy" | "eager" | "keep-alive" | "lazy-keep-alive";

export type McpServerAuth = "bearer" | "oauth";

/**
 * pi 0.99 内置 MCP 的工具暴露方式（exposure 取值）：
 * - codemode：仅 codemode 脚本可调用，工具名与描述并列在脚本说明里（默认）
 * - codemode-deferred：codemode 脚本用 searchTools 查找后调用
 * - deferred：模型经 tool_search 加载后直接调用
 * - direct：像普通工具一样直接声明给模型
 * - hidden：注册但模型不可见（仅手动/调试用途）
 */
export type McpExposure = "codemode" | "codemode-deferred" | "deferred" | "direct" | "hidden";

/**
 * 单条 MCP server 定义：pi 0.99 内置 MCP schema（exposure/toolExposure/enabled/timeout）
 * 与 adapter legacy 字段并存；未知字段经 index signature 原样 round-trip，避免保存时丢掉。
 */
export type McpServerDefinition = {
	// ---- pi 0.99 内置 MCP 字段 ----
	/** 整个 server 的默认工具暴露方式（默认 codemode）。 */
	exposure?: McpExposure;
	/** 按工具名/`*` 模式覆盖暴露方式；精确名优先于模式，对象顺序取首个匹配。 */
	toolExposure?: Record<string, McpExposure>;
	/** false = 保留条目但不连接（默认 true）。 */
	enabled?: boolean;
	/** 单次工具调用超时（秒），默认 60；进度通知会重置计时。 */
	timeout?: number;
	// ---- 传输定义 ----
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	socket?: string;
	// ---- adapter legacy（pi 0.99 起不再识别，round-trip 保留）----
	auth?: McpServerAuth;
	bearerToken?: string;
	bearerTokenEnv?: string;
	lifecycle?: McpServerLifecycle;
	idleTimeout?: number;
	requestTimeoutMs?: number;
	disabled?: boolean;
	directTools?: boolean | string[];
	[key: string]: unknown;
};

export type McpConfigFile = {
	mcpServers?: Record<string, McpServerDefinition>;
	settings?: Record<string, unknown>;
	[key: string]: unknown;
};

export type McpConfigLayerKind = "user-config" | "agents" | "agents-dir" | "pi-agent" | "project" | "project-pi";

export type McpConfigLayer = {
	kind: McpConfigLayerKind;
	path: string;
	exists: boolean;
	writable: boolean;
};

export type McpServerListItem = {
	name: string;
	definition: McpServerDefinition;
	/** 首次给出 command/url/socket 的层路径（来源文件）。 */
	originPath: string;
	/** 最后一次覆盖该名字的层路径。 */
	overridePath: string;
	/** 传输定义来自 Pi 可写文件（删条目才会从合并结果里消失；否则只能写 disabled 覆盖）。 */
	ownedByWritable: boolean;
};

export type McpConfigSnapshot = {
	writablePath: string;
	writableFile: McpConfigFile;
	/** 可写层原文，源文件页编辑 mcp.json 用；文件不存在时为空对象格式化文本。 */
	writableRaw: string;
	/** 可写层 JSON 损坏时给出诊断；此时禁止可视化保存，避免空对象覆盖原文件。 */
	writableError?: string;
	layers: McpConfigLayer[];
	servers: McpServerListItem[];
};

export type McpProbeOk = {
	ok: true;
	transport: McpServerTransport;
	detail: string;
};

export type McpProbeFail = {
	ok: false;
	transport?: McpServerTransport;
	error: string;
};

export type McpProbeResult = McpProbeOk | McpProbeFail;
