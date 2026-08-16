import type { MutableRefObject } from "react";
import type {
  AgentBackend,
  CreateAnonymousSessionResult,
  Project,
  SessionRecord,
  SessionLaunchPreferences,
  SessionSummary,
} from "../../../shared/types";
import { isSameSessionPath } from "../agentListDisplay";
import { t } from "../i18n";

/**
 * 新建会话默认后端（C21 统一真相源）：缺省为 pi（经典后端，2026-12 兼容期
 * 从 dsh 回调）。用户可在设置「默认 Agent 后端」中切换为 dsh；运行时值由
 * useSessionActions 的 options.defaultBackend 注入（App 从 settings 读取）。
 * 引导页/匿名会话/侧栏「+」都经这里或显式传值，避免后端默认值分裂（F2）。
 */
export const DEFAULT_AGENT_BACKEND: AgentBackend = "pi";

export type RefreshProjectSessions = (
  projectId: string,
  silent?: boolean,
) => Promise<SessionSummary[] | SessionRecord[] | undefined>;

export interface UseSessionActionsOptions {
  openSessionRequestRef: MutableRefObject<number>;
  creatingSessionDraftRef: MutableRefObject<Set<string>>;
  activeProjectId: string | undefined;
  sessionsProjectId: string | undefined;
  projects: Project[];
  setActiveProjectId: (value: React.SetStateAction<string | undefined>) => void;
  setCurrentSessionId: (value: React.SetStateAction<string | undefined>) => void;
  getSessionRecord: (sessionId: string) => SessionRecord | undefined;
  getProjectSessionRecords: (projectId: string) => SessionRecord[];
  upsertSession: (session: SessionRecord) => void;
  removeSessionState: (sessionId: string) => void;
  removeSessionComposerState: (sessionId: string) => void;
  refreshProjectSessions: RefreshProjectSessions;
  /** 新建会话默认后端（设置项 defaultAgentBackend；缺省走 DEFAULT_AGENT_BACKEND）。 */
  defaultBackend?: AgentBackend;
  api: {
    sessions: {
      copyRecord: (sessionId: string) => Promise<{ cancelled?: boolean; targetSessionId?: string }>;
      exportRecordHtml: (sessionId: string) => Promise<{ path: string }>;
      deleteRecord: (sessionId: string) => Promise<boolean>;
      archiveRecord: (sessionId: string) => Promise<boolean>;
      unarchiveRecord: (archivedPath: string) => Promise<boolean>;
      listArchived: () => Promise<SessionSummary[]>;
      createDraft: (input: { projectId: string; title: string; backend?: AgentBackend } & SessionLaunchPreferences) => Promise<SessionRecord>;
      createAnonymous: (input: { projectId: string; title: string; backend?: AgentBackend } & SessionLaunchPreferences) => Promise<CreateAnonymousSessionResult>;
    };
  };
  showToast: (message: string, duration?: number) => void;
}

/**
 * 会话选择与草稿创建。只负责「当前会话是谁」，不登记 Tab 预览/常驻——
 * 那是 workspace chrome 的事，由 App / 侧栏在边界组合。
 */
