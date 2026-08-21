import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { AppLogger } from "../logging/AppLogger";
import {
	readClipboardFilePaths,
	readClipboardHtml,
	readClipboardImageDataUrl,
	readClipboardText,
	writeClipboardImageDataUrl,
} from "../clipboard/nativeClipboard";

export type ClipboardIpcDeps = {
	appLogger: Pick<AppLogger, "warn">;
};

/**
 * 系统剪贴板必须走主进程：Electron 38 废弃了渲染进程/preload 直连 clipboard，
 * 复制图片会失败且 DevTools 只看到 deprecation 警告。
 * 读取用 sendSync（粘贴菜单/Ctrl+V 需要同步）；写入图片用 invoke（data URL 可能较大）。
 */
export function registerClipboardIpc({ appLogger }: ClipboardIpcDeps): void {
	ipcMain.on(ipcChannels.clipboardReadText, (event) => {
		event.returnValue = readClipboardText();
	});
	ipcMain.on(ipcChannels.clipboardReadHtml, (event) => {
		event.returnValue = readClipboardHtml();
	});
	ipcMain.on(ipcChannels.clipboardReadImage, (event) => {
		event.returnValue = readClipboardImageDataUrl();
	});
	ipcMain.on(ipcChannels.clipboardReadFilePaths, (event) => {
		event.returnValue = readClipboardFilePaths();
	});
	ipcMain.handle(ipcChannels.clipboardWriteImage, async (_event, dataUrl: unknown) => {
		const result = writeClipboardImageDataUrl(dataUrl);
		if (!result.ok) {
			void appLogger.warn("clipboard", "native writeImage failed", {
				reason: result.reason,
				payloadChars: typeof dataUrl === "string" ? dataUrl.length : 0,
			});
		}
		return result.ok;
	});
}
