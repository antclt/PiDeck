import type { RemoteProjectFactsChange } from "../../../shared/types/remoteHost";

/**
 * Git 面板对远端事实通知的取舍（v5 T4/T8）：只有**当前仓库**的 status 被标脏才重读。
 *
 * 目录事件不应让 Git 面板整块刷新；写入成功后主进程已经标脏 status，这里由活跃面板决定何时读。
 * 订阅随面板卸载消失，隐藏/关闭后不会再有读者被事件推着读。
 */
export type RemoteGitFactsApi = {
	onProjectFactsChanged(projectId: string, callback: (change: RemoteProjectFactsChange) => void): () => void;
};

export function subscribeRemoteGitFacts(api: RemoteGitFactsApi, projectId: string, repoPath: string, refresh: (force: boolean) => void): () => void {
	return api.onProjectFactsChanged(projectId, (change) => {
		const touched = change.scopes.some((scope) => scope.kind === "status" && scope.repoPath === repoPath);
		if (touched) refresh(true);
	});
}
