import { useCallback, useEffect, useRef, useState } from "react";
import { useSetAtom } from "jotai";
import type { ChatMessage, ImageContent, SessionRuntimeTarget } from "../../../shared/types";
import { desktopApi as api } from "../desktopApi";
import { t } from "../i18n";
import {
  cacheSessionMessagesAtom,
  setSessionHistoryMutationOverlayAtom,
  setSessionMessageLoadStateAtom,
  type SessionHistoryMutationOverlayKind,
} from "../atoms/session-atoms";
import {
  requireSessionCommand,
  sessionCommandFailureToast,
} from "../utils/sessionCommands";

type ConfirmConfig = {
  title: string;
  message: string;
  onConfirm: () => void;
  danger?: boolean;
  confirmLabel?: string;
};

export interface SessionHistoryMutationsDeps {
  currentSessionId: string | undefined;
  getRuntimeTargetForSession: (sessionId: string | undefined) => SessionRuntimeTarget | undefined;
  getRuntimeTargetForAgent: (agentId: string | undefined) => SessionRuntimeTarget | undefined;
  showConfirm: (config: ConfirmConfig) => void;
  clearConfirm: () => void;
  showToast: (message: string, duration?: number) => void;
  translateAgentErrorMessage: (message: string) => string;
  submitPromptSnapshot: (
    sessionId: string,
    message: string,
    images?: ImageContent[],
  ) => Promise<boolean | "unknown">;
  openReplacedRuntimeSession: (
    projectId: string | undefined,
    targetSessionId: string | undefined,
  ) => Promise<void>;
  setPromptForAgent: (sessionId: string, text: string) => void;
  setCurrentSessionIdRef: (sessionId: string) => void;
  isAgentCurrentlyBusy: () => boolean;
  resolveProjectId: (sessionId: string) => string | undefined;
  /** 有会话文件才走 catalog JSONL；匿名会话没有文件，仍用 runtime 命令。 */
  hasPersistedSessionFile: (sessionId: string) => boolean;
}

/**
 * pi 历史消息改写：无 runtime 直接改 JSONL；有 runtime 先停 Agent 再改文件。
 * DSH 不走这条（入口已按 backend 隐藏）。下次发送才会重新激活 Agent。
 */
