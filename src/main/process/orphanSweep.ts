import { execFile, spawn } from "node:child_process";
import type { McpServerDefinition } from "../../shared/types/mcp";
import type { AcpToolConfig } from "../../shared/types/acp";

/**
 * Windows 孤儿进程回收（issue #450）。
 *
 * 背景：Windows 没有进程组级联回收。pi 拉起的 npx 型 MCP（cmd → node npx-cli →
 * cmd → node server）与 ACP CLI 在根进程被强杀、PiDeck 异常退出或中间层先退出后，
 * 会变成父进程已消失的孤儿 node.exe / cmd.exe，持续占用提交内存（事故现场 195 个 / 21GB）。
 *
 * 这里只做「启动后扫一次」的保守回收：
 * - 只看 node.exe 与 cmd.exe（npx 型 MCP 的链顶常是 cmd.exe，只查 node 会漏整棵子树）；
 * - 只杀**父进程已不存在**的（真正孤儿）；父进程还在的一律不碰（TUI、另一实例、
 *   用户自己的进程都可能是活的）；
 * - 命令行必须命中当前 MCP / ACP 配置派生的标记（包名 / 可执行名），不做通配。
 *
 * 标记只从 PiDeck 自己管理的配置派生，不读任意进程参数之外的系统信息；命令行内容
 * 可能含密钥，**不写日志**，只用做内存匹配。
 */

const MAX_SWEEP_KILLS = 200;

/** 启动器/解释器本身不能当标记：命中面太宽。 */
const LAUNCHER_TOKENS = new Set(["npx", "npm", "pnpm", "yarn", "bunx", "bun", "node", "uvx", "uv", "python", "python3", "py", "cmd", "powershell", "pwsh", "docker", "deno"]);

const MIN_MARKER_LENGTH = 5;

/** 进程快照（只保留判定需要的字段）。 */
export type ProcessSnapshot = {
	/** 当前存活 PID 集合：用来判断父进程是否还在。 */
	ids: number[];
	/** node 与 cmd 包装层：npx 型 MCP 的链顶常常是 cmd.exe，只查 node 会漏掉整棵子树。 */
	processes: Array<{ pid: number; ppid: number; cmd?: string }>;
};

/**
 * 把一个命令行 token 归一成可匹配的标记。
 *
 * - 路径取 node_modules 之后的包名（含 scope），例如
 *   `...\\node_modules\\@playwright\\mcp\\cli.js` → `@playwright/mcp`；
 * - 包规格去掉版本后缀：`@tencent-ai/codebuddy-code@2.178.0` → `@tencent-ai/codebuddy-code`；
 * - 丢弃启动器、flag、URL、过短 token（`mcp`、`-y` 这类会误伤）。
 */
