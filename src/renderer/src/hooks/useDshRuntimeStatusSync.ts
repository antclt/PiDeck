/**
 * DSH runtime 安装态同步（AgentRuntimeProvider 阶段 1 唯一 owner）。
 *
 * App 挂载一份：拉取 dsh-runtime:get-status 并订阅 status-changed 推送，
 * 写入 dshRuntimeStatusAtom；其余组件只读 atom（多实例订阅会重复 IPC）。
 * 拉取失败按 notInstalled 兜底——拿不到状态时宁可隐藏 DSH UI，也不让用户
 * 踩进「入口可见、点了裸报错」的坑。
 */
import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { dshRuntimeStatusAtom } from "../atoms/dsh-atoms";
import { desktopApi } from "../desktopApi";

export function useDshRuntimeStatusSync(): void {
	const setStatus = useSetAtom(dshRuntimeStatusAtom);
	useEffect(() => {
		let disposed = false;
		const apply = (status: { state: "installed" | "notInstalled" | "checking" | "broken"; runtimeVersion?: string }) => {
			if (!disposed) setStatus(status);
		};
		void desktopApi.sessions
			.getDshRuntimeStatus()
			.then(apply)
			.catch(() => apply({ state: "notInstalled" }));
		const unsubscribe = desktopApi.sessions.onDshRuntimeStatusChanged(apply);
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, [setStatus]);
}
