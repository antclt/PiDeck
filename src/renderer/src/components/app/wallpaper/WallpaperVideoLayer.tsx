import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { wallpaperEngineVideoUrl } from "../../../../../shared/wallpaperEngine";
import type { AppSettings } from "../../../../../shared/types";
import { isVideoWallpaperActive, shouldPlayVideoWallpaper } from "../../../hooks/appearance/videoWallpaper";

/**
 * Wallpaper Engine 视频壁纸背景层（第一期只做 video）。
 *
 * - portal 到 body、fixed 铺满、z-index 0，位于 #root（z-index 1）之下；
 *   透明度档位沿用 useAppAppearance 注入的壁纸 token，遮罩复用 --app-bg-mask。
 * - <video muted loop playsinline>，src 是 pideck-we://video/<id>：视频字节由主进程协议
 *   按 Range 流式读取，不经 IPC；preload="auto" 交给 Chromium 自行缓冲。
 * - 窗口失焦 / 最小化（document.hidden）时暂停，聚焦后恢复。
 * - 全局只有一个实例；关闭或切换时清空 src 并 load()，立即释放解码器与缓冲。
 */
export function WallpaperVideoLayer({ settings }: { settings: Pick<AppSettings, "weWorkshopDir" | "weWallpaperId"> }) {
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const active = isVideoWallpaperActive(settings);
	const src = active ? wallpaperEngineVideoUrl(settings.weWallpaperId) : "";
	const [playable, setPlayable] = useState(() => shouldPlayVideoWallpaper({ hidden: document.hidden, focused: document.hasFocus() }));

	useEffect(() => {
		if (!src) return;
		const update = () => setPlayable(shouldPlayVideoWallpaper({ hidden: document.hidden, focused: document.hasFocus() }));
		window.addEventListener("focus", update);
		window.addEventListener("blur", update);
		document.addEventListener("visibilitychange", update);
		update();
		return () => {
			window.removeEventListener("focus", update);
			window.removeEventListener("blur", update);
			document.removeEventListener("visibilitychange", update);
		};
	}, [src]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video || !src) return;
		if (playable) void video.play().catch(() => undefined);
		else video.pause();
	}, [playable, src]);

	// 切换/关闭时显式释放：React 卸载 <video> 不保证立刻回收媒体管线
	useEffect(() => {
		const video = videoRef.current;
		return () => {
			if (!video) return;
			video.pause();
			video.removeAttribute("src");
			video.load();
		};
	}, [src]);

	if (!src) return null;
	return createPortal(
		<div className="wallpaper-video-layer" aria-hidden="true" data-testid="wallpaper-video-layer">
			<video ref={videoRef} key={src} src={src} muted loop playsInline autoPlay={playable} preload="auto" disablePictureInPicture />
			<div className="wallpaper-video-mask" />
		</div>,
		document.body,
	);
}
