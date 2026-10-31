import { useEffect, useRef } from "react";

/**
 * Git 面板的自动刷新策略（v5 W5-2）：把「什么时候偷偷读、什么时候绝不读」从展示组件里拆出来。
 *
 * 四类动作各有独立能力位，缺能力时连 effect 都不注册（不是注册后再 no-op）：
 * - `statusPoll`：5 秒静默 status + 本地 ahead/behind 角标；
 * - `refsWatch`：refs 变化推送 → 静默重读（事件加速，5 秒轮询仍是兜底）；
 * - `autoFetch`：5 分钟 fetch 远程校正 behind；
 * - 窗口重新聚焦补一轮（属于 statusPoll）。
 *
 * 远端面板不挂这个 hook：它没有后台网络写/轮询策略，只在用户动作时读。
 * 本机传全开；未来共用宿主按 backend 能力传 false 即可，不需要在展示层写分支。
 */
export type GitAutoRefreshCapabilities = {
	statusPoll: boolean;
	refsWatch: boolean;
	autoFetch: boolean;
};

export const LOCAL_GIT_AUTO_REFRESH: GitAutoRefreshCapabilities = { statusPoll: true, refsWatch: true, autoFetch: true };

export type GitAutoRefreshOptions = {
	/** layout !== "historyOnly"：只看 Graph/Compare 时不轮询工作区。 */
	enabled: boolean;
	projectId: string;
	/** 非 git 仓库 / 未安装 git：状态恢复前暂停所有自动动作。 */
	suspended: boolean;
	capabilities: GitAutoRefreshCapabilities;
	/** 静默读工作区状态。 */
	refreshStatus: (silent?: boolean) => void | Promise<void>;
	/** 只读本地 refs 的 ahead/behind。 */
	readAheadBehind: () => void | Promise<void>;
	/** 先本地计数再 fetch（仅在自动 fetch 定时器使用）。 */
	refreshAheadBehind: () => void | Promise<void>;
	/** mutation（push/pull/commit）进行中：跳过读，避免把中间态写回。 */
	isMutating: () => boolean;
	/** 宿主是否提供 fetch/aheadBehind；缺席时 5 分钟定时器连注册都不做。 */
	hasFetch: boolean;
	hasAheadBehind: boolean;
	watchRefs?: (projectId: string) => Promise<string>;
	unwatchRefs?: (watchId: string) => Promise<void>;
	onRefsChanged?: (listener: (watchId: string) => void) => () => void;
};

export function useGitAutoRefresh(options: GitAutoRefreshOptions): void {
	const { enabled, projectId, suspended, capabilities, refreshStatus, readAheadBehind, refreshAheadBehind, isMutating, hasFetch, hasAheadBehind, watchRefs, unwatchRefs, onRefsChanged } = options;

	// 5 秒轮询：同时重读本地角标（只读 refs，不发网络）。
	useEffect(() => {
		if (!enabled || !capabilities.statusPoll) return;
		const timer = window.setInterval(() => {
			if (suspended || isMutating() || document.hidden) return;
			void refreshStatus(true);
			void readAheadBehind();
		}, 5000);
		return () => window.clearInterval(timer);
	}, [enabled, capabilities.statusPoll, suspended, refreshStatus, readAheadBehind, isMutating]);

	// 窗口重新聚焦补一轮：常见用法是切到终端让 AI commit/push 再切回来。
	useEffect(() => {
		if (!enabled || !capabilities.statusPoll) return;
		const onFocus = () => {
			if (suspended || isMutating()) return;
			void refreshStatus(true);
			void readAheadBehind();
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [enabled, capabilities.statusPoll, suspended, refreshStatus, readAheadBehind, isMutating]);

	/** 本面板的 refs 监听 id：主进程按 (projectId, repoPath) 分配，多仓时每个面板各一份。 */
	const refsWatchIdRef = useRef<string | null>(null);
	useEffect(() => {
		if (!enabled || !capabilities.refsWatch || suspended) return;
		if (!watchRefs || !unwatchRefs || !onRefsChanged) return;
		let disposed = false;
		const unsubscribe = onRefsChanged((changedId) => {
			if (disposed || refsWatchIdRef.current !== changedId) return;
			// mutation 进行中/窗口不可见时不抢刷新：push 自身已有收尾刷新，隐藏时等 focus 补齐。
			if (isMutating() || document.hidden) return;
			void refreshStatus(true);
			void readAheadBehind();
		});
		void watchRefs(projectId)
			.then((watchId) => {
				// 卸载后才拿到 id：立即退订，否则主进程句柄会残留到最后一个订阅者退出。
				if (disposed) {
					void unwatchRefs(watchId);
					return;
				}
				refsWatchIdRef.current = watchId;
			})
			.catch(() => {
				// 订阅失败不提示：refs 推送只是加速手段，轮询仍在兜底。
			});
		return () => {
			disposed = true;
			unsubscribe();
			const watchId = refsWatchIdRef.current;
			refsWatchIdRef.current = null;
			if (watchId) void unwatchRefs(watchId);
		};
	}, [enabled, capabilities.refsWatch, suspended, projectId, watchRefs, unwatchRefs, onRefsChanged, refreshStatus, readAheadBehind, isMutating]);

	// 5 分钟 fetch 远程：只校正 behind；首次挂载不立刻 fetch，等 refresh 成功确认仓库。
	useEffect(() => {
		if (!enabled || !capabilities.autoFetch || suspended || !hasFetch || !hasAheadBehind) return;
		const timer = window.setInterval(() => {
			if (suspended || isMutating()) return;
			void refreshAheadBehind();
		}, 5 * 60_000);
		return () => window.clearInterval(timer);
	}, [enabled, capabilities.autoFetch, suspended, hasFetch, hasAheadBehind, refreshAheadBehind, isMutating]);
}
