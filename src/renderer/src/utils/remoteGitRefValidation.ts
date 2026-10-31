/**
 * 远端 Git 的名字判据（纯函数，无状态）。
 *
 * 主进程与 helper 才是权威；渲染层先拒绝只是为了不让一个注定失败的输入离开窗口。从
 * `remoteGitViewState` 原样搬出：那个控制器模块已接近体量红线，纯判据留在这里更好测，
 * 也不会把状态机撑大（行为零变化，导入路径由 remoteGitViewState 再导出保持兼容）。
 */

/**
 * The same name rules main enforces, kept in step with `validateRemoteGitBranchName` on purpose: the panel refuses
 * locally so an unusable name never leaves the window, while the main process stays the authority. A pseudo-ref such
 * as HEAD is a name Git would refuse - the panel must not offer it and pretend the click could work.
 */
export function validRemoteGitBranchName(name: unknown): name is string {
	if (typeof name !== "string" || name.length === 0 || new TextEncoder().encode(name).length > 1024 || /[\x00-\x1f\x7f\\]/.test(name)) return false;
	if (name === "@" || name.startsWith("-") || name.includes("@{") || name.startsWith("refs/")) return false;
	if (/^(?:HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|BISECT_HEAD)$/.test(name)) return false;
	return !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(name);
}

/**
 * A compare names full local refs (refs/heads/* or refs/tags/*), exactly the strings `remoteRefs` returns.
 * These rules mirror main's `validateRemoteGitRefFullName` and the frozen helper's readRef; the panel refuses
 * locally so an unusable pair never leaves the window. Git's own check-ref-format is not enough: it accepts
 * an option-like component, a lone `@` and braces (measured), all of which this protocol refuses.
 */
const REMOTE_GIT_REF_FORBIDDEN = /[\u0000-\u0020\u007f~^:?*[\\{}]/;
export function validRemoteGitRefFullName(value: unknown): value is string {
	if (typeof value !== "string" || new TextEncoder().encode(value).length > 1024 || REMOTE_GIT_REF_FORBIDDEN.test(value) || value.includes("..") || value.includes("@{") || value.includes("//")) return false;
	const prefix = value.startsWith("refs/heads/") ? "refs/heads/" : value.startsWith("refs/tags/") ? "refs/tags/" : null;
	if (prefix === null) return false;
	const name = value.slice(prefix.length);
	if (!name) return false;
	return !name.split("/").some((part) => !part || part === "." || part === ".." || part === "@" || part.startsWith(".") || part.startsWith("-") || part.endsWith(".") || part.endsWith(".lock"));
}
