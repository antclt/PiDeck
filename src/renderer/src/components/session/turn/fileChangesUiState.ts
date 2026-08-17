/**
 * 「本轮文件修改」列表的展示偏好存取（纯逻辑，供 TurnFileChanges 与单测共用）。
 *
 * 折叠/展开全部是用户的显式操作：时间线按 turn 挂载窗口裁剪（贴底仅挂 3 轮、
 * 上滚历史按 cohort 展开），TurnRow 滚出窗口即卸载，组件本地 state 会随卸载
 * 丢失——偏好按 run 身份存模块级 store，重挂载时按同一 key 找回。
 * key 用 run.id + startedAt（run.id 是首条消息 id，拼时间戳后跨会话碰撞可忽略）；
 * 只在用户切换时写入，Map 大小有界。
 */
import type { AgentRunItem } from "../timeline/types";

/** 列表默认最多平铺展示的文件行数；超出后折叠为「展开全部」，避免一轮修改十几个文件时整屏铺满。 */
export const MAX_VISIBLE_FILES = 3;

export type TurnFileChangesPref = { collapsed: boolean; showAll: boolean };

const fileChangesPrefs = new Map<string, TurnFileChangesPref>();

/** run 身份 → 偏好 key（同一 run 稳定，不同 run 不冲突）。 */
export function fileChangesPrefKey(run: AgentRunItem): string {
	return `${run.id}:${run.startedAt}`;
}

/** 读取某 run 已保存的偏好；未保存过返回 undefined（组件用默认值）。 */
export function readFileChangesPref(key: string): TurnFileChangesPref | undefined {
	return fileChangesPrefs.get(key);
}

/** 保存某 run 的偏好（用户显式切换时调用）。 */
export function writeFileChangesPref(key: string, pref: TurnFileChangesPref): void {
	fileChangesPrefs.set(key, pref);
}

/** 按偏好与总文件数计算实际展示行数：未展开全部时截断到 MAX_VISIBLE_FILES，展开后全量。 */
export function visibleFileCount(total: number, showAll: boolean): number {
	if (showAll) return total;
	return Math.min(total, MAX_VISIBLE_FILES);
}