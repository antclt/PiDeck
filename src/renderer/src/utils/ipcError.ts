/**
 * 去掉 Electron IPC 包装前缀，只保留真正业务错误，方便 toast 阅读。
 *
 * 主进程 throw 的错误经 ipcRenderer.invoke 会被包成
 * "Error invoking remote method 'config:save-models': Error: ..."；直接展示原文
 * 会把窗口级噪声塞进一句用户提示里。
 */
export function formatIpcError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const matched = raw.match(/Error invoking remote method '[^']+':\s*(?:Error:\s*)?([\s\S]+)$/i);
	return (matched?.[1] ?? raw).trim();
}
