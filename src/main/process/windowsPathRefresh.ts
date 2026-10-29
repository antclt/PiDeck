/**
 * Windows PATH 自刷新:把注册表里新加的目录补进**已运行进程**的 process.env.PATH。
 *
 * 场景(2026-10 实测):用户在 PiDeck 开着的时候用官网脚本装了 Qoder CLI CN,
 * 脚本把 `%USERPROFILE%\.qoder-cn\bin\qoderclicn` 写进用户 PATH,但进程环境块是
 * 启动时的快照——设置页「检测」spawn 出去的 `qoderclicn --version` 直接 ENOENT 报
 * 「未安装」,会话启动也落回 cmd.exe 兜底并回「不是内部或外部命令」。
 * 重启应用能解决,但那是让用户替我们的实现细节买单。
 *
 * 口径(硬规则):
 * - 只在 win32 生效;其它平台 PATH 语义由 shell 配置决定,不在这里猜。
 * - 只**追加**差集,绝不重建/重排 process.env.PATH:既有优先级必须保留,用户显式
 *   设过的会话级 PATH 覆盖也不能被冲掉。大小写不敏感去重(Windows 路径语义)。
 * - best effort:读注册表失败/超时/被策略拦一律当「没读到」,永不抛、永不阻塞启动。
 * - 值可能是 REG_EXPAND_SZ(含 `%USERPROFILE%` 这类引用),按当前 env 展开;
 *   展开不了的引用原样保留(与 Windows 行为一致),不丢弃整条目录。
 */
import { execFile } from "node:child_process";

/** 记忆窗口:启动时刷一次 + 设置页点「检测」时再刷,窗口内的重复调用直接复用。 */
const MEMO_MS = 5_000;
const QUERY_TIMEOUT_MS = 5_000;

export type WindowsPathHive = "user" | "machine";

export interface WindowsPathRefreshOptions {
	/** 测试注入:默认 process.platform。 */
	platform?: NodeJS.Platform;
	/** 目标环境对象(默认 process.env;注入后便于断言)。 */
	env?: NodeJS.ProcessEnv;
	/** 读某个 hive 的 PATH 原始值;null = 读不到。 */
	readRegistryPath?: (hive: WindowsPathHive) => Promise<string | null>;
	/** 测试注入时钟。 */
	now?: () => number;
	/** 确有新增目录时的回调(日志用)。 */
	onAdded?: (directories: string[]) => void;
}

/** 未展开的 `%VAR%` 按 env 展开(大小写不敏感);展不开的原样保留。 */
export function expandEnvReferences(value: string, env: NodeJS.ProcessEnv): string {
	return value.replace(/%([^%]+)%/g, (raw, name: string) => lookupEnv(env, name) ?? raw);
}

function lookupEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const direct = env[name];
	if (direct !== undefined) return direct;
	const wanted = name.toUpperCase();
	for (const key of Object.keys(env)) {
		if (key.toUpperCase() === wanted) return env[key];
	}
	return undefined;
}

/** 拆分号列表:去首尾空白与成对引号,丢空段(注册表里常见 `;;` 与 `"C:\a b"` 写法)。 */
export function splitPathList(value: string | null | undefined): string[] {
	if (!value) return [];
	const out: string[] = [];
	for (const raw of value.split(";")) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1 ? trimmed.slice(1, -1).trim() : trimmed;
		if (unquoted) out.push(unquoted);
	}
	return out;
}

/**
 * 把 additions 里当前 PATH 还没有的目录追加到末尾。没有新增时原样返回。
 * 只追加不重排:既有条目的优先级是父进程/用户的选择,不是我们该动的。
 */
export function appendMissingPaths(current: string, additions: readonly string[], platform: NodeJS.Platform = "win32"): { value: string; added: string[] } {
	const existing = new Set(splitPathList(current).map((dir) => (platform === "win32" ? dir.toLowerCase() : dir)));
	const added: string[] = [];
	for (const dir of additions) {
		const key = platform === "win32" ? dir.toLowerCase() : dir;
		if (existing.has(key)) continue;
		existing.add(key);
		added.push(dir);
	}
	if (added.length === 0) return { value: current, added };
	const base = current.trim().replace(/;+$/, "");
	return { value: base ? `${base};${added.join(";")}` : added.join(";"), added };
}

