import { useEffect, useRef } from "react";
import { useSetAtom } from "jotai";
import type { PiDesktopApi } from "../../../preload";
import type { AppUpdateInfo } from "../../../shared/types";
import { updateStatusAtom } from "../atoms/update-atoms";
import { t } from "../i18n";

export type BackgroundUpdateWatchOptions = {
	api: PiDesktopApi;
	/** 触发更新弹窗详情拉取（复用 useAppUpdateController.check）。 */
	appUpdateCheck: (source: "auto" | "manual") => Promise<AppUpdateInfo | null>;
	showToast: (message: string, duration?: number) => void;
};

/**
 * 后台更新状态订阅：消费主进程 app:update-status-changed 快照。
 *
 * 判定规则（对齐「有更新才提示，每版本一次」）：
 *   - PiDeck：hasUpdate 且 未跳过 且 未提示过 → 触发弹窗（弹窗关闭时由调用方 notifySeen）；
 *   - Pi CLI：hasUpdate 且 未提示过 → toast 一次并立即 notifySeen（更新入口在设置页）。
 * 本地 ref 再兜一层去重，防快照重发/异步标记竞态导致重复提示。
 */
export function useBackgroundUpdateWatch(options: BackgroundUpdateWatchOptions): void {
	const { api, appUpdateCheck, showToast } = options;
	const setUpdateStatus = useSetAtom(updateStatusAtom);
	const notifiedRef = useRef<{ app?: string; pi?: string }>({});

	useEffect(() => {
		// 初始拉取当前快照（挂载晚于主进程首查时也能拿到状态）。
		void api.app.getUpdateStatus().then((snapshot) => {
			if (snapshot) setUpdateStatus(snapshot);
		});

		const unsubscribe = api.app.onUpdateStatus((snapshot) => {
			setUpdateStatus(snapshot);

			const appStatus = snapshot?.app;
			if (
				appStatus?.hasUpdate &&
				appStatus.latestVersion !== appStatus.skippedVersion &&
				appStatus.latestVersion !== appStatus.notifiedVersion &&
				notifiedRef.current.app !== appStatus.latestVersion
			) {
				notifiedRef.current.app = appStatus.latestVersion;
				void appUpdateCheck("auto");
			}

			const piStatus = snapshot?.piCli;
			if (
				piStatus?.hasUpdate &&
				piStatus.latestVersion &&
				piStatus.latestVersion !== piStatus.notifiedVersion &&
				notifiedRef.current.pi !== piStatus.latestVersion
			) {
				notifiedRef.current.pi = piStatus.latestVersion;
				// 立即标记已提示（主进程持久化），重启后同一版本不再打扰。
				void api.app.notifyUpdateSeen("pi", piStatus.latestVersion);
				showToast(t("settings.piUpdateAvailable"));
			}
		});

		return () => unsubscribe();
	}, [api, appUpdateCheck, showToast, setUpdateStatus]);
}
