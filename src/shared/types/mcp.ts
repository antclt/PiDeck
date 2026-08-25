/**
 * pi-mcp-adapter 配置契约（只描述 mcp.json，不复刻 adapter 运行时）。
 * 适配器按层合并 mcpServers；PiDeck 只读写 Pi 拥有的 `~/.pi/agent/mcp.json`，
 * 其它层只读展示，避免改坏 Cursor/Claude 等宿主文件。
 */

/** stdio / HTTP / Unix socket 三选一；与 adapter 字段互斥规则一致。 */
export type McpServerTransport = "stdio" | "http" | "socket";

export type McpServerLifecycle = "lazy" | "eager" | "keep-alive" | "lazy-keep-alive";

export type McpServerAuth = "bearer" | "oauth";

/**
 * 单条 MCP server 定义：只建模配置页会编辑的常用字段，
 * 其余 adapter 扩展字段经 index signature 原样 round-trip，避免保存时丢掉。
 */
export type McpServerDefinition = {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	socket?: string;
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

export type McpConfigLayerKind =
	| "user-config"
	| "agents"
	| "agents-dir"
	| "pi-agent"
	| "project"
	| "project-pi";

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
