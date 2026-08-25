/**
 * pi-mcp-adapter 的 mcp.json 合并、校验与轻量探测。
 * 不启动 MCP SDK / 不 spawn 用户 command：探测只检查命令是否在 PATH、HTTP URL 是否可达。
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import type {
	McpConfigFile,
	McpConfigLayer,
	McpConfigLayerKind,
	McpConfigSnapshot,
	McpProbeResult,
	McpServerDefinition,
	McpServerListItem,
	McpServerTransport,
} from "../../shared/types/mcp";

const MCP_DOCS_URL = "https://nicobailon-pi-mcp-adapter.mintlify.app/configuration/server-setup";
const HTTP_PROBE_TIMEOUT_MS = 8_000;
const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const LAYER_KIND_ORDER: McpConfigLayerKind[] = [
	"user-config",
	"agents",
	"agents-dir",
	"pi-agent",
	"project",
	"project-pi",
];

export function mcpDocsUrl(): string {
	return MCP_DOCS_URL;
}

/** `~/.pi/agent` → 用户 home；WSL 场景传入 windowsHome 映射后的 configDir。 */
export function homeFromPiAgentDir(configDir: string): string {
	const trimmed = configDir.replace(/[\\/]+$/, "");
	const piDir = trimmed.replace(/[\\/]+agent$/i, "");
	const home = piDir.replace(/[\\/]+\.pi$/i, "");
	return home || homedir();
}

export function mcpLayerPaths(home: string, piAgentDir: string, projectPath?: string): McpConfigLayer[] {
	const layers: McpConfigLayer[] = [
		{ kind: "user-config", path: join(home, ".config", "mcp", "mcp.json"), exists: false, writable: false },
		{ kind: "agents", path: join(home, ".agents", "mcp.json"), exists: false, writable: false },
		{ kind: "agents-dir", path: join(home, ".agents", "mcp", "mcp.json"), exists: false, writable: false },
		{ kind: "pi-agent", path: join(piAgentDir, "mcp.json"), exists: false, writable: true },
	];
	if (projectPath?.trim()) {
		const root = projectPath.trim();
		layers.push(
			{ kind: "project", path: join(root, ".mcp.json"), exists: false, writable: false },
			{ kind: "project-pi", path: join(root, ".pi", "mcp.json"), exists: false, writable: false },
		);
	}
	return layers;
}

export function isMcpServerName(name: string): boolean {
	const trimmed = name.trim();
	return trimmed.length > 0 && trimmed.length <= 64 && !/[\\/]/.test(trimmed) && SERVER_NAME_RE.test(trimmed);
}

export function inferMcpTransport(def: McpServerDefinition): McpServerTransport | null {
	const hasCommand = typeof def.command === "string" && def.command.trim().length > 0;
	const hasUrl = typeof def.url === "string" && def.url.trim().length > 0;
	const hasSocket = typeof def.socket === "string" && def.socket.trim().length > 0;
	const count = Number(hasCommand) + Number(hasUrl) + Number(hasSocket);
	if (count !== 1) return null;
	if (hasCommand) return "stdio";
	if (hasUrl) return "http";
	return "socket";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseMcpConfigFile(raw: string): { file: McpConfigFile; error?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (error) {
		return { file: { mcpServers: {} }, error: error instanceof Error ? error.message : String(error) };
	}
	if (!isPlainObject(parsed)) {
		return { file: { mcpServers: {} }, error: "mcp.json must be a JSON object" };
	}
	const mcpServers = parsed.mcpServers;
	if (mcpServers !== undefined && !isPlainObject(mcpServers)) {
		return { file: { mcpServers: {} }, error: "mcpServers must be an object" };
	}
	return { file: parsed as McpConfigFile };
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
	if (!isPlainObject(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string") out[key] = item;
	}
	return out;
}

/** 浅合并时丢掉 undefined，避免 `{ disabled: true }` 把下层 command/url 冲成空。 */
function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) (out as Record<string, unknown>)[key] = item;
	}
	return out;
}

