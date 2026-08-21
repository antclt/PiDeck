import type { AgentBackend, SessionSource } from "../../shared/types";

/**
 * 会话过滤类别模型（侧栏来源过滤菜单与会话管理弹窗共用）：
 * 来源（pi/codex/claude/opencode）+ DSH 后端。
 *
 * 背景：DSH 会话没有 pi 会话文件（数据在 $DSH_HOME，catalog 只存映射），
 * 其 source 恒为 "pi"、backend 为 "dsh"。因此过滤不能只按来源维度，
 * 必须让每个会话唯一归属一个类别（DSH 按 backend 优先判定），否则
 * DSH 会话会同时命中 Pi 类别造成过滤重复计数或「关掉 Pi 还在」。
 */

/** 会话过滤类别：来源或 DSH 后端。 */
export type SessionFilterPill = SessionSource | "dsh";

/** 类别渲染顺序：来源顺序不变，DSH 追加在末尾（视觉上不打断既有布局）。 */
export const SESSION_FILTER_PILLS: readonly SessionFilterPill[] = [
  "pi",
  "codex",
  "claude",
  "opencode",
  "dsh",
];

/** 字符串是否为合法的过滤类别（持久化数据校验用）。 */
export function isSessionFilterPill(value: unknown): value is SessionFilterPill {
  return typeof value === "string" && (SESSION_FILTER_PILLS as readonly string[]).includes(value);
}

/**
 * 会话归属的类别：DSH 会话按 backend 判定（其 source 恒为 "pi"，
 * 若不优先判定会同时命中 Pi 类别），否则按来源（缺省 "pi"）。
 */
export function sessionPillOf(
  session: { source?: SessionSource; backend?: AgentBackend },
): SessionFilterPill {
  if (session.backend === "dsh") return "dsh";
  return session.source ?? "pi";
}

/** 按激活类别集合过滤会话（一个会话只归属一个类别，不重复命中）。 */
export function filterSessionsByPills<T extends { source?: SessionSource; backend?: AgentBackend }>(
  sessions: readonly T[],
  activePills: ReadonlySet<SessionFilterPill>,
): T[] {
  return sessions.filter((session) => activePills.has(sessionPillOf(session)));
}

/**
 * 过滤配置持久化格式（localStorage key：pideck-session-source-filter）。
 *
 * v2：{ v: 2, filters: { [projectId]: string[] | null } }，数组为 5 个类别。
 * v1（旧版）：{ [projectId]: string[] | null }，数组只有 4 个来源，DSH 会话按
 *   source=pi 显示。读取时迁移：集合含 "pi" 则补 "dsh"——旧用户此前能看到
 *   DSH 会话，升级后必须保持可见，不能静默隐藏；不含 "pi" 说明用户主动
 *   关掉了 pi，DSH 此前也不可见，不补。
 *
 * 版本化还保证新代码不会把用户「显式关掉 DSH」的状态（v2 集合无 dsh）
 * 在下次读取时误迁移成「dsh 已启用」。
 */

/** 持久化格式版本号。 */
export const SESSION_FILTER_STORAGE_VERSION = 2;

/** 解析后的过滤配置（projectId → 允许的类别集合；null = 全部）。 */
export type SessionFilterState = Record<string, Set<SessionFilterPill> | null>;

/** 从原始存储字符串读取过滤配置；损坏/空输入返回空配置（= 全部显示）。 */
export function parseSessionFilterState(raw: string | null | undefined): SessionFilterState {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const state: SessionFilterState = {};
    // v2：按 5 个类别校验（跳过未知字符串；null 保留为「全部」）。
    if ((parsed as { v?: unknown }).v === SESSION_FILTER_STORAGE_VERSION) {
      const records = (parsed as { filters?: unknown }).filters;
      if (!records || typeof records !== "object" || Array.isArray(records)) return {};
      for (const [projectId, value] of Object.entries(records)) {
        if (value === null) {
          state[projectId] = null;
        } else if (Array.isArray(value)) {
          const pills = value.filter(isSessionFilterPill);
          state[projectId] = new Set(pills);
        }
      }
      return state;
    }
    // v1（旧格式）：校验后迁移（见模块注释的迁移规则）。
    for (const [projectId, value] of Object.entries(parsed)) {
      if (value === null) {
        state[projectId] = null;
        continue;
      }
      if (!Array.isArray(value)) continue;
      const pills = value.filter(isSessionFilterPill);
      if (pills.includes("pi") && !pills.includes("dsh")) pills.push("dsh");
      state[projectId] = new Set(pills);
    }
    return state;
  } catch {
    return {};
  }
}

/** 序列化过滤配置为 v2 存储字符串。 */
export function serializeSessionFilterState(state: SessionFilterState): string {
  return JSON.stringify({
    v: SESSION_FILTER_STORAGE_VERSION,
    filters: Object.fromEntries(Object.entries(state).map(([projectId, filter]) => [
      projectId,
      filter === null ? null : [...filter],
    ])),
  });
}
