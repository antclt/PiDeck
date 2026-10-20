/**
 * useSessionFileChanges — 「最新一轮」文件修改数据 hook。
 *
 * 数据源：主进程 IPC 聚合（按最后一个 user 消息切分，只返回最新一轮
 * write/edit/create/patch，历史/活会话通用）+ 当前 run 增量合并
 * （流式期未落盘消息立即可见）。
 *
 * 刷新时机（为什么依赖 run?.id）：主进程返回的是「最新一轮」，会话打开时
 * 拉到的是当时的最新一轮；新 run 开始意味着用户发了新一轮提问，此时必须
 * 重拉，否则横栏会一直停留在旧轮次（旧实现只在 sessionId 变化时拉一次，
 * 导致文件随轮次无限堆积）。流式期未落盘部分仍由 run 增量合并补齐。
 */
import { useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import type { SessionFileChange } from "../../../shared/types";
import { collectLatestTurnFileChanges } from "../../../shared/fileChanges";
import type { AgentRunItem } from "../components/app/AppUtils";
import { collectRunFileChanges } from "../components/session/TimelineFormat";
import { mergeRunFileChanges } from "../components/session/turn/fileChangesMerge";
import { desktopApi } from "../desktopApi";
import { sessionMessageCacheBySessionIdAtomFamily } from "../atoms/session-atoms";

/** 稳定空数组：没 PTC 嵌套消息时让 mergeRunFileChanges 保持引用，旧后端行为不变。 */
const EMPTY_FILE_CHANGES: SessionFileChange[] = [];

export function useSessionFileChanges(sessionId: string, run?: AgentRunItem): { entries: SessionFileChange[]; loading: boolean } {
	const [full, setFull] = useState<SessionFileChange[]>([]);
	const [loading, setLoading] = useState(false);

	// 主进程 IPC：拉取最新一轮（初次 / 会话切换 / 新一轮开始）
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
	}, [sessionId, run?.id]);

	// 当前 run 增量（流式未落盘部分），与全量合并
	const runEntries = useMemo(() => (run ? collectRunFileChanges(run) : []), [run]);
	// PTC 侧（DSH run_code）：模型在程序里调 write/edit，顶层只有一张 run_code 卡，主进程对
	// DSH 又固定返回 []（无 pi 会话文件）——两路都拿不到文件。这里改用投影出来的隐藏嵌套
	// 工具消息（meta.ptcNested，见 dshEventProjector 的 tool/ptc-dispatch）自聚合本轮修改。
	// 其它后端消息里没有这个标记，直接返回稳定空数组，合并结果与改前完全一致。
	const cacheEntry = useAtomValue(sessionMessageCacheBySessionIdAtomFamily(sessionId));
	const localEntries = useMemo(() => {
		const messages = cacheEntry?.messages;
		if (!messages || !messages.some((message) => message.meta?.ptcNested === true)) return EMPTY_FILE_CHANGES;
		return collectLatestTurnFileChanges(messages);
	}, [cacheEntry]);
	const entries = useMemo(() => mergeRunFileChanges(mergeRunFileChanges(full, runEntries), localEntries), [full, runEntries, localEntries]);

	return { entries, loading };
}
