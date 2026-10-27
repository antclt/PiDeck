import { buildPinnedSshInvocation } from "./SshVerifiedConnection";
import { quotePosixArgument } from "./RemoteBootstrapContract";
import type { SshClientRuntime } from "./SshClientRuntime";
import type { RemoteDirectoryEntry, RemoteDirectoryListResult } from "../../shared/types/remoteHost";

/**
 * Read-only directory listing for the project-enrollment picker.
 *
 * Why this is a pinned SSH probe and **not** a helper method: the helper is started with `--root` and
 * treats every path outside it as `PATH_OUTSIDE_ROOT`. That confinement is why a remote project cannot
 * read its neighbours, so it must not grow an "absolute path" escape hatch. Enrollment needs to browse
 * *before* a root exists, so it reuses the same pinned/verified ssh invocation as the canonical-root
 * probe, with a fixed POSIX command and no helper session.
 *
 * The command is read-only: it `cd`s into the requested directory and prints directory names only.
 * Files, sizes and contents never travel; names are NUL-separated so spaces/newlines cannot split a
 * record, and the remote side stops at REMOTE_LIST_DIRS_LIMIT entries so one huge directory cannot
 * exhaust the 256 KiB command buffer.
 */

export const REMOTE_LIST_DIRS_LIMIT = 300;
const MAX_REMOTE_PATH = 4096;
const MAX_NAME = 255;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export const REMOTE_LIST_DIRS_CODES = {
	invalidPath: "REMOTE_LIST_DIRS_PATH_INVALID",
	notADirectory: "REMOTE_LIST_DIRS_NOT_A_DIRECTORY",
	probeFailed: "REMOTE_LIST_DIRS_PROBE_FAILED",
	badOutput: "REMOTE_LIST_DIRS_BAD_OUTPUT",
	homeUnavailable: "REMOTE_LIST_DIRS_HOME_UNAVAILABLE",
} as const;

/**
 * Path gate for listing. Compared with `assertProbePath` it allows `/` (browsing the root is legitimate
 * and read-only) but still rejects relative paths, traversal segments, trailing separators and control
 * bytes. The value is only ever interpolated through `quotePosixArgument`.
 */
export function assertListablePath(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_REMOTE_PATH) throw new Error(REMOTE_LIST_DIRS_CODES.invalidPath);
	if (CONTROL_CHARS.test(value)) throw new Error(REMOTE_LIST_DIRS_CODES.invalidPath);
	if (!value.startsWith("/")) throw new Error(REMOTE_LIST_DIRS_CODES.invalidPath);
	if (value === "/") return;
	if (value.endsWith("/")) throw new Error(REMOTE_LIST_DIRS_CODES.invalidPath);
	if (
		value
			.slice(1)
			.split("/")
			.some((segment) => segment === "" || segment === "." || segment === "..")
	)
		throw new Error(REMOTE_LIST_DIRS_CODES.invalidPath);
}

/** Resolve `$HOME` on the remote side (canonicalized) for the picker's default directory. */
export function buildReadHomeCommand(): string {
	// 命令经 SSH argv 发送，不能含真实换行/NUL（SshVerifiedConnection 会拒绝）；\n 必须是 printf 的转义。
	return 'target=$(readlink -f -- "$HOME") || exit 3; [ -n "$target" ] || exit 4; [ -d "$target" ] || exit 5; printf \'%s\\n\' "$target"';
}

/**
 * Print `kind NUL name NUL` for every immediate subdirectory.
 *
 * - `find -print0` is not used because the symlink marker and the platform matrix differ across BSD/GNU;
 *   the shell loop gives both facts with `[ -d ]` (follows links) and `[ -L ]`.
 * - `.[!.]*` / `..?*` include dot-directories without matching `.` or `..`.
 * - Non-matching globs stay literal; they fail both `-e` and `-L` and are skipped.
 * - The loop stops at the limit; the caller marks the result truncated when the cap is reached.
 */
export function buildListDirectoriesCommand(path: string): string {
	assertListablePath(path);
	// 单行：SSH 命令校验拒绝换行；NUL 分隔符必须是 printf 的 \0 转义，而不是 JS 字符串里的真实 NUL。
	return `cd ${quotePosixArgument(path)} || exit 3; i=0; for entry in .[!.]* ..?* *; do [ -e "$entry" ] || [ -L "$entry" ] || continue; [ -d "$entry" ] || continue; if [ -L "$entry" ]; then kind=L; else kind=D; fi; printf '%s\\0%s\\0' "$kind" "$entry"; i=$((i+1)); [ "$i" -ge ${REMOTE_LIST_DIRS_LIMIT} ] && break; done; exit 0`;
}

