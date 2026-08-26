/**
 * 历史消息改写的路径分类（编辑/删除/重发）。
 *
 * 核心差异：「会话是否落盘（有 JSONL 文件）」决定操作方式，agent 是否 live 决定要不要先停。
 * - persisted（有文件）：改文件（catalog）。live = agent 仍在跑（starting/idle/running）
 *   → 需先停再改；error/closed/未启动则直接改文件。
 * - 匿名（--no-session，无文件）：pi 的 edit/delete/resend 三条命令在 AgentManager 里
 *   都要求 runtime.tab.sessionPath，缺失即抛 "Session not persisted"——因此「运行中走
 *   runtime 命令」这条旧路永远失败。编辑/删除只能明确告知不支持；重发退化为把原消息
 *   文本重新提交（没有文件可截断旧轮次，新轮次就是一次新尝试）。
 * - 生图 draft（无 pi JSONL、直连生图 API）：重发把失败提示词放回输入框（ImageSessionStore
 *   兜底历史），见 restoreImageGenTurn。
 *
 * live 由调用方按运行时 status 判定后显式传入：target 存在不代表 live（error/closed
 * 终态 Agent 仍持有绑定，target 非空但进程已死，不能再走「先停」路径）。
 */
export type HistoryMutationKind = "edit" | "delete" | "resend";

export type HistoryMutationPath =
  | { path: "unsupported-anonymous"; reason: Exclude<HistoryMutationKind, "resend"> }
  | { path: "runtime-anonymous-resend" }
  | { path: "imagegen-resend" }
  | { path: "catalog"; live: boolean };

export function resolveHistoryMutationPath(options: {
  kind: HistoryMutationKind;
  live: boolean;
  persisted: boolean;
  isImageGenSession?: boolean;
}): HistoryMutationPath {
  const { kind, live, persisted, isImageGenSession } = options;
  if (persisted) {
    return { path: "catalog", live };
  }
  if (kind === "resend") {
    if (isImageGenSession) return { path: "imagegen-resend" };
    return { path: "runtime-anonymous-resend" };
  }
  return { path: "unsupported-anonymous", reason: kind };
}
