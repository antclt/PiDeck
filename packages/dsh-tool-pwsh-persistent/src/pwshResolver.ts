import { lstatSync } from "node:fs";
import { win32 } from "node:path";

/** The subset of fs.Stats needed to accept files and Windows App Execution Aliases. */
export type PwshPathStat = {
	isFile(): boolean;
	isSymbolicLink(): boolean;
};

export type PwshPathResolverOptions = {
	configuredPath?: string;
	platform: string;
	programFiles?: string;
	systemRoot?: string;
	pathEnv?: string;
	lstat?: (path: string) => PwshPathStat;
};

export type PwshPathCandidateOptions = Pick<
	PwshPathResolverOptions,
	"programFiles" | "systemRoot" | "pathEnv"
>;

const DEFAULT_PROGRAM_FILES = "C:\\Program Files";
const DEFAULT_SYSTEM_ROOT = "C:\\Windows";
const WINGET_INSTALL_COMMAND = "winget install --id Microsoft.PowerShell --source winget";

/**
 * Build the Windows executable candidates in the same order as DSH's local
 * pwsh resolver. Resolving PATH entries to absolute paths avoids node-pty's
 * incomplete bare-command PATH scan and lets it launch WindowsApps aliases.
 */
export function candidatePwshPaths(options: PwshPathCandidateOptions = {}): string[] {
	const programFiles = options.programFiles ?? DEFAULT_PROGRAM_FILES;
	const systemRoot = options.systemRoot ?? DEFAULT_SYSTEM_ROOT;
	const candidates = [win32.join(programFiles, "PowerShell", "7", "pwsh.exe")];

	for (const entry of (options.pathEnv ?? "").split(";")) {
		const trimmed = entry.trim().replace(/^"|"$/g, "");
		if (trimmed.length > 0) candidates.push(win32.join(trimmed, "pwsh.exe"));
	}

	candidates.push(win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
	return candidates;
}

/**
 * Check the directory entry itself instead of following its target. Windows
 * Store App Execution Aliases can be reparse points whose target rejects stat
 * with EACCES, while lstat still identifies a file or symlink CreateProcess
 * can launch. Directories are deliberately rejected.
 */
export function candidatePwshPathExists(
	candidate: string,
	lstat: (path: string) => PwshPathStat = lstatSync,
): boolean {
	try {
		const stat = lstat(candidate);
		return stat.isFile() || stat.isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Resolve the executable passed to node-pty without assuming a fixed Windows
 * installation layout. The lstat dependency is injectable so candidate order
 * and WindowsApps alias handling are covered without touching the real disk.
 */
export function resolvePwshPath(options: PwshPathResolverOptions): string {
	if (options.configuredPath !== undefined && options.configuredPath.trim().length > 0) {
		return options.configuredPath;
	}
	if (options.platform !== "win32") return "pwsh";

	const lstat = options.lstat ?? lstatSync;
	for (const candidate of candidatePwshPaths(options)) {
		if (candidatePwshPathExists(candidate, lstat)) return candidate;
	}
	return "pwsh";
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