/** 收窄未知 JSON 为定义；非法字段丢掉，扩展字段经 rest 保留。 */
export function normalizeMcpServerDefinition(value: unknown): McpServerDefinition | null {
	if (!isPlainObject(value)) return null;
	const args = Array.isArray(value.args)
		? value.args.filter((item): item is string => typeof item === "string")
		: undefined;
	const lifecycle =
		value.lifecycle === "lazy" ||
		value.lifecycle === "eager" ||
		value.lifecycle === "keep-alive" ||
		value.lifecycle === "lazy-keep-alive"
			? value.lifecycle
			: undefined;
	const auth = value.auth === "bearer" || value.auth === "oauth" ? value.auth : undefined;
	const definition: McpServerDefinition = {
		...value,
		command: typeof value.command === "string" ? value.command : undefined,
		args,
		env: asStringRecord(value.env),
		cwd: typeof value.cwd === "string" ? value.cwd : undefined,
		url: typeof value.url === "string" ? value.url : undefined,
		headers: asStringRecord(value.headers),
		socket: typeof value.socket === "string" ? value.socket : undefined,
		auth,
		bearerToken: typeof value.bearerToken === "string" ? value.bearerToken : undefined,
		bearerTokenEnv: typeof value.bearerTokenEnv === "string" ? value.bearerTokenEnv : undefined,
		lifecycle,
		idleTimeout: typeof value.idleTimeout === "number" ? value.idleTimeout : undefined,
		requestTimeoutMs: typeof value.requestTimeoutMs === "number" ? value.requestTimeoutMs : undefined,
		disabled: value.disabled === true ? true : value.disabled === false ? false : undefined,
		directTools:
			typeof value.directTools === "boolean" || Array.isArray(value.directTools)
				? (value.directTools as boolean | string[])
				: undefined,
	};
	return definition;
}

function definitionHasTransport(def: McpServerDefinition): boolean {
	return inferMcpTransport(def) !== null || Boolean(def.command || def.url || def.socket);
}

/**
 * 按 adapter 文档从低到高合并：同名 server 浅合并（后层字段覆盖前层），
 * 这样 `{ disabled: true }` 覆盖不会把下层 command/url 冲掉。
 */
export function mergeMcpServers(
	layers: Array<{ path: string; file: McpConfigFile }>,
	writablePath: string,
): McpServerListItem[] {
	const merged = new Map<string, McpServerListItem>();
	for (const layer of layers) {
		const servers = layer.file.mcpServers;
		if (!servers) continue;
		for (const [name, rawDef] of Object.entries(servers)) {
			const def = normalizeMcpServerDefinition(rawDef);
			if (!def) continue;
			const previous = merged.get(name);
			if (!previous) {
				merged.set(name, {
					name,
					definition: { ...def },
					originPath: layer.path,
					overridePath: layer.path,
					ownedByWritable: layer.path === writablePath,
				});
				continue;
			}
			const nextDef = { ...previous.definition, ...omitUndefined(def) };
			const touchesTransport = definitionHasTransport(def);
			const originPath = touchesTransport ? layer.path : previous.originPath;
			merged.set(name, {
				name,
				definition: nextDef,
				originPath,
				overridePath: layer.path,
				// 只有传输定义写在 Pi 可写文件里，删除条目才会从合并结果消失。
				ownedByWritable: originPath === writablePath,
			});
		}
	}
	return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function validateMcpServer(name: string, def: McpServerDefinition): string | null {
	if (!isMcpServerName(name)) {
		return "Invalid MCP server name";
	}
	const transport = inferMcpTransport(def);
	if (!transport) {
		// 只读层之上的 disabled 覆盖可以没有 command/url/socket。
		if (def.disabled === true || def.disabled === false) return null;
		return "Each server needs exactly one of command, url, or socket";
	}
	if (transport === "http") {
		try {
			const parsed = new URL(def.url ?? "");
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				return "URL must be http(s)";
			}
		} catch {
			return "URL is invalid";
		}
	}
	return null;
}

export function validateMcpConfigFile(file: McpConfigFile): string | null {
	const servers = file.mcpServers ?? {};
	if (!isPlainObject(servers)) return "mcpServers must be an object";
	for (const [name, raw] of Object.entries(servers)) {
		const def = normalizeMcpServerDefinition(raw);
		if (!def) return `Server "${name}" is invalid`;
		const error = validateMcpServer(name, def);
		if (error) return `${name}: ${error}`;
	}
	return null;
}

function whichOnPath(command: string, pathEnv = process.env.PATH ?? "", platform = process.platform): string | null {
	const trimmed = command.trim().replace(/^"|"$/g, "");
	if (!trimmed) return null;
	if (isAbsolute(trimmed)) return existsSync(trimmed) ? trimmed : null;
	const extensions =
		platform === "win32"
			? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
			: [""];
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue;
		const direct = join(dir, trimmed);
		if (existsSync(direct)) return direct;
		for (const ext of extensions) {
			if (!ext) continue;
			const candidate = join(dir, trimmed + (ext.startsWith(".") ? ext : `.${ext}`));
			if (existsSync(candidate)) return candidate;
			if (platform === "win32" && !trimmed.toLowerCase().endsWith(ext.toLowerCase())) {
				const withExt = join(dir, `${trimmed}${ext}`);
				if (existsSync(withExt)) return withExt;
			}
		}
	}
	return null;
}

