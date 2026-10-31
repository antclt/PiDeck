/**
 * 远端 Git 能力说明条的显示判据（纯函数，task-5）。
 *
 * RemoteGitPanel 只服务远端项目，缺失能力是静态事实；这里不猜 backend，也不新增协议能力位：
 * - history：只有展开历史时才显示 HEAD-only 说明（不提供 ref/path/allBranches 过滤、总数、图）；
 * - commit：提交区可见时提示逐文件暂存、不支持批量/智能/AI；
 * - repoScope：发现多个仓库时提示一次只读一个仓，不能并排；
 * - compare：对比区展开且是 trees 语义时提示没有 merge-base / ahead/behind。
 */
export type RemoteGitCapabilityNoteKind = "history" | "commit" | "repoScope" | "compare";

export type RemoteGitCapabilityNoteContext = {
	/** 历史区已展开。 */
	historyOpen?: boolean;
	/** 提交区可见（已有确认的快照且不在 diff 视图）。 */
	commitVisible?: boolean;
	/** 仓库发现结果数量（0/1 不提示多仓）。 */
	repoCount?: number;
	/** 对比区已展开。 */
	compareOpen?: boolean;
	/** 对比语义；remote 当前固定 trees，merge-base 才支持 ahead/behind。 */
	compareMode?: "merge-base" | "trees";
};

export function shouldShowRemoteGitCapabilityNote(kind: RemoteGitCapabilityNoteKind, context: RemoteGitCapabilityNoteContext = {}): boolean {
	switch (kind) {
		case "history":
			return context.historyOpen === true;
		case "commit":
			return context.commitVisible === true;
		case "repoScope":
			return (context.repoCount ?? 0) > 1;
		case "compare":
			// 真实语义优先：mode 来自 compareRefs 答案（remoteGitViewState 透传）。未填 = 旧的 remoteCompare
			// 兼容壳或还没得到答案，远端那条路本来就是两树比较，仍按 trees-only 说明。
			return context.compareOpen === true && context.compareMode !== "merge-base";
	}
}
