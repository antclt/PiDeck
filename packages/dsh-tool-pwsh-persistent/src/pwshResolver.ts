import {
	candidatePwshPaths as officialCandidatePwshPaths,
	resolvePwshPath as officialResolvePwshPath,
} from "@deepseek-ai/dsh-pwsh-local";

export type PwshPathResolverOptions = {
	configuredPath?: string;
	platform: NodeJS.Platform;
};

const WINGET_INSTALL_COMMAND = "winget install --id Microsoft.PowerShell --source winget";

/**
 * 直通官方 @deepseek-ai/dsh-pwsh-local 的候选路径构建（纯函数，无磁盘访问）。
 * 与普通 pwsh 工具共用同一份候选顺序，避免两套 resolver 行为漂移。
 */
export function candidatePwshPaths(env: NodeJS.ProcessEnv): string[] {
	return officialCandidatePwshPaths(env);
}

/**
 * 直接复用官方 @deepseek-ai/dsh-pwsh-local 的 resolver：显式 pwshPath 优先，
 * Windows 依次扫描标准 PS7、PATH 内绝对 pwsh.exe（lstat 接受 Store alias）、
 * Windows PowerShell 5.1，最后回退裸 `pwsh`；其它平台返回 `pwsh`。
 * 持久 shell 与普通 pwsh 因此永远解析到同一个可执行文件。
 */
export function resolvePwshPath(options: PwshPathResolverOptions): string {
	const configured = options.configuredPath?.trim();
	return officialResolvePwshPath(
		configured !== undefined && configured.length > 0 ? configured : undefined,
		process.env,
		options.platform,
	);
}

/** Add an actionable diagnostic to errors raised while the shell starts. */
export function formatPwshStartupError(error: unknown, pwshPath: string): Error {
	const reason = error instanceof Error ? error.message : String(error);
	const message = [
		`Unable to start the persistent PowerShell process (pwshPath: ${pwshPath}).`,
		reason,
		"On Windows, leave pwshPath empty to scan standard installations and PATH/App Execution Aliases, or configure a valid executable path.",
		`Install PowerShell 7 with: ${WINGET_INSTALL_COMMAND}`,
	].join("\n");
	return error instanceof Error ? new Error(message, { cause: error }) : new Error(message);
}