export function useSessionActions(options: UseSessionActionsOptions) {
  const {
    openSessionRequestRef,
    creatingSessionDraftRef,
    activeProjectId,
    sessionsProjectId,
    projects,
    setActiveProjectId,
    setCurrentSessionId,
    getSessionRecord,
    getProjectSessionRecords,
    upsertSession,
    removeSessionState,
    removeSessionComposerState,
    refreshProjectSessions,
    api,
    showToast,
  } = options;

  function commitSessionSelection(
    projectId: string,
    sessionId: string | undefined,
    scrollToEnd: boolean,
  ) {
    setActiveProjectId(projectId);
    setCurrentSessionId(sessionId);
    void scrollToEnd;
  }

  function selectProject(projectId: string) {
    ++openSessionRequestRef.current;
    commitSessionSelection(projectId, undefined, false);
  }

  function selectSession(
    projectId: string,
    sessionId: string,
    scrollToEnd = true,
  ) {
    ++openSessionRequestRef.current;
    commitSessionSelection(projectId, sessionId, scrollToEnd);
  }

  async function copySession(
    sessionId: string,
    projectId = sessionsProjectId ?? activeProjectId,
  ) {
    if (!projectId) return;
    const result = await api.sessions.copyRecord(sessionId);
    if (result.cancelled) {
      showToast(t("app.sessionCopyCancelled"));
      return;
    }
    showToast(t("app.sessionCopied"));
    await refreshProjectSessions(projectId);
  }

  async function exportHistorySession(session: SessionSummary) {
    const result = await api.sessions.exportRecordHtml(session.id);
    showToast(t("app.exportedPath", { path: result.path }), 3500);
  }

  async function deleteHistorySession(session: SessionSummary) {
    try {
      await api.sessions.deleteRecord(session.id);
    } catch (error) {
      // 主进程拦截（会话正在使用中/删除失败）必须转成友好 toast，避免未处理 rejection
      // （全局"未处理异常"弹窗）。剥离 Electron invoke 前缀只保留真实原因。
      const raw = error instanceof Error ? error.message : String(error ?? "");
      const reason = raw
        .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, "")
        .replace(/^Error:\s*/i, "")
        .trim();
      showToast(reason || t("app.sessionDeleteFailed"), 5000);
      return;
    }
    removeSessionState(session.id);
    removeSessionComposerState(session.id);
    // G1：DSH 会话删除只删 PiDeck catalog 映射；host 会话数据由 $DSH_HOME 保留
    // （DSH wire 无 session.delete，删映射后数据仍在，提示用户避免「以为删了」）。
    showToast(t(session.backend === "dsh" ? "session.deletedDshKeepData" : "app.sessionDeleted"), 3200);
    const projectId = sessionsProjectId ?? activeProjectId;
    if (projectId) await refreshProjectSessions(projectId);
  }

  /** 归档历史会话：文件移入归档目录并从列表移除（可恢复，区别于删除） */
  async function archiveHistorySession(session: SessionSummary) {
    await api.sessions.archiveRecord(session.id);
    removeSessionState(session.id);
    removeSessionComposerState(session.id);
    showToast(t("app.sessionArchived"), 2200);
    const projectId = sessionsProjectId ?? activeProjectId;
    if (projectId) await refreshProjectSessions(projectId);
  }

  /** 恢复归档会话：文件移回原路径并重新入目录 */
  async function unarchiveHistorySession(archivedPath: string) {
    await api.sessions.unarchiveRecord(archivedPath);
    showToast(t("app.sessionRestored"), 2200);
    const projectId = sessionsProjectId ?? activeProjectId;
    if (projectId) await refreshProjectSessions(projectId);
  }

  /** 列出已归档会话（恢复管理 UI 用） */
  async function listArchivedSessions() {
    return api.sessions.listArchived();
  }

  // ── Sidebar session actions ──
  async function openSidebarSession(
    projectId: string,
    session: SessionSummary,
  ): Promise<string | undefined> {
    const requestSequence = ++openSessionRequestRef.current;
    const cachedRecord = getSessionRecord(session.id);
    let record: SessionRecord | undefined =
      cachedRecord?.projectId === projectId
        ? cachedRecord
        : getProjectSessionRecords(projectId).find(
            (candidate) =>
              candidate.filePath &&
              isSameSessionPath(
                candidate.filePath,
                session.filePath,
                candidate.environment,
              ),
          );
    if (!record) {
      try {
        await refreshProjectSessions(projectId, true);
        if (requestSequence !== openSessionRequestRef.current) return undefined;
        record = getProjectSessionRecords(projectId).find(
          (candidate) =>
            candidate.filePath &&
            isSameSessionPath(
              candidate.filePath,
              session.filePath,
              candidate.environment,
            ),
        );
      } catch (error) {
        if (requestSequence !== openSessionRequestRef.current) return undefined;
        showToast(error instanceof Error ? error.message : String(error), 4000);
        return undefined;
      }
    }
    if (!record || requestSequence !== openSessionRequestRef.current) return undefined;
    commitSessionSelection(projectId, record.id, true);
    return record.id;
  }

  async function openSidebarSessionById(
    projectId: string,
    sessionId: string,
  ): Promise<string | undefined> {
    const requestSequence = ++openSessionRequestRef.current;
    let record: SessionRecord | undefined = getSessionRecord(sessionId);
    if (!record || record.projectId !== projectId) {
      try {
        await refreshProjectSessions(projectId, true);
        if (requestSequence !== openSessionRequestRef.current) return undefined;
        record = getProjectSessionRecords(projectId).find(
          (candidate) => candidate.id === sessionId,
        );
      } catch (error) {
        if (requestSequence !== openSessionRequestRef.current) return undefined;
        showToast(error instanceof Error ? error.message : String(error), 4000);
        return undefined;
      }
    }
    if (!record || requestSequence !== openSessionRequestRef.current) return undefined;
    commitSessionSelection(projectId, record.id, true);
    return record.id;
  }

  async function copySidebarSession(projectId: string, session: SessionSummary) {
    await copySession(session.id, projectId);
  }

  async function exportSidebarSession(_projectId: string, session: SessionSummary) {
    const result = await api.sessions.exportRecordHtml(session.id);
    showToast(t("app.exportedPath", { path: result.path }), 3500);
  }

  async function createSessionDraft(
    projectId = activeProjectId,
    preferences: SessionLaunchPreferences = {},
    // 新建会话默认后端：设置项 defaultAgentBackend（C21 统一真相源；旧会话缺省仍按 pi 语义读取）。
    backend: AgentBackend = options.defaultBackend ?? DEFAULT_AGENT_BACKEND,
  ): Promise<SessionRecord | undefined> {
    if (!projectId || creatingSessionDraftRef.current.has(projectId)) return undefined;
    const project = projects.find((item) => item.id === projectId);
    if (!project) return undefined;
    creatingSessionDraftRef.current.add(projectId);
    try {
      const session = await api.sessions.createDraft({
        projectId,
        title: backend === "dsh" ? `${project.name} DSH` : `${project.name} agent`,
        backend,
        ...preferences,
      });
      upsertSession(session);
      commitSessionSelection(projectId, session.id, true);
      return session;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 4000);
      return undefined;
    } finally {
      creatingSessionDraftRef.current.delete(projectId);
    }
  }

  async function createAnonymousSession(
    projectId = activeProjectId,
    preferences: SessionLaunchPreferences = {},
    backend: AgentBackend = options.defaultBackend ?? DEFAULT_AGENT_BACKEND,
  ): Promise<SessionRecord | undefined> {
    if (!projectId || creatingSessionDraftRef.current.has(projectId)) return undefined;
    const project = projects.find((item) => item.id === projectId);
    if (!project) return undefined;
    creatingSessionDraftRef.current.add(projectId);
    try {
      const { session } = await api.sessions.createAnonymous({
        projectId,
        title: t("app.anonymousChatTitle", { name: project.name }),
        backend,
        ...preferences,
      });
      upsertSession(session);
      commitSessionSelection(projectId, session.id, true);
      return session;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 4000);
      return undefined;
    } finally {
      creatingSessionDraftRef.current.delete(projectId);
    }
  }

  return {
    selectProject,
    selectSession,
    copySession,
    exportHistorySession,
    deleteHistorySession,
    archiveHistorySession,
    unarchiveHistorySession,
    listArchivedSessions,
    openSidebarSession,
    openSidebarSessionById,
    copySidebarSession,
    exportSidebarSession,
    createSessionDraft,
    createAnonymousSession,
  };
}
