import type { WebContents } from "electron";
import { selectBrowserGuest, type BrowserGuestCandidate } from "./browserTarget";

/**
 * 当前内置浏览器 guest 的进程内登记表。
 *
 * 为什么需要：主进程在 did-attach-webview 里已经拿到 guest，但只做了安全校验就丢弃
 * （src/main/index.ts:2229-2244）；Agent 要操作页面必须留住引用。
 *
 * 生命周期配对（AGENTS 稳定性约束）：attach 时登记并挂 destroyed 清理，dispose 时摘掉监听。
 * 抽屉收起/全屏切换会销毁并重建 webview，因此这里必须允许同 id 反复登记、且 resolve 不缓存引用。
 */

export type BrowserGuestRegistryDeps = {
	/** 运行时枚举全部 webContents（生产传 webContents.getAllWebContents）。 */
	listAll: () => WebContents[];
	/** 判定是否属于内置浏览器分区（生产传 session 身份比较；Electron 43 的 session.partition 是 undefined）。 */
	isBrowserPanelGuest: (guest: WebContents) => boolean;
};

export class BrowserGuestRegistry {
	private readonly guests = new Map<number, WebContents>();
	private readonly cleanups = new Map<number, () => void>();

	constructor(private readonly deps: BrowserGuestRegistryDeps) {}

	/** did-attach-webview 时登记。重复登记同一 guest 直接忽略，避免重复挂 destroy 监听。 */
	attach(guest: WebContents): void {
		if (guest.isDestroyed() || this.guests.has(guest.id)) return;
		this.guests.set(guest.id, guest);
		const cleanup = () => {
			if (this.guests.get(guest.id) === guest) this.guests.delete(guest.id);
			this.cleanups.delete(guest.id);
		};
		this.cleanups.set(guest.id, cleanup);
		guest.once("destroyed", cleanup);
	}

	detach(id: number): void {
		const guest = this.guests.get(id);
		if (!guest) return;
		const cleanup = this.cleanups.get(id);
		if (cleanup) guest.removeListener("destroyed", cleanup);
		this.cleanups.delete(id);
		this.guests.delete(id);
	}

	/**
	 * 解析当前可操作的 guest。
	 * 先看登记表；登记表为空时按分区身份从运行时列表兜底（覆盖"attach 早于 registry 装配"的重建场景）。
	 * 返回 null = 浏览器面板当前没打开 / guest 已销毁，调用方回 browser_not_open。
	 */
	resolve(): BrowserGuestCandidate<WebContents> | null {
		for (const [id, guest] of [...this.guests]) {
			if (guest.isDestroyed()) this.detach(id);
		}
		const registered = [...this.guests.values()];
		const fromRegistry = selectBrowserGuest(registered, this.deps.isBrowserPanelGuest);
		if (fromRegistry) return fromRegistry;
		return selectBrowserGuest(this.deps.listAll(), this.deps.isBrowserPanelGuest);
	}

	dispose(): void {
		for (const id of [...this.guests.keys()]) this.detach(id);
	}
}
