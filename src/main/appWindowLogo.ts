import { app, nativeImage, type BrowserWindow } from "electron";
import { getAppLogger } from "./logging/sharedLogger";
import { resolveLogoStyle, type LogoStyle } from "../shared/types/settings";
// electron-vite ?asset：构建时复制到输出目录并返回运行时路径（与 index.ts 的 iconPath 同模式）
import classicIconPath from "../build/icon.png?asset";
import piTuiIconPath from "../build/icon-pi-tui.png?asset";

/**
 * 应用窗口/任务栏/Dock 图标的 logo 风格切换。
 *
 * 边界：安装包与 exe 的静态图标（build/icon.ico|icns）恒为 classic——安装身份不随设置变，
 * 这里只管运行时 setIcon：Windows 任务栏/标题栏、Linux 任务栏走 BrowserWindow.setIcon，
 * macOS 走 app.dock.setIcon（窗口左上角是交通灯，无窗口图标概念）。
 */
export function applyWindowLogoStyle(style: LogoStyle | string | null | undefined, getMainWindow: () => BrowserWindow | null): void {
	const resolved = resolveLogoStyle(style);
	const imagePath = resolved === "pi-tui" ? piTuiIconPath : classicIconPath;
	const image = nativeImage.createFromPath(imagePath);
	if (image.isEmpty()) {
		// 图标资源缺失（打包配置漏带/清理工具误删）只影响本风格图标不生效，降级日志不抛
		void getAppLogger()?.warn("app-logo", "Logo style icon image is empty, keeping current icon", { resolved });
		return;
	}
	const win = getMainWindow();
	if (win && !win.isDestroyed()) {
		try {
			win.setIcon(image);
		} catch (error) {
			void getAppLogger()?.warn("app-logo", "Failed to set window icon", { resolved, error: error instanceof Error ? error.message : String(error) });
		}
	}
	if (process.platform === "darwin" && app.dock) {
		try {
			app.dock.setIcon(image);
		} catch (error) {
			void getAppLogger()?.warn("app-logo", "Failed to set dock icon", { resolved, error: error instanceof Error ? error.message : String(error) });
		}
	}
}