export function useSessionHistoryMutations(deps: SessionHistoryMutationsDeps) {
  const setOverlay = useSetAtom(setSessionHistoryMutationOverlayAtom);
  const cacheMessages = useSetAtom(cacheSessionMessagesAtom);
  const setLoadState = useSetAtom(setSessionMessageLoadStateAtom);
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  const resendingIdsRef = useRef<Set<string>>(new Set());
  const overlaySessionRef = useRef<string | undefined>(undefined);
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const showOverlay = useCallback((sessionId: string, kind: SessionHistoryMutationOverlayKind) => {
    overlaySessionRef.current = sessionId;
    setOverlay({ sessionId, kind });
  }, [setOverlay]);

  const hideOverlay = useCallback((sessionId: string) => {
    if (overlaySessionRef.current === sessionId) overlaySessionRef.current = undefined;
    setOverlay({ sessionId, kind: null });
  }, [setOverlay]);

  useEffect(() => {
    return () => {
      const sessionId = overlaySessionRef.current;
      if (sessionId) setOverlay({ sessionId, kind: null });
    };
  }, [setOverlay]);

  const failToast = useCallback((prefix: string, error: unknown) => {
    const latest = depsRef.current;
    latest.showToast(
      `${prefix}: ${sessionCommandFailureToast(error, latest.translateAgentErrorMessage)}`,
      5000,
    );
  }, []);

  const reloadTimelineFromDisk = useCallback(async (sessionId: string) => {
    showOverlay(sessionId, "reloading");
    setLoadState({ sessionId, state: { status: "loading" } });
    const page = await api.sessions.readRecordMessagePage(sessionId, undefined, 100);
    cacheMessages({
      sessionId,
      messages: page.messages,
      source: "disk",
      expectedRevision: 0,
      page: { total: page.total, nextBefore: page.nextBefore },
      force: true,
    });
    setLoadState({ sessionId, state: { status: "ready" } });
  }, [cacheMessages, setLoadState, showOverlay]);

  /** 运行中则先停：产品规则是改文件而不是 switch_session，避免内存树和磁盘分叉。 */
  const stopIfRunning = useCallback(async (sessionId: string) => {
    const target = depsRef.current.getRuntimeTargetForSession(sessionId);
    if (!target) return;
    showOverlay(sessionId, "stopping");
    requireSessionCommand(await api.sessions.stopRuntime(target));
  }, [showOverlay]);

  const confirmStopIfRunning = useCallback((
    sessionId: string,
    copy: { title: string; message: string; confirmLabel: string },
    onConfirmed: () => Promise<void>,
  ) => {
    const latest = depsRef.current;
    const live = Boolean(latest.getRuntimeTargetForSession(sessionId));
    if (!live) {
      void onConfirmed();
      return;
    }
    latest.showConfirm({
      title: copy.title,
      message: copy.message,
      danger: true,
      confirmLabel: copy.confirmLabel,
      onConfirm: () => {
        latest.clearConfirm();
        void onConfirmed();
      },
    });
  }, []);

  const runFileMutation = useCallback(async (
    sessionId: string,
    work: () => Promise<void>,
  ) => {
    try {
      await stopIfRunning(sessionId);
      showOverlay(sessionId, "mutating");
      await work();
      await reloadTimelineFromDisk(sessionId);
    } finally {
      hideOverlay(sessionId);
    }
  }, [hideOverlay, reloadTimelineFromDisk, showOverlay, stopIfRunning]);

  const editMessage = useCallback(async (messageId: string, newText: string) => {
    const latest = depsRef.current;
    const sessionId = latest.currentSessionId;
    if (!sessionId) return;
    const target = latest.getRuntimeTargetForSession(sessionId);
    // 匿名/--no-session 没有 JSONL：只能在运行中走 switch_session，不能先停再改文件。
    if (target && !latest.hasPersistedSessionFile?.(sessionId)) {
      try {
        requireSessionCommand(
          await api.sessions.editRuntimeMessage(target, messageId, newText),
        );
      } catch (error) {
        failToast(t("message.editFailed"), error);
      }
      return;
    }
    confirmStopIfRunning(sessionId, {
      title: t("message.historyStopToEditTitle"),
      message: t("message.historyStopToEditBody"),
      confirmLabel: t("app.stop"),
    }, async () => {
      try {
        await runFileMutation(sessionId, async () => {
          requireSessionCommand(
            await api.sessions.editCatalogMessage(sessionId, messageId, newText),
          );
        });
      } catch (error) {
        failToast(t("message.editFailed"), error);
      }
    });
  }, [confirmStopIfRunning, failToast, runFileMutation]);

  const deleteMessage = useCallback((messageId: string) => {
    const latest = depsRef.current;
    const sessionId = latest.currentSessionId;
    if (!sessionId) return;
    const target = latest.getRuntimeTargetForSession(sessionId);
    const persisted = latest.hasPersistedSessionFile(sessionId);
    if (target && !persisted) {
      latest.showConfirm({
        title: t("message.deleteTitle"),
        message: t("message.deleteReloadPrompt"),
        danger: true,
        confirmLabel: t("common.delete"),
        onConfirm: async () => {
          latest.clearConfirm();
          try {
            requireSessionCommand(
              await api.sessions.deleteRuntimeMessage(target, messageId),
            );
          } catch (error) {
            failToast(t("message.deleteFailed"), error);
          }
        },
      });
      return;
    }
    const live = Boolean(target);
    latest.showConfirm({
      title: t("message.deleteTitle"),
      message: live ? t("message.historyStopToDeleteBody") : t("message.deleteReloadPrompt"),
      danger: true,
      confirmLabel: live ? t("app.stop") : t("common.delete"),
      onConfirm: async () => {
        latest.clearConfirm();
        try {
          await runFileMutation(sessionId, async () => {
            requireSessionCommand(
              await api.sessions.deleteCatalogMessage(sessionId, messageId),
            );
          });
        } catch (error) {
          failToast(t("message.deleteFailed"), error);
        }
      },
    });
  }, [failToast, runFileMutation]);

  const resendUserMessage = useCallback((message: ChatMessage) => {
    const latest = depsRef.current;
    const sessionId = latest.currentSessionId;
    if (!sessionId) return;
    if (resendingIdsRef.current.has(message.id)) return;
    const target = latest.getRuntimeTargetForSession(sessionId);
    const persisted = latest.hasPersistedSessionFile(sessionId);
    const runAnonymous = async () => {
      if (!target) return;
      resendingIdsRef.current.add(message.id);
      setTimeout(() => resendingIdsRef.current.delete(message.id), 30_000);
      try {
        const snapshot = requireSessionCommand(
          await api.sessions.prepareRuntimeResend(target, message.id),
        ).value;
        await latest.submitPromptSnapshot(sessionId, snapshot.text, snapshot.images);
      } catch (error) {
        failToast(t("message.resendFailed"), error);
      } finally {
        resendingIdsRef.current.delete(message.id);
      }
    };
    if (target && !persisted) {
      void runAnonymous();
      return;
    }
    const run = async () => {
      resendingIdsRef.current.add(message.id);
      setTimeout(() => resendingIdsRef.current.delete(message.id), 30_000);
      try {
        let snapshot: { text: string; images?: ImageContent[] } | undefined;
        await runFileMutation(sessionId, async () => {
          snapshot = requireSessionCommand(
            await api.sessions.prepareCatalogResend(sessionId, message.id),
          );
        });
        if (!snapshot) return;
        showOverlay(sessionId, "activating");
        await depsRef.current.submitPromptSnapshot(sessionId, snapshot.text, snapshot.images);
      } catch (error) {
        failToast(t("message.resendFailed"), error);
      } finally {
        resendingIdsRef.current.delete(message.id);
        hideOverlay(sessionId);
      }
    };
    confirmStopIfRunning(sessionId, {
      title: t("message.historyStopToResendTitle"),
      message: t("message.historyStopToResendBody"),
      confirmLabel: t("app.stop"),
    }, run);
  }, [confirmStopIfRunning, failToast, hideOverlay, runFileMutation, showOverlay]);

  const resolveForkEntryId = useCallback(async (
    message: ChatMessage,
    agentId?: string,
  ): Promise<string | undefined> => {
    if (typeof message.meta?.entryId === "string" && message.meta.entryId) {
      return message.meta.entryId;
    }
    const marker = "-history-";
    const historyIndex = message.id.lastIndexOf(marker);
    if (historyIndex >= 0) {
      const fromId = message.id.slice(historyIndex + marker.length).trim();
      if (fromId && fromId !== String(message.meta?._piDeckMsgSeq ?? "") && !/^\d+$/.test(fromId)) {
        return fromId;
      }
    }
    if (!agentId) return undefined;
    const target = depsRef.current.getRuntimeTargetForAgent(agentId);
    if (!target) return undefined;
    try {
      const wrapped = requireSessionCommand(
        await api.sessions.getRuntimeForkMessages(target),
      );
      // IPC 形状是 SessionTargetedValue<Array>；兼容误拆一层的数组。
      const forkMessages = Array.isArray(wrapped) ? wrapped : wrapped.value;
      const targetText = message.text.trim();
      if (!targetText || !Array.isArray(forkMessages)) return undefined;
      for (let i = forkMessages.length - 1; i >= 0; i -= 1) {
        const item = forkMessages[i];
        if (item?.entryId && item.text?.trim() === targetText) return item.entryId;
      }
    } catch {
      // 交给上层 toast
    }
    return undefined;
  }, []);

  const forkFromUserMessage = useCallback(async (message: ChatMessage) => {
    const latest = depsRef.current;
    const sessionId = latest.currentSessionId;
    if (!sessionId || latest.isAgentCurrentlyBusy()) return;
    if (forkingMessageId) return;
    setForkingMessageId(message.id);
    try {
      let target = latest.getRuntimeTargetForSession(sessionId);
      if (!target) {
        showOverlay(sessionId, "activating");
        const activated = requireSessionCommand(await api.sessions.activateRuntime(sessionId));
        target = {
          sessionId,
          agentId: activated.agentId,
          runtimeGeneration: activated.runtimeGeneration,
        };
      }
      showOverlay(sessionId, "forking");
      const entryId = await resolveForkEntryId(message, target.agentId);
      if (!entryId) {
        latest.showToast(t("app.forkMissingEntryId"), 4000);
        return;
      }
      const result = requireSessionCommand(
        await api.sessions.forkRuntimeSession(target, entryId),
      );
      if (result.cancelled) {
        latest.showToast(t("app.forkCancelled"), 3500);
        return;
      }
      const promptText =
        typeof result.text === "string" && result.text.length > 0
          ? result.text
          : message.text;
      const projectId = latest.resolveProjectId(sessionId);
      const targetSessionId = result.targetSessionId;
      await latest.openReplacedRuntimeSession(projectId, targetSessionId);
      const draftTarget = targetSessionId ?? sessionId;
      if (targetSessionId) latest.setCurrentSessionIdRef(targetSessionId);
      latest.setPromptForAgent(draftTarget, promptText);
      window.dispatchEvent(
        new CustomEvent("user-message-edit", { detail: { text: promptText } }),
      );
      latest.showToast(t("app.forkDone"), 3500);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      latest.showToast(
        t("app.forkFailed", { error: latest.translateAgentErrorMessage(msg) }),
        5000,
      );
    } finally {
      setForkingMessageId(null);
      hideOverlay(sessionId);
    }
  }, [forkingMessageId, hideOverlay, resolveForkEntryId, showOverlay]);

  return {
    editMessage,
    deleteMessage,
    resendUserMessage,
    forkFromUserMessage,
    forkingMessageId,
  };
}
