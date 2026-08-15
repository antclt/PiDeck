import { join } from "node:path";

/**
 * DSH 会话持久化路径编码（DshAgentManager 与 DshHost 共用）：
 * $DSH_HOME/sessions/<workspace 编码目录>/<sessionId>/session.jsonl.zstd。
 * workspace 目录名编码规则与 dsh-session-persistence-jsonl 的 projectKey 一致
 * （2026-08 实测对齐）：路径分隔符与盘符冒号折叠为 "-"，安全字符原样，
 * 其余按 ~XXXX 转义，首尾补 "-" 并截断 251 字符。
 */
export function workspaceDirFor(cwd: string): string {
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i += 1) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** DSH 会话的持久化文件路径（session.jsonl.zstd，zstd 压缩的 host 会话日志）。 */
export function dshSessionFilePath(dshHome: string, cwd: string, sessionId: string): string {
	return join(dshHome, "sessions", workspaceDirFor(cwd), sessionId, "session.jsonl.zstd");
}
