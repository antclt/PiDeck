import { useEffect, useState } from "react";
import { desktopApi } from "../desktopApi";

/**
 * pi 全局配置目录（源文件页标注实际编辑位置）。
 *
 * 只在本地目标有意义：远端/WSL 目标的路径不从这里取（configGetDir 是单例本机目录，
 * 拿它标 WSL 路径会把两套作用域混在一起）。读取失败时静默降级为不显示路径。
 */
export function usePiConfigDir(open: boolean): string | null {
	const [dir, setDir] = useState<string | null>(null);
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		void desktopApi.config
			.getConfigDir()
			.then((value) => {
				if (!cancelled) setDir(value);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [open]);
	return dir;
}
