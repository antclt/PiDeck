import type { WebContents } from "electron";
import { BrowserAgentError, errorMessage } from "./browserErrors";

/** 一条 CDP 命令的发送函数（sessionId 用于 worker/子 target，页面主 frame 不需要）。 */
export type CdpSend = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>;

export type BrowserCdpSessionOptions = {
	/** 单条 CDP 命令超时（默认 8s；截图/导航在调用侧另设更长等待）。 */
	commandTimeoutMs?: number;
};

/**
 * CDP 会话租约：webContents.debugger 是**独占**的（PoC 实测二次 attach 抛 Debugger is already attached），
 * 而仓库里 MemoryMonitor 也会在 PIDECK_MEMORY_PROFILE=1 时 attach 所有 webContents。
 *
 * 策略（docs/browser-agent-plan.md §8）：
 * - 每次动作 attach → 执行 → detach，把冲突窗口压到最小；
 * - 只 detach 自己 attach 的（owned 表），别人的 attach 一律不抢，回 cdp_busy；
 * - attach 失败不重试，调用方可降级 executeJavaScript 并把 degraded 标记回给模型。
 */
export class BrowserCdpSession {
	private readonly owned = new Map<number, WebContents>();

	constructor(private readonly options: BrowserCdpSessionOptions = {}) {}

	async withGuest<T>(guest: WebContents, run: (send: CdpSend) => Promise<T>): Promise<T> {
		const alreadyAttached = guest.debugger.isAttached();
		if (alreadyAttached && !this.owned.has(guest.id)) {
			throw new BrowserAgentError("cdp_busy", "该页面已被其他调试器占用（DevTools 或内存探针），请关闭后重试");
		}
		if (!alreadyAttached) {
			try {
				guest.debugger.attach("1.3");
			} catch (error) {
				throw new BrowserAgentError("cdp_unavailable", errorMessage(error));
			}
			this.owned.set(guest.id, guest);
		}
		try {
			return await run((method, params, sessionId) => this.command(guest, method, params, sessionId));
		} finally {
			// 只有本次 attach 的才 detach；复用别人租约时保持原状。
			if (!alreadyAttached) this.release(guest);
		}
	}

	/** 应用退出/服务 dispose 时兜底释放，避免把 guest 锁在 attached 状态。 */
	dispose(): void {
		for (const guest of [...this.owned.values()]) this.release(guest);
	}

	private release(guest: WebContents): void {
		if (!this.owned.delete(guest.id)) return;
		try {
			if (!guest.isDestroyed() && guest.debugger.isAttached()) guest.debugger.detach();
		} catch {
			// best-effort：guest 已销毁或已被 DevTools 接管时 detach 会抛，忽略即可。
		}
	}

	private command(guest: WebContents, method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
		const timeoutMs = this.options.commandTimeoutMs ?? 8000;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new BrowserAgentError("cdp_timeout", `CDP ${method} 超时（${timeoutMs}ms）`));
			}, timeoutMs);
			guest.debugger.sendCommand(method, params, sessionId).then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(error) => {
					clearTimeout(timer);
					reject(new BrowserAgentError("cdp_unavailable", errorMessage(error)));
				},
			);
		});
	}
}
