/**
 * 活会话文件增量合并（纯函数，供 useSessionFileChanges 与单测共用）。
 *
 * 合并规则（KISS）：
 * - 全量（主进程 IPC，已落盘）为主；
 * - 当前 run 中全量没有的 path 直接加入（流式期未落盘消息立即可见）；
 * - 全量已有的 path 用 run 最新 diff 覆盖内容、count 沿用全量——避免流式期
 *   未落盘消息与已落盘统计重复计数；run 结束 / 全量刷新后自然收敛。
 */
import type { SessionFileChange } from "../../../../../shared/types";

export function mergeRunFileChanges(
	full: SessionFileChange[],
	runEntries: SessionFileChange[],
): SessionFileChange[] {
	if (runEntries.length === 0) return full;
	const map = new Map(full.map((f) => [f.path, f]));
	for (const r of runEntries) {
		const existing = map.get(r.path);
		if (existing) {
			map.set(r.path, {
				...existing,
				originalContent: r.originalContent,
				content: r.content,
			});
		} else {
			map.set(r.path, r);
		}
	}
	return [...map.values()];
}
