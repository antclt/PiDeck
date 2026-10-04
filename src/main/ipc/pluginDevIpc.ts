/**
 * 插件开发 IPC（plugin-dev: 域）：只做入参校验与适配，行为在 PluginDevService。
 * 与 themesIpc 同模式：写完文件用资源管理器定位，方便用户把路径直接丢给 AI。
 */
import { ipcMain, shell } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { GuideLocale } from "../../shared/pluginDevCatalog";
import type { PluginDevService } from "../extensions/PluginDevService";

function toGuideLocale(value: unknown): GuideLocale {
	return value === "en-US" ? "en-US" : "zh-CN";
}

export function registerPluginDevIpc(service: PluginDevService): void {
	ipcMain.handle(ipcChannels.pluginDevStatus, () => service.status());
	ipcMain.handle(ipcChannels.pluginDevWriteGuide, async (_event, locale: unknown) => {
		const file = await service.writeGuide(toGuideLocale(locale));
		shell.showItemInFolder(file);
		return file;
	});
	ipcMain.handle(ipcChannels.pluginDevCopyDemo, async () => {
		const result = await service.copyDemoPlugin();
		if (result.status === "copied") shell.showItemInFolder(result.path);
		return result;
	});
}
