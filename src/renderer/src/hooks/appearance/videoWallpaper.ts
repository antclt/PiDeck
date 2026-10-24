import { WALLPAPER_ENGINE_ID_RE } from "../../../../shared/wallpaperEngine";
import type { AppSettings } from "../../../../shared/types";

/** 视频壁纸是否生效：工坊目录已设置且选中 ID 合法。 */
export function isVideoWallpaperActive(settings: Pick<AppSettings, "weWorkshopDir" | "weWallpaperId">): boolean {
	return Boolean(settings.weWorkshopDir) && WALLPAPER_ENGINE_ID_RE.test(settings.weWallpaperId ?? "");
}

/**
 * 视频壁纸何时应播放：窗口可见且聚焦。失焦、最小化（document.hidden）都暂停，
 * 解码器停在当前帧，CPU/GPU 占用随之回落。
 */
export function shouldPlayVideoWallpaper(state: { hidden: boolean; focused: boolean }): boolean {
	return !state.hidden && state.focused;
}