export function probeStdioCommand(
	command: string,
	options?: { pathEnv?: string; platform?: NodeJS.Platform },
): McpProbeResult {
	const resolved = whichOnPath(command, options?.pathEnv, options?.platform);
	if (!resolved) {
		return { ok: false, transport: "stdio", error: `Command not found: ${command}` };
	}
	return { ok: true, transport: "stdio", detail: resolved };
}

function isHttpReachableStatus(status: number): boolean {
	// MCP HTTP 端点对裸 GET 常回 404/405/406，只要能连上就视为配置可达。
	return status >= 200 && status < 500;
}

type HttpGet = (input: string, init?: RequestInit) => Promise<{ status: number }>;

export async function probeHttpUrl(
	url: string,
	fetchImpl?: HttpGet,
	timeoutMs = HTTP_PROBE_TIMEOUT_MS,
): Promise<McpProbeResult> {
	const request: HttpGet | undefined =
		fetchImpl ??
		(typeof globalThis.fetch === "function"
			? (globalThis.fetch.bind(globalThis) as HttpGet)
			: undefined);
	if (!request) {
		return { ok: false, transport: "http", error: "fetch is not available" };
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { ok: false, transport: "http", error: "URL is invalid" };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, transport: "http", error: "URL must be http(s)" };
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await request(parsed.toString(), {
			method: "GET",
			redirect: "manual",
			signal: controller.signal,
			headers: { accept: "application/json, text/event-stream, */*" },
		});
		if (!isHttpReachableStatus(response.status)) {
			return {
				ok: false,
				transport: "http",
				error: `HTTP ${response.status}`,
			};
		}
		return { ok: true, transport: "http", detail: `HTTP ${response.status}` };
	} catch (error) {
		const aborted = error instanceof Error && error.name === "AbortError";
		return {
			ok: false,
			transport: "http",
			error: aborted ? "Timed out" : error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timer);
	}
}

export async function probeMcpServer(def: McpServerDefinition): Promise<McpProbeResult> {
	const transport = inferMcpTransport(def);
	if (!transport) {
		return { ok: false, error: "Each server needs exactly one of command, url, or socket" };
	}
	if (transport === "stdio") return probeStdioCommand(def.command ?? "");
	if (transport === "http") return probeHttpUrl(def.url ?? "");
	const socket = def.socket?.trim() ?? "";
	if (!socket) return { ok: false, transport: "socket", error: "Socket path is empty" };
	return existsSync(socket)
		? { ok: true, transport: "socket", detail: socket }
		: { ok: false, transport: "socket", error: `Socket not found: ${socket}` };
}

async function readMcpLayerFile(path: string): Promise<{ exists: boolean; file: McpConfigFile; raw: string; error?: string }> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed = parseMcpConfigFile(raw);
		return { exists: true, file: parsed.file, raw, error: parsed.error };
	} catch {
		return { exists: false, file: { mcpServers: {} }, raw: "" };
	}
}

export async function loadMcpConfigSnapshot(
	piAgentDir: string,
	projectPath?: string,
	home = homeFromPiAgentDir(piAgentDir),
): Promise<McpConfigSnapshot> {
	const declared = mcpLayerPaths(home, piAgentDir, projectPath);
	const loaded: Array<{ path: string; file: McpConfigFile }> = [];
	const layers: McpConfigLayer[] = [];
	let writableFile: McpConfigFile = { mcpServers: {} };
	let writableRaw = `${JSON.stringify({ mcpServers: {} }, null, 2)}
`;
	let writablePath = join(piAgentDir, "mcp.json");
	let writableError: string | undefined;

	for (const layer of declared) {
		const result = await readMcpLayerFile(layer.path);
		layers.push({ ...layer, exists: result.exists });
		if (layer.writable) {
			writablePath = layer.path;
			writableError = result.error;
			writableRaw = result.exists && result.raw
				? result.raw
				: `${JSON.stringify({ mcpServers: {} }, null, 2)}
`;
			// JSON 损坏时 parsed 是空对象兜底，不能拿去可视化保存，否则会覆盖用户原文件。
			writableFile = result.exists && !result.error ? result.file : { mcpServers: {} };
		}
		if (result.exists && !result.error) {
			loaded.push({ path: layer.path, file: result.file });
		}
	}

	return {
		writablePath,
		writableFile,
		writableRaw,
		writableError,
		layers,
		servers: mergeMcpServers(loaded, writablePath),
	};
}

export function upsertWritableServer(
	writable: McpConfigFile,
	name: string,
	definition: McpServerDefinition,
): McpConfigFile {
	return {
		...writable,
		mcpServers: {
			...(writable.mcpServers ?? {}),
			[name]: definition,
		},
	};
}

export function removeWritableServer(writable: McpConfigFile, name: string): McpConfigFile {
	const next = { ...(writable.mcpServers ?? {}) };
	delete next[name];
	return { ...writable, mcpServers: next };
}

export { LAYER_KIND_ORDER };
