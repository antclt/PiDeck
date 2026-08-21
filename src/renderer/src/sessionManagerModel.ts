import type { SessionSummary } from "../../shared/types";

/**
 * 会话管理弹窗（SessionManagerModal）的纯策略层：收录条件、行身份与归档视图合并。
 * 全部为纯函数，便于 tests/*.test.mjs 直接单测。
 *
 * 过滤类别（pill）的共享模型在 sessionFilterPills.ts（侧栏来源过滤菜单同款），
 * 弹窗侧只保留自身专属策略。
 */

/**
 * 会话管理弹窗收录条件：
 * - pi/导入会话：有会话文件（filePath）才进（草稿无文件，侧栏单独展示，不进弹窗）；
 * - DSH 会话：没有 pi 会话文件，按 host 会话 id（dshSessionId）判定；
 *   DSH 草稿（未发送、无 host id）同样不进弹窗，与 pi 草稿语义一致。
 */
export function isManagerSessionSummary(summary: SessionSummary): boolean {
  if (summary.backend === "dsh") return Boolean(summary.dshSessionId);
  return Boolean(summary.filePath);
}

/**
 * 行身份：SessionRecord.id 跨重启稳定，pi/DSH 均唯一。
 * 不能沿用 filePath：DSH 会话无文件路径（空串会让多行 key 冲突、选中集合错乱）。
 */
export function sessionManagerRowKey(summary: SessionSummary): string {
  return summary.id;
}

/** 归档视图合并行：pi 会话按文件恢复；DSH 会话按 host id 恢复。 */
export type ManagerArchivedRow =
  | { kind: "pi"; session: SessionSummary }
  | { kind: "dsh"; dshSessionId: string; cwd: string; archivedAt: number };

/** 归档行时间戳（排序用）：pi 用 updatedAt，DSH 用 archivedAt。 */
function managerArchivedTimestamp(row: ManagerArchivedRow): number {
  return row.kind === "pi" ? row.session.updatedAt : row.archivedAt;
}

/** 合并 pi / DSH 归档清单为一个视图，按时间倒序（pi 列表已排序，DSH 按归档时间排序）。 */
export function mergeManagerArchived(
  piSessions: readonly SessionSummary[],
  dshItems: readonly { dshSessionId: string; cwd: string; archivedAt: number }[],
): ManagerArchivedRow[] {
  return [
    ...piSessions.map((session) => ({ kind: "pi" as const, session })),
    ...dshItems.map((item) => ({ kind: "dsh" as const, ...item })),
  ].sort((a, b) => managerArchivedTimestamp(b) - managerArchivedTimestamp(a));
}
