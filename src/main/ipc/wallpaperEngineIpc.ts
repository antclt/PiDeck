import { dialog, ipcMain, protocol } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { WALLPAPER_ENGINE_ID_RE, WALLPAPER_ENGINE_PROTOCOL, type WallpaperEngineItem, type WallpaperEngineListResult } from "../../shared/wallpaperEngine";
import { createWallpaperEngineHandler, listWallpaperEngineItems, readWallpaperEngineItem } from "../wallpaperEngine/wallpaperEngineLibrary";

interface WallpaperEngineDeps {
	/** 当前设置中的工坊目录（steamapps/workshop/content/431960） */
	getDir: () => string;
}

/** pideck-we:// 协议（app ready 后注册；视频经流式 Response 交给 <video>，不进 IPC） */
export function registerWallpaperEngineProtocol(deps: WallpaperEngineDeps): void {
	protocol.handle(WALLPAPER_ENGINE_PROTOCOL, createWallpaperEngineHandler(deps.getDir));
}

/**
 * 三条窄通道：选目录（只返回用户在系统对话框里选中的路径）、列出条目、校验选中条目。
 * 持久化仍走 settings 域（weWorkshopDir / weWallpaperId），这里不写设置。
 */
export function registerWallpaperEngineIpc(deps: WallpaperEngineDeps): void {
	ipcMain.handle(ipcChannels.wallpaperEnginePickDir, async (): Promise<string> => {
		const result = await dialog.showOpenDialog({ title: "Wallpaper Engine workshop folder (431960)", properties: ["openDirectory"] });
		return result.filePaths[0] ?? "";
	});
	ipcMain.handle(ipcChannels.wallpaperEngineList, async (_event, dir?: unknown): Promise<WallpaperEngineListResult> => {
		return listWallpaperEngineItems(typeof dir === "string" ? dir : deps.getDir());
	});
	ipcMain.handle(ipcChannels.wallpaperEngineSelect, async (_event, dir: unknown, id: unknown): Promise<WallpaperEngineItem | null> => {
		if (typeof dir !== "string" || typeof id !== "string" || !WALLPAPER_ENGINE_ID_RE.test(id)) return null;
		return readWallpaperEngineItem(dir, id);
	});
}
