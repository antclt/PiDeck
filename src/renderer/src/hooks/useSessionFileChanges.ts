/**
 * useSessionFileChanges — 会话级文件修改数据 hook。
 *
 * 数据源：主进程 IPC 全量聚合（从会话文件显示消息提取 write/edit/create/patch，
 * 历史/活会话通用）+ 当前 run 增量合并（流式期未落盘消息立即可见）。
 * 与 useSessionSubagents 同构：切换会话后重建，跨轮次/重启不丢。
 */
import { useEffect, useMemo, useState } from "react";
import type { SessionFileChange } from "../../../shared/types";
import type { AgentRunItem } from "../components/app/AppUtils";
import { collectRunFileChanges } from "../components/session/TimelineFormat";
import { mergeRunFileChanges } from "../components/session/turn/fileChangesMerge";
import { desktopApi } from "../desktopApi";

export function useSessionFileChanges(
	sessionId: string,
	run?: AgentRunItem,
): { entries: SessionFileChange[]; loading: boolean } {
	const [full, setFull] = useState<SessionFileChange[]>([]);
	const [loading, setLoading] = useState(false);

	// 主进程 IPC：拉取会话级全量（初次 / 会话切换时）
	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		desktopApi.sessions
			.listSessionFileChanges(sessionId)
			.then((entries) => {
				if (!cancelled) {
					setFull(entries);
					setLoading(false);
				}
			})
			.catch(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	// 当前 run 增量（流式未落盘部分），与全量合并
	const runEntries = useMemo(() => (run ? collectRunFileChanges(run) : []), [run]);
	const entries = useMemo(() => mergeRunFileChanges(full, runEntries), [full, runEntries]);

	return { entries, loading };
}
