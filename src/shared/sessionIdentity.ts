import type { SessionEnvironment, SessionSource, SessionSummary } from "./types";

export type SessionOriginInput = {
	source: SessionSource;
	environment: SessionEnvironment;
	filePath: string;
	wslDistro?: string;
	wslUser?: string;
	importedSourceId?: string;
};

/**
 * pi 未 set_session_name 时，sessionName 默认是 JSONL 文件名。
 * 文件名把 ISO 的 `:` / `.` 换成 `-`（如 `2026-08-08T10-47-19-239Z_abc`），
 * 不能当侧栏标题，否则全是日期，且占位名被盖掉后无法用首条消息自动改名。
 */
export function looksLikePiSessionFileStem(title: string): boolean {
	const trimmed = title.replace(/\s+/g, " ").trim();
	// 秒后的毫秒在文件名里是 `-239`，不是 ISO 的 `.239`。
	return /^\d{4}-\d{2}-\d{2}T\d{2}[-:]\d{2}[-:]\d{2}(?:[.,-]\d+)?Z(?:_[A-Za-z0-9-]+)?$/.test(
		trimmed,
	);
}

/** pi-subagents 产物目录名：artifactDir="session"（默认）把子代理输入/输出/转储写进父会话同级目录。 */
export const SUBAGENT_ARTIFACTS_DIR_NAME = "subagent-artifacts";

/**
 * 判断文件是否位于 pi-subagents 产物目录内。
 *
 * 这些 JSONL（如 `<runId>_<agent>_0_transcript.jsonl`）是扩展私有的 transcript
 * 转储而非会话文件（无 type:session 头）。扫描与 catalog 若不排除，每个子代理会在
 * 侧栏出现两条：真子会话嵌套在父会话下 + 产物转储平铺顶层（侧栏重复显示）。
 * 该规则是 pi-subagents 三种 artifactDir 配置中唯一会落进 sessions 根的布局。
 */
export function isInSubagentArtifactsDir(filePath: string): boolean {
	return filePath.replace(/\\/g, "/").split("/").includes(SUBAGENT_ARTIFACTS_DIR_NAME);
}

export function canonicalizeSessionPath(
	filePath: string,
	environment: SessionEnvironment,
): string {
	const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
	return environment === "native" ? normalized.toLowerCase() : normalized;
}

export function getSessionEnvironment(
	summary: Pick<SessionSummary, "wsl">,
): SessionEnvironment {
	return summary.wsl ? "wsl" : "native";
}

export function getImportedSessionSourceId(
	summary: Pick<SessionSummary, "source" | "codexSessionId">,
): string | undefined {
	return summary.source === "codex" ? summary.codexSessionId : undefined;
}

export function buildSessionOriginKey(input: SessionOriginInput): string {
	const environmentKey = input.environment === "wsl"
		? `wsl:${input.wslDistro ?? "unknown"}:${input.wslUser ?? "unknown"}`
		: "native";
	const importedKey = input.importedSourceId
		? `:${encodeURIComponent(input.importedSourceId)}`
		: "";
	return [
		input.source,
		environmentKey,
		canonicalizeSessionPath(input.filePath, input.environment),
	].join(":") + importedKey;
}

export function buildSummaryOriginKey(
	summary: SessionSummary,
	options?: { wslDistro?: string; wslUser?: string },
): string {
	return buildSessionOriginKey({
		source: summary.source ?? "pi",
		environment: getSessionEnvironment(summary),
		filePath: summary.filePath,
		wslDistro: options?.wslDistro,
		wslUser: options?.wslUser,
		importedSourceId: getImportedSessionSourceId(summary),
	});
}

/** 判断路径是否为该环境下的绝对路径（纯字符串判断，不依赖 node:path）。 */
function isAbsolutePath(filePath: string, environment: SessionEnvironment): boolean {
	if (environment === "wsl") return filePath.startsWith("/");
	// native：盘符开头、根前缀（如 \\server\share 或 /rooted）。
	return (
		/^[A-Za-z]:[\\/]/.test(filePath) ||
		filePath.startsWith("/") ||
		filePath.startsWith("\\")
	);
}

/**
 * Windows 盘符路径 → WSL /mnt/<drive>/… 基址（仅覆盖 WslPaths.toWslLinuxPath 的盘符分支；
 * 已以 / 开头的路径原样返回，无法识别的路径原样返回由调用方兜底）。
 * 与 `src/main/wsl/WslPaths.ts` 保持同一换算语义。
 */
function windowsPathToWslBase(path: string): string {
	const drive = path.match(/^([A-Za-z]):(?:[\\/](.*))?$/);
	if (drive) {
		const suffix = drive[2]?.replace(/[\\/]+/g, "/") ?? "";
		return `/mnt/${drive[1].toLowerCase()}/${suffix}`;
	}
	return path.startsWith("/") ? path.replace(/[\\/]+/g, "/") : path;
}

/**
 * 将会话文件路径归一化为绝对路径（纯字符串实现，可在渲染层安全调用）。
 *
 * pi 的 sessionDir 可配置为相对 cwd 的路径（如项目 `.pi/settings.json` 中
 * `"sessionDir": ".pi/sessions"`），此时 get_state 返回的 sessionFile 也是相对路径。
 * 若原样写入 catalog，会与扫描器发现的绝对路径构成「同一文件两条记录」
 * （侧栏重复显示两个会话），且 rename/delete/read 等文件操作会落到错误位置。
 * 所有会话路径在进入 catalog / Agent 状态前都应经过本函数。
 *
 * WSL 环境按 Linux 路径语义处理：相对路径解析到 /mnt/<drive>/… 基址。
 */
export function toAbsoluteSessionPath(
	filePath: string,
	projectPath: string,
	environment: SessionEnvironment,
): string {
	if (isAbsolutePath(filePath, environment)) return filePath;
	const base = environment === "wsl" ? windowsPathToWslBase(projectPath) : projectPath;
	const joined = `${base.replace(/[\\/]+$/, "")}/${filePath.replace(/^[\\/]+/, "")}`;
	// native 统一反斜杠风格，与 node:path resolve 输出一致；WSL 保持正斜杠。
	return environment === "wsl" ? joined : joined.replace(/\//g, "\\");
}
