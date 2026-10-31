import type { WebContents } from "electron";

/**
 * Host IPC 的共享输入判据。
 *
 * 这些值域同时被主处理器与拆分出去的编辑/扫描处理器使用；各写一份会让「合法主机 id」在两个
 * 入口出现细微差异，而那种差异只会表现为某个入口悄悄拒绝合法请求。
 */
export const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Host label is user-facing text shown in the sidebar; keep it bounded and free of control bytes. */
export const MAX_LABEL = 128;
export const HOST_NAME = /^[A-Za-z0-9._:[\]-]+$/;
export const SAFE_USER = /^[A-Za-z0-9._@-]+$/;

export function senderIdOf(sender: WebContents): number | undefined {
	const id = sender?.id;
	return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * Map a thrown store/pin error to a stable code. Only messages that are already a bare code survive;
 * anything else collapses to the fallback so no path or command line can reach the renderer.
 *
 * 实现只有一份（`shared/op.ts`）：判据分散到每个域会让同一种失败在不同入口得到不同的码。
 */
export { codeOf } from "../../shared/op";