/** appendMissingPaths 的字符串形态（只关心新 PATH 的调用方用）。 */
export function mergePathValues(current: string, additions: readonly string[], platform: NodeJS.Platform = "win32"): string {
	return appendMissingPaths(current, additions, platform).value;
}

/** 解析 `reg query ... /v Path` 的输出里那一行的值(REG_SZ / REG_EXPAND_SZ 都认)。 */
export function parseRegQueryOutput(text: string): string | null {
	const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/im.exec(text);
	const value = match?.[1]?.trim();
	return value ? value : null;
}

/**
 * 一次 PowerShell 读回两个 hive 的 PATH。
 * 必须显式把控制台输出编码钉成 UTF-8:中文 Windows 上默认走 OEM 代码页(CP936),
 * 用户名是中文时 `C:\Users\张三\...` 会解成乱码,补进 PATH 的是一条废路径。
 */
function readRegistryPathsWithPowerShell(): Promise<{ user: string | null; machine: string | null }> {
	const script = [
		"[Console]::OutputEncoding=[Text.Encoding]::UTF8;",
		"Write-Output 'PIDECK-USER';",
		"Write-Output ([Environment]::GetEnvironmentVariable('Path','User'));",
		"Write-Output 'PIDECK-MACHINE';",
		"Write-Output ([Environment]::GetEnvironmentVariable('Path','Machine'));",
	].join(" ");
	return new Promise((resolve) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
			{ encoding: "utf8", windowsHide: true, timeout: QUERY_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
			(error, stdout) => {
				if (error || !stdout) {
					resolve({ user: null, machine: null });
					return;
				}
				const userIndex = stdout.indexOf("PIDECK-USER");
				const machineIndex = stdout.indexOf("PIDECK-MACHINE");
				if (userIndex < 0 || machineIndex < 0) {
					resolve({ user: null, machine: null });
					return;
				}
				resolve({
					user: stdout.slice(userIndex + "PIDECK-USER".length, machineIndex).trim() || null,
					machine: stdout.slice(machineIndex + "PIDECK-MACHINE".length).trim() || null,
				});
			},
		);
	});
}

let inFlight: Promise<string[]> | null = null;
let lastRefreshAt: number | null = null;

/** 仅测试用:清掉记忆窗口与在途请求,让下一次调用真的去读注册表。 */
export function resetWindowsPathRefreshCacheForTest(): void {
	inFlight = null;
	lastRefreshAt = null;
}

/**
 * 把注册表 PATH 里的新增目录补进 process.env.PATH,返回这次真正追加的目录(空数组 = 无需变更)。
 * 5 秒内重复调用直接返回空数组(启动 + 设置页并行检测会同时打到这条路径)。
 */
export async function ensureWindowsPathFresh(options: WindowsPathRefreshOptions = {}): Promise<string[]> {
	if ((options.platform ?? process.platform) !== "win32") return [];
	if (inFlight) return await inFlight;
	const now = options.now ?? Date.now;
	if (lastRefreshAt !== null && now() - lastRefreshAt < MEMO_MS) return [];
	inFlight = runRefresh(options)
		.catch(() => [])
		.finally(() => {
			inFlight = null;
		});
	return await inFlight;
}

async function runRefresh(options: WindowsPathRefreshOptions): Promise<string[]> {
	const env = options.env ?? process.env;
	const readRegistryPath = options.readRegistryPath ?? (await createDefaultRegistryReader());

	const [userPath, machinePath] = await Promise.all([readRegistryPath("user").catch(() => null), readRegistryPath("machine").catch(() => null)]);
	const additions = [...splitPathList(expandEnvReferences(userPath ?? "", env)), ...splitPathList(expandEnvReferences(machinePath ?? "", env))];
	const current = env.PATH ?? env.Path ?? "";
	const { value: merged, added } = appendMissingPaths(current, additions, "win32");
	lastRefreshAt = (options.now ?? Date.now)();

	if (added.length === 0) return [];
	env.PATH = merged;
	options.onAdded?.(added);
	return added;
}

/** 默认读法:一次 PowerShell 拿两个 hive（读不到就给 null，不抛）。 */
async function createDefaultRegistryReader(): Promise<(hive: WindowsPathHive) => Promise<string | null>> {
	const snapshot = await readRegistryPathsWithPowerShell().catch(() => ({ user: null, machine: null }));
	return async (hive) => (hive === "user" ? snapshot.user : snapshot.machine);
}