function normalizeMarker(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim().replace(/^["']|["']$/g, "");
	if (!trimmed || trimmed.startsWith("-")) return undefined;
	if (/^https?:\/\//i.test(trimmed)) return undefined;
	const normalized = trimmed.replace(/\\/g, "/");
	const looksLikePath = /^[A-Za-z]:\//.test(normalized) || /^[\\/]/.test(normalized) || normalized.startsWith("./") || normalized.startsWith("../");
	let candidate = normalized;
	const nodeModules = normalized.lastIndexOf("/node_modules/");
	if (nodeModules >= 0) {
		const rest = normalized.slice(nodeModules + "/node_modules/".length).split("/");
		const first = rest[0] ?? "";
		candidate = first.startsWith("@") ? `${first}/${rest[1] ?? ""}` : first;
	} else if (looksLikePath) {
		// 普通文件路径取文件名；包规格（@scope/name、name）保留原样。
		candidate = normalized.split("/").pop() ?? normalized;
	}
	candidate = candidate.replace(/\.(?:js|mjs|cjs|exe|cmd|bat|ps1)$/i, "");
	// 只剥包名末尾的版本号：第一个 @ 是 scope 前缀，不能动。
	const versionAt = candidate.lastIndexOf("@");
	if (versionAt > 0) candidate = candidate.slice(0, versionAt);
	const lower = candidate.toLowerCase();
	if (candidate.length < MIN_MARKER_LENGTH || LAUNCHER_TOKENS.has(lower) || /^\d+$/.test(candidate)) return undefined;
	return candidate;
}

/** 从当前 MCP / ACP 配置派生孤儿进程标记（纯函数，供测试）。 */
export function deriveOrphanSweepMarkers(input: { mcpServers?: readonly McpServerDefinition[]; acpTools?: readonly Pick<AcpToolConfig, "command" | "args">[] }): string[] {
	const markers = new Set<string>();
	const add = (token: unknown) => {
		const marker = normalizeMarker(token);
		if (marker) markers.add(marker);
	};
	for (const server of input.mcpServers ?? []) {
		// 远程（url）MCP 没有本地进程；stdio 的 command/args 才是 spawn 链路的标记。
		if (!server || typeof server !== "object" || typeof (server as { url?: unknown }).url === "string") continue;
		const definition = server as { command?: unknown; args?: unknown };
		add(definition.command);
		if (Array.isArray(definition.args)) for (const arg of definition.args) add(arg);
	}
	for (const tool of input.acpTools ?? []) {
		add(tool.command);
		for (const arg of tool.args ?? []) add(arg);
	}
	// pi 自身（npm 安装形态）：PiDeck 退出/崩溃后残留的 node bundle 同样占内存。
	// Bun 单文件安装是 pi.exe，不在本扫描（只查 node.exe）范围内。
	add("pi-coding-agent");
	return [...markers].sort();
}

/** 从进程快照里挑出「父进程已消失 + 命中标记」的 node/cmd 进程（纯函数，供测试）。 */
export function selectOrphanedManagedProcesses(snapshot: ProcessSnapshot, markers: readonly string[]): number[] {
	if (markers.length === 0) return [];
	const alive = new Set(snapshot.ids);
	const normalizedMarkers = markers.map((marker) => marker.toLowerCase());
	const selected: number[] = [];
	const seen = new Set<number>();
	for (const item of snapshot.processes) {
		if (!item || !Number.isSafeInteger(item.pid) || item.pid <= 0) continue;
		if (item.pid === process.pid || seen.has(item.pid)) continue;
		// 父进程还活着：不是孤儿。TUI / 另一实例 / 用户自己的进程都会走这条。
		if (Number.isSafeInteger(item.ppid) && item.ppid > 0 && alive.has(item.ppid)) continue;
		if (typeof item.cmd !== "string" || item.cmd.length === 0) continue;
		const cmd = item.cmd.replace(/\\/g, "/").toLowerCase();
		if (!normalizedMarkers.some((marker) => cmd.includes(marker))) continue;
		seen.add(item.pid);
		selected.push(item.pid);
		if (selected.length >= MAX_SWEEP_KILLS) break;
	}
	return selected;
}

const POWERSHELL_SNAPSHOT_SCRIPT = [
	"$ErrorActionPreference='SilentlyContinue'",
	"$all=@(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine)",
	"$ids=@($all | ForEach-Object { [int]$_.ProcessId })",
	"$nodes=@($all | Where-Object { $_.Name -eq 'node.exe' -or $_.Name -eq 'cmd.exe' } | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; cmd=[string]$_.CommandLine } })",
	"[pscustomobject]@{ ids=$ids; processes=$nodes } | ConvertTo-Json -Compress -Depth 4",
].join("\n");

/** 通过一次 PowerShell CIM 查询拿进程快照；失败返回 null（调用方只记日志，不重试）。 */
export function readWindowsProcessSnapshot(): Promise<ProcessSnapshot | null> {
	return new Promise((resolve) => {
		execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SNAPSHOT_SCRIPT], { windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
			if (error) {
				resolve(null);
				return;
			}
			try {
				const parsed = JSON.parse(stdout) as { ids?: unknown; processes?: unknown };
				const ids = Array.isArray(parsed.ids) ? parsed.ids.filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value)) : [];
				const rawProcesses = Array.isArray(parsed.processes) ? parsed.processes : parsed.processes ? [parsed.processes] : [];
				const processes = rawProcesses
					.filter((item): item is { pid: number; ppid: number; cmd?: string } => Boolean(item) && typeof item === "object")
					.map((item) => ({ pid: Number(item.pid), ppid: Number(item.ppid), cmd: typeof item.cmd === "string" ? item.cmd : undefined }))
					.filter((item) => Number.isSafeInteger(item.pid) && item.pid > 0);
				resolve({ ids, processes });
			} catch {
				resolve(null);
			}
		});
	});
}

/** 整树强杀（taskkill 是 System32 真 exe，不经 cmd.exe；error 必须挂，否则未处理事件炸主进程）。 */
function taskkillTree(pid: number): void {
	try {
		const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		killer.on("error", () => {});
	} catch {
		/* taskkill 缺失/被杀：留给下一次启动再回收 */
	}
}

export type OrphanSweepResult = { found: number; killed: number };

/**
 * 启动后回收一次孤儿进程。非 Windows / 无标记 / 快照失败都安静返回。
 * 只记数量，不记命令行（可能含密钥）。
 */
export async function sweepOrphanedManagedProcesses(deps: { markers: readonly string[]; snapshot?: () => Promise<ProcessSnapshot | null>; kill?: (pid: number) => void; platform?: NodeJS.Platform } = { markers: [] }): Promise<OrphanSweepResult> {
	const platform = deps.platform ?? process.platform;
	if (platform !== "win32" || deps.markers.length === 0) return { found: 0, killed: 0 };
	const snapshot = await (deps.snapshot ?? readWindowsProcessSnapshot)();
	if (!snapshot) return { found: 0, killed: 0 };
	const pids = selectOrphanedManagedProcesses(snapshot, deps.markers);
	const kill = deps.kill ?? taskkillTree;
	for (const pid of pids) kill(pid);
	return { found: pids.length, killed: pids.length };
}
