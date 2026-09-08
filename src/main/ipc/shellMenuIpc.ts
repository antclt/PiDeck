import { app, ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { AppLogger } from "../logging/AppLogger";
import {
	isShellContextMenuRegistered,
	registerShellContextMenu,
	unregisterShellContextMenu,
} from "../integrations/shellContextMenu";

export type ShellMenuIpcDeps = {
	appLogger: AppLogger;
	/** 右键菜单显示名（跟随主进程 locale，见 index.ts 装配） */
	menuTitle: string;
};

/**
 * 资源管理器右键菜单 IPC（HKCU 注册，portable / NSIS 安装包都可用）。
 * 开关即注册表状态：启用写 HKCU\Software\Classes\Directory(\(Background\))?\shell\PiDeck，
 * 禁用删键；查询实时读注册表，不落 settings.json（避免双份状态漂移）。
 * 非 Windows 平台不支持，返回 supported=false 让 UI 隐藏开关。
 */
export function registerShellMenuIpc({ appLogger, menuTitle }: ShellMenuIpcDeps): void {
	ipcMain.handle(ipcChannels.shellMenuGetState, async () => {
		if (process.platform !== "win32") return { supported: false, registered: false };
		try {
			return { supported: true, registered: await isShellContextMenuRegistered() };
		} catch (error) {
			void appLogger.warn("shell-menu", "Query context menu registration failed", { error });
			return { supported: true, registered: false };
		}
	});

	ipcMain.handle(ipcChannels.shellMenuSetEnabled, async (_event, enabled: unknown) => {
		if (process.platform !== "win32") throw new Error("SHELL_MENU_UNSUPPORTED");
		try {
			if (enabled) {
				// dev 下 exe 是 electron 二进制，命令必须带 app 路径，否则 Explorer 会启动空白 electron
				const appPath = app.isPackaged ? "" : app.getAppPath();
				await registerShellContextMenu(process.execPath, appPath, menuTitle);
			} else {
				await unregisterShellContextMenu();
			}
			return { supported: true, registered: Boolean(enabled) };
		} catch (error) {
			void appLogger.warn("shell-menu", "Set context menu registration failed", {
				enabled: Boolean(enabled),
				error,
			});
			throw error;
		}
	});
}