/** Reject a home path the remote reported: absolute, non-root, bounded and traversal-free. */
export function readRemoteHome(value: unknown): string {
	if (typeof value !== "string") throw new Error(REMOTE_LIST_DIRS_CODES.homeUnavailable);
	const home = value.endsWith("\n") ? value.slice(0, -1) : value;
	if (home.length === 0 || home.length > MAX_REMOTE_PATH || CONTROL_CHARS.test(home)) throw new Error(REMOTE_LIST_DIRS_CODES.homeUnavailable);
	if (!home.startsWith("/") || home === "/" || home.endsWith("/")) throw new Error(REMOTE_LIST_DIRS_CODES.homeUnavailable);
	if (
		home
			.slice(1)
			.split("/")
			.some((segment) => segment === "" || segment === "." || segment === "..")
	)
		throw new Error(REMOTE_LIST_DIRS_CODES.homeUnavailable);
	return home;
}

/**
 * Parse the NUL stream. Any malformed pair invalidates the whole answer: a listing that "mostly parsed"
 * must not be shown as if it were complete. Names carrying control bytes are skipped individually
 * (they cannot be rendered or re-submitted safely) instead of failing the whole directory.
 */
export function parseDirectoryListing(stdout: string): { entries: RemoteDirectoryEntry[]; malformed: boolean } {
	if (stdout.length > 220_000) return { entries: [], malformed: true };
	const fields = stdout.split("\u0000");
	if (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
	if (fields.length % 2 !== 0) return { entries: [], malformed: true };
	const entries: RemoteDirectoryEntry[] = [];
	for (let index = 0; index < fields.length; index += 2) {
		const kind = fields[index];
		const name = fields[index + 1] ?? "";
		if (kind !== "D" && kind !== "L") return { entries: [], malformed: true };
		if (name.length === 0 || name.length > MAX_NAME || name.includes("/") || CONTROL_CHARS.test(name)) continue;
		entries.push({ name, isSymlink: kind === "L" });
	}
	entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	return { entries, malformed: false };
}

/** Run one pinned probe and return its stdout; exit codes are mapped by the caller. */
async function runProbe(input: { userDataDir: string; hostId: string; client: SshClientRuntime; remoteCommand: string }, signal?: AbortSignal): Promise<{ exitCode: number; stdout: string }> {
	const invocation = await buildPinnedSshInvocation(input.userDataDir, input.hostId, "ssh-batch", { client: input.client, remoteCommand: input.remoteCommand });
	const result = await input.client.run(invocation.executable, invocation.args, signal === undefined ? undefined : { signal });
	return { exitCode: result.exitCode, stdout: result.stdout };
}

/**
 * List immediate subdirectories. `path === undefined` starts at the remote `$HOME`.
 * Every failure is a stable code; the renderer never sees command text, paths of other users or errno.
 */
export async function listRemoteDirectories(input: { userDataDir: string; hostId: string; client: SshClientRuntime; path?: string; signal?: AbortSignal }): Promise<RemoteDirectoryListResult> {
	const hostId = input.hostId;
	try {
		let target = input.path;
		if (target === undefined || target.length === 0) {
			const home = await runProbe({ ...input, remoteCommand: buildReadHomeCommand() }, input.signal);
			if (home.exitCode !== 0) return { ok: false, hostId, code: REMOTE_LIST_DIRS_CODES.homeUnavailable };
			target = readRemoteHome(home.stdout);
		} else {
			assertListablePath(target);
		}
		const listed = await runProbe({ ...input, remoteCommand: buildListDirectoriesCommand(target) }, input.signal);
		if (listed.exitCode === 3) return { ok: false, hostId, code: REMOTE_LIST_DIRS_CODES.notADirectory };
		if (listed.exitCode !== 0) return { ok: false, hostId, code: REMOTE_LIST_DIRS_CODES.probeFailed };
		const parsed = parseDirectoryListing(listed.stdout);
		if (parsed.malformed) return { ok: false, hostId, code: REMOTE_LIST_DIRS_CODES.badOutput };
		return { ok: true, hostId, path: target, entries: parsed.entries, truncated: parsed.entries.length >= REMOTE_LIST_DIRS_LIMIT };
	} catch (error) {
		const message = typeof error === "object" && error !== null && "message" in error ? (error as { message?: unknown }).message : undefined;
		const code = typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(message) ? message : REMOTE_LIST_DIRS_CODES.probeFailed;
		return { ok: false, hostId, code };
	}
}
