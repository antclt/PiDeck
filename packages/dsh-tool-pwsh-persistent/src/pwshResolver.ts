import { win32 } from "node:path";

export type PwshPathResolverOptions = {
	configuredPath?: string;
	platform: string;
	programFiles?: string;
	fileExists: (path: string) => boolean;
};

const DEFAULT_PROGRAM_FILES = "C:\\Program Files";
const WINGET_INSTALL_COMMAND = "winget install --id Microsoft.PowerShell --source winget";

/**
 * Resolve the executable passed to node-pty without assuming a fixed Windows
 * installation layout. The filesystem check is injected so this decision stays
 * pure and can cover PATH/App Execution Alias environments in tests.
 */
export function resolvePwshPath(options: PwshPathResolverOptions): string {
	if (options.configuredPath !== undefined && options.configuredPath.trim().length > 0) {
		return options.configuredPath;
	}
	if (options.platform !== "win32") return "pwsh";

	const standardPath = win32.join(
		options.programFiles ?? DEFAULT_PROGRAM_FILES,
		"PowerShell",
		"7",
		"pwsh.exe",
	);
	return options.fileExists(standardPath) ? standardPath : "pwsh";
}

/** Add an actionable diagnostic to errors raised while the shell starts. */
export function formatPwshStartupError(error: unknown, pwshPath: string): Error {
	const reason = error instanceof Error ? error.message : String(error);
	const message = [
		`Unable to start the persistent PowerShell process (pwshPath: ${pwshPath}).`,
		reason,
		"On Windows, leave pwshPath empty to use PATH/App Execution Alias resolution, or configure a valid executable path.",
		`Install PowerShell 7 with: ${WINGET_INSTALL_COMMAND}`,
	].join("\n");
	return error instanceof Error ? new Error(message, { cause: error }) : new Error(message);
}
