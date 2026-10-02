import { useEffect, useState } from "react";
import { detectRendererPlatform } from "../../lib/detectRendererPlatform";
import type { AppInfo } from "../../../../shared/types";

/** desktopApi 的最小切片：本 hook 只需要 app 域两个查询 */
type AppInfoApi = {
	app: {
		preferredSystemLanguages: () => Promise<string[]>;
		info: () => Promise<AppInfo>;
	};
};

/**
 * 应用自描述信息域：版本/平台/目录（appInfo）与系统语言（systemLanguage）。
 * - appInfo 首帧用同步平台探测兜底，避免 Mac 在 IPC 返回前误画 Win 窗口按钮；
 * - document.title 与窗口标题规则一致（开发态功能分支带分支名）。
 */
export function useAppBootstrapInfo(api: AppInfoApi): { appInfo: AppInfo; systemLanguage: string | null } {
	const [appInfo, setAppInfo] = useState<AppInfo>({
		version: "-",
		releasesUrl: "https://github.com/ayuayue/PiDeck/releases",
		// 同步判定，避免 Mac 首帧在 appInfo IPC 返回前误画 Win 窗口按钮
		platform: detectRendererPlatform(),
		homeDir: "",
		userDataDir: "",
	});
	const [systemLanguage, setSystemLanguage] = useState<string | null>(null);

	useEffect(() => {
		void api.app
			.preferredSystemLanguages()
			.then((languages) => setSystemLanguage(languages.find((language) => typeof language === "string" && language.trim()) ?? null))
			.catch(() => setSystemLanguage(null));
		void api.app
			.info()
			.then((info) => {
				setAppInfo(info);
				// 与窗口标题一致：开发态功能分支时文档标题带分支名
				document.title = info.devBranch ? `PiDeck · ${info.devBranch}` : "PiDeck";
			})
			.catch(() => undefined);
	}, [api]);

	return { appInfo, systemLanguage };
}
