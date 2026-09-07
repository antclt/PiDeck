/**
 * 应用公告 IPC：渲染层读快照 / 手动刷新 / 已读标记。
 * 入参校验在边界：markRead 的 id 只接受长度合规的字符串（渲染层数据不可信）；
 * list/refresh/markAllRead 无入参。AnnouncementService 内部已做防重入，
 * 这里不做额外的并发控制。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { AnnouncementService } from "../announcements/AnnouncementService";

export function registerAnnouncementIpc(getService: () => AnnouncementService | null): void {
	ipcMain.handle(ipcChannels.announcementList, () => {
		// 服务未装配（启动极早期）时返回空快照而非抛错，渲染层按空态处理
		return getService()?.getState() ?? { items: [], fetchedAt: null, source: "cache", readIds: [] };
	});

	ipcMain.handle(ipcChannels.announcementRefresh, () => {
		const service = getService();
		if (!service) return { items: [], fetchedAt: null, source: "cache", readIds: [] };
		return service.refresh("manual");
	});

	ipcMain.handle(ipcChannels.announcementMarkRead, (_event, id: unknown) => {
		// 边界校验：只接受合理长度字符串；非法入参静默忽略（公告已读不是关键操作）
		if (typeof id !== "string" || id.length === 0 || id.length > 128) return false;
		getService()?.markRead(id);
		return true;
	});

	ipcMain.handle(ipcChannels.announcementMarkAllRead, () => {
		getService()?.markAllRead();
		return true;
	});
}
