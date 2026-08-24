import { useSetAtom, useStore } from "jotai";
import { useRef } from "react";
import type {
  ComposerAgentMode,
  ImageContent,
  SendSessionPromptInput,
  SendSessionPromptResult,
  SessionRuntimeTarget,
} from "../../../shared/types";
import {
  bindSessionRuntimeAtom,
  bumpNewTurnCollapseTickAtom,
  cacheSessionMessagesAtom,
  sessionAttachmentsByIdAtom,
  sessionMessagesCacheAtom,
  sessionComposerModeByIdAtom,
  sessionDraftByIdAtom,
  sessionQuotesByIdAtom,
  sessionRecordsAtom,
  sessionRuntimeByIdAtom,
  setSessionAttachmentsAtom,
  setSessionDraftAtom,
  setSessionQuotesAtom,
  setSessionSendStateAtom,
  upsertSessionAtom,
} from "../atoms";
import {
  applyDshGoalSendTransform,
  buildComposerPromptSubmission,
  deriveComposerAgentMode,
  expandPromptTemplates,
} from "../composerBehavior";
import {
  expandQuoteTokens,
  stripQuoteTokens,
} from "../components/session/composer/quoteChip";
import { t, translateI18nDescriptor } from "../i18n";

export type EnqueuePromptSnapshot = {
  displayText: string;
  message: string;
  images?: ImageContent[];
  agentMode: string;
  /** 排队投递策略，决定在 agent busy/idle 哪个阶段排空。 */
  behavior?: "steer" | "followUp";
};

type PromptTemplate = {
  name: string;
  path: string;
  description: string;
  content: string;
  argumentHint?: string;
};

type SessionPromptApi = (
  input: SendSessionPromptInput,
) => Promise<SendSessionPromptResult>;

export type UseSessionSendOptions = {
  /** Stable public identity for every draft, request, queue entry, and runtime binding. */
  sessionId: string;
  sendPrompt: SessionPromptApi;
  /** Promotes a renderer-only pre-send surface to a persistent Session. */
  ensureSessionId?: (sessionId: string) => Promise<string>;
  templates: PromptTemplate[];
  prepareMessage?: (message: string) => Promise<string>;
  onDraftMutation?: (sessionId: string) => void;
  compact: (target: SessionRuntimeTarget, prompt?: string) => Promise<void>;
  resetComposerUi?: () => void;
  recordPromptHistory?: (sessionId: string, message: string) => void;
  refreshProject?: (projectId: string) => void;
  showError?: (message: string, duration?: number) => void;
  showUnknown?: () => void;
  /** Called when streamingBehavior is "steer" before sending. Returns true if enqueued. */
  enqueue?: (sessionId: string, snapshot: EnqueuePromptSnapshot) => boolean;
};

export function normalizeComposerDomText(value: string): string {
  return value.replace(/\u200B/g, "");
}

export function mergeRejectedComposerDraft(
  rejectedDraft: string,
  currentDraft: string,
): string {
  return [rejectedDraft, currentDraft]
    .filter((text) => text.trim())
    .join("\n\n");
}

export function mergeRejectedComposerImages(
  rejectedImages: ImageContent[] | undefined,
  currentImages: ImageContent[],
): ImageContent[] {
  return rejectedImages?.length
    ? [...rejectedImages, ...currentImages]
    : currentImages;
}

export function hasComposerSubmission(
  message: string,
  images: ImageContent[] | undefined,
): boolean {
  return Boolean(message.trim() || images?.length);
}

export function classifySessionPromptResult(
  result: SendSessionPromptResult,
): "accepted" | "rejected" | "unknown" {
  if (result.accepted) return "accepted";
  return result.delivery === "unknown" ? "unknown" : "rejected";
}

export function createSessionSendLock() {
  const sessionIds = new Set<string>();
  return {
    has: (sessionId: string) => sessionIds.has(sessionId),
    claim: (sessionId: string) => {
      if (sessionIds.has(sessionId)) return false;
      sessionIds.add(sessionId);
      return true;
    },
    release: (sessionId: string) => {
      sessionIds.delete(sessionId);
    },
  };
}

export function useSessionSend(options: UseSessionSendOptions) {
  const store = useStore();
  const setDraft = useSetAtom(setSessionDraftAtom);
  const setAttachments = useSetAtom(setSessionAttachmentsAtom);
  const setQuotes = useSetAtom(setSessionQuotesAtom);
  const setCacheMessages = useSetAtom(cacheSessionMessagesAtom);
  const setSendState = useSetAtom(setSessionSendStateAtom);
  const bindRuntime = useSetAtom(bindSessionRuntimeAtom);
  const upsertSession = useSetAtom(upsertSessionAtom);
  const sendingSessionIdsRef = useRef<Set<string>>(new Set());

  function clearSnapshot(targetSessionId: string) {
    options.onDraftMutation?.(targetSessionId);
    setDraft({ sessionId: targetSessionId, value: "" });
    setAttachments({ sessionId: targetSessionId, value: [] });
    // 草稿已清空，快照随之清理：避免会话内孤儿引用无限堆积
    setQuotes({ sessionId: targetSessionId, value: {} });
  }

  function restoreRejectedSnapshot(
    targetSessionId: string,
    message: string,
    imageSnapshot?: ImageContent[],
  ) {
    options.onDraftMutation?.(targetSessionId);
    setDraft({
      sessionId: targetSessionId,
      value: (current) => [message, current]
        .filter((text) => text.trim())
        .join("\n\n"),
    });
    if (imageSnapshot) {
      setAttachments({
        sessionId: targetSessionId,
        value: (current) => [...imageSnapshot, ...current],
      });
    }
  }

  /** 模板正文为空时统一的拦截提示：error 状态 + toast（带模板名，便于定位编辑）。 */
  function rejectEmptyTemplate(templateName: string) {
    const message = t("app.promptTemplateEmptyBody", { name: templateName });
    setSendState({
      sessionId: options.sessionId,
      state: { status: "error", error: message },
    });
    options.showError?.(message, 4500);
  }

  return async function sendSessionPrompt(
    streamingBehavior?: "steer" | "followUp",
  ) {
    const sourceSessionId = options.sessionId;
    if (sendingSessionIdsRef.current.has(sourceSessionId)) return;

    const rawDraft = store.get(sessionDraftByIdAtom)[sourceSessionId] ?? "";
    const attachmentSnapshot = store.get(sessionAttachmentsByIdAtom)[sourceSessionId] ?? [];
    const imageSnapshot = attachmentSnapshot.length
      ? [...attachmentSnapshot]
      : undefined;
    if (!hasComposerSubmission(rawDraft, imageSnapshot)) return;
    // 引用展开唯一咽喉点（审计定稿）：后续乐观缓存/队列快照/历史记录全部消费展开后的文本，
    // #q token 永不出现在时间线气泡或发给 pi 的内容里。
    // 注意：引用展开后仍是普通 markdown 文本，因此与斜杠命令混写时按普通消息处理（有意为之）。
    const quoteMap = store.get(sessionQuotesByIdAtom)[sourceSessionId];
    const message = expandQuoteTokens(rawDraft, (id) => quoteMap?.[id]) ?? rawDraft;
    // 只有引用没有任何正文/图片：引用是上下文不是消息，拦下并提示先写问题
    if (!stripQuoteTokens(rawDraft).trim() && !imageSnapshot) {
      options.showError?.(t("app.quoteNeedsQuestion"), 4000);
      return;
    }

    const resolveSendMode = (targetSessionId: string): ComposerAgentMode => {
      const record = store.get(sessionRecordsAtom)[targetSessionId];
      const liveRuntime = store.get(sessionRuntimeByIdAtom)[targetSessionId];
      return deriveComposerAgentMode({
        backend: record?.backend === "dsh" || liveRuntime?.backend === "dsh" ? "dsh" : "pi",
        localMode: store.get(sessionComposerModeByIdAtom)[targetSessionId],
        planModeActive: liveRuntime?.state?.planModeActive === true,
        goalPhase: liveRuntime?.state?.goal?.phase,
      });
    };

    sendingSessionIdsRef.current.add(sourceSessionId);
    const requestId = crypto.randomUUID();
    const trimmedMessage = message.trim();
    const isCompactCommand = /^\/compact(?:\s|$)/.test(trimmedMessage);
    const usesLocalQueue = Boolean(
      options.enqueue &&
      (streamingBehavior === "steer" || streamingBehavior === "followUp"),
    );

    // 首次发送的运行时启动可能包含 spawn/get_state/会话绑定；先发布用户可见状态，
    // 让输入反馈与后台准备解耦，避免用户把冷启动时间误判成点击无效。
    // 队列和 /compact 保留原路径，因为它们分别需要排队快照或运行时命令语义。
    const publishOptimisticSubmission = (targetSessionId: string) => {
      setSendState({
        sessionId: targetSessionId,
        state: { status: "activating", requestId },
      });
      clearSnapshot(targetSessionId);
      const cacheEntry = store.get(sessionMessagesCacheAtom)?.[targetSessionId];
      const previousMessages = cacheEntry?.messages ?? [];
      setCacheMessages({
        sessionId: targetSessionId,
        messages: [...previousMessages, {
          id: requestId,
          agentId: "",
          role: "user" as const,
          text: message,
          timestamp: Date.now(),
          images: imageSnapshot,
        }],
        source: "runtime" as const,
      });
      options.resetComposerUi?.();
    };

    const publishBeforeActivation = !usesLocalQueue && !isCompactCommand;
    if (publishBeforeActivation) publishOptimisticSubmission(sourceSessionId);

    let sessionId = sourceSessionId;
    try {
      sessionId = options.ensureSessionId
        ? await options.ensureSessionId(sourceSessionId)
        : sourceSessionId;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setSendState({
        sessionId: sourceSessionId,
        state: { status: "error", error: errorMessage },
      });
      options.showError?.(errorMessage, 4000);
      sendingSessionIdsRef.current.delete(sourceSessionId);
      return;
    }

    const runtime = store.get(sessionRuntimeByIdAtom)[sessionId];
    const runtimeTarget = runtime?.agentId
      ? {
          sessionId,
          agentId: runtime.agentId,
          runtimeGeneration: runtime.runtimeGeneration,
        }
      : undefined;
    const runtimeAgentId = runtimeTarget?.agentId;
    if (publishBeforeActivation && runtimeAgentId) {
      setSendState({
        sessionId,
        state: { status: "sending", requestId },
      });
      setCacheMessages({
        sessionId,
        messages: (store.get(sessionMessagesCacheAtom)?.[sessionId]?.messages ?? []).map((item) =>
          item.id === requestId ? { ...item, agentId: runtimeAgentId } : item,
        ),
        source: "runtime",
      });
    }
    if (isCompactCommand) {
      if (!runtimeAgentId) {
        // No Agent yet — let normal send path start Agent first;
        // pi will handle /compact command once active.
      } else {
        const compactPrompt = trimmedMessage.replace(/^\/compact\s*/, "").trim();
        clearSnapshot(sessionId);
        options.resetComposerUi?.();
        await options.compact(runtimeTarget, compactPrompt || undefined);
        return;
      }
    }

    // Queue shortcut: when the agent is busy, enqueue locally instead of sending through
    // the session API. The queue panel shows the pending item and drain dispatches it
    // through the appropriate flush path based on behavior:
    //   steer    → flushQueuedSteerPrompts (while agent is busy)
    //   followUp → flushNextQueuedPrompt (when agent becomes idle)
    if (options.enqueue && (streamingBehavior === "steer" || streamingBehavior === "followUp")) {
      const { message: expandedMessage, emptyTemplateName } = expandPromptTemplates(
        message,
        options.templates,
      );
      if (!expandedMessage.trim() && emptyTemplateName) {
        // 模板正文为空：拦截排队，提示用户先补正文（否则入队的是空白消息）
        sendingSessionIdsRef.current.delete(sourceSessionId);
        rejectEmptyTemplate(emptyTemplateName);
        return;
      }
      const enqueued = options.enqueue(sessionId, {
        displayText: message,
        message: expandedMessage,
        images: imageSnapshot,
        agentMode: resolveSendMode(sessionId),
        behavior: streamingBehavior,
      });
      if (enqueued) {
        clearSnapshot(sessionId);
        options.resetComposerUi?.();
        sendingSessionIdsRef.current.delete(sourceSessionId);
        return;
      }
      // Queue full: fall through to direct send.
    }

    if (!publishBeforeActivation) {
      setSendState({
        sessionId,
        state: {
          status: runtimeAgentId ? "sending" : "activating",
          requestId,
        },
      });
      clearSnapshot(sessionId);

      // Special paths publish only after their runtime/session target is known.
      const cacheEntry = store.get(sessionMessagesCacheAtom)?.[sessionId];
      const previousMessages = cacheEntry?.messages ?? [];
      setCacheMessages({
        sessionId,
        messages: [...previousMessages, {
          id: requestId,
          agentId: runtimeAgentId ?? "",
          role: "user" as const,
          text: message,
          timestamp: Date.now(),
          images: imageSnapshot,
        }],
        source: "runtime" as const,
      });
      options.resetComposerUi?.();
    }

    let preparedMessage = message;
    try {
      preparedMessage = options.prepareMessage
        ? await options.prepareMessage(message)
        : message;
    } catch (error) {
      // 拒绝时回填原始草稿（含 token），保留 chip 形态供用户修改重发
      restoreRejectedSnapshot(sessionId, rawDraft, imageSnapshot);
      const errorMessage = error instanceof Error ? error.message : String(error);
      setSendState({
        sessionId: sourceSessionId,
        state: { status: "error", requestId, error: errorMessage },
      });
      options.showError?.(errorMessage, 4000);
      sendingSessionIdsRef.current.delete(sourceSessionId);
      return;
    }

    const { message: expandedMessage, description, emptyTemplateName } =
      expandPromptTemplates(
        preparedMessage,
        options.templates,
      );
    if (!expandedMessage.trim() && emptyTemplateName) {
      // 模板正文为空（UI 新建模板只写 frontmatter 未填正文）：拦截发送，
      // 给明确提示而不是把空白消息发到主进程被拒为“消息不能为空”。
      // 回填原始草稿（含引用 token），保留 chip 形态
      restoreRejectedSnapshot(sessionId, rawDraft, imageSnapshot);
      rejectEmptyTemplate(emptyTemplateName);
      sendingSessionIdsRef.current.delete(sourceSessionId);
      return;
    }
    const record = store.get(sessionRecordsAtom)[sessionId];
    const liveRuntime = store.get(sessionRuntimeByIdAtom)[sessionId];
    const isDshSend = record?.backend === "dsh" || liveRuntime?.backend === "dsh";
    const sendMode: ComposerAgentMode = deriveComposerAgentMode({
      backend: isDshSend ? "dsh" : "pi",
      localMode: store.get(sessionComposerModeByIdAtom)[sessionId],
      planModeActive: liveRuntime?.state?.planModeActive === true,
      goalPhase: liveRuntime?.state?.goal?.phase,
    });
    // DSH 拒绝 agentMessage：首次目标改写成 /goal；已有目标则原文推进。
    const visibleMessage = isDshSend
      ? applyDshGoalSendTransform({
          message: expandedMessage,
          mode: sendMode,
          goal: liveRuntime?.state?.goal,
        })
      : expandedMessage;
    const submission = buildComposerPromptSubmission(
      visibleMessage,
      isDshSend ? "normal" : sendMode,
    );

    try {
      const result = await options.sendPrompt({
        sessionId,
        requestId,
        message: submission.message,
        ...(imageSnapshot ? { images: imageSnapshot } : {}),
        ...(submission.agentMessage ? { agentMessage: submission.agentMessage } : {}),
        ...(description ? { description } : {}),
        ...(streamingBehavior ? { streamingBehavior } : {}),
      });
      // 新一轮开始：bump 本会话 tick，timeline 侧非最新轮据此收起（设置②）。
      // sendPrompt resolve = pi 已接受消息，旧轮即将/已经结束，此时收掉最省资源。
      store.set(bumpNewTurnCollapseTickAtom, sessionId);
      if (result.agentId) {
        bindRuntime({
          sessionId,
          agentId: result.agentId,
          runtimeGeneration: result.runtimeGeneration,
          status: result.accepted ? "running" : undefined,
        });
      }

      const record = store.get(sessionRecordsAtom)[sessionId];
      if (record && result.accepted) {
        // DSH 的 sessionPath 是 host zstd，不能当 pi JSONL 写进 filePath。
        upsertSession({
          ...record,
          ...(record.backend === "dsh" || !result.sessionPath
            ? {}
            : { filePath: result.sessionPath }),
          status: "active",
          updatedAt: Date.now(),
        });
      }

      const outcome = classifySessionPromptResult(result);
      // toast 文案 = 本地化提示 + 具体原因：translateI18nDescriptor 命中通用 key 时
      // 只返回“消息发送失败。”这类概括，debugDetails（RPC 超时/pi 拒绝原文）必须带出，
      // 否则用户无从知道失败根因；同值去重、截断防 toast 过长。
      let deliveryError = "Prompt was not accepted";
      let toastMessage = deliveryError;
      if ("error" in result) {
        deliveryError = translateI18nDescriptor(result, result.error);
        const details = result.debugDetails && result.debugDetails !== deliveryError
          ? `（${result.debugDetails.length > 140 ? `${result.debugDetails.slice(0, 140)}…` : result.debugDetails}）`
          : "";
        toastMessage = `${deliveryError}${details}`;
      }
      if (outcome === "accepted") {
        options.recordPromptHistory?.(sessionId, message);
        setSendState({ sessionId, state: { status: "idle" } });
        if (record) options.refreshProject?.(record.projectId);
      } else if (outcome === "unknown") {
        setSendState({
          sessionId,
          state: {
            status: "unknown",
            requestId,
            error: deliveryError,
            unknownSnapshot: {
              message,
              ...(imageSnapshot ? { images: imageSnapshot } : {}),
            },
          },
        });
        options.showUnknown?.();
      } else {
        // 拒绝时回填原始草稿（含 token）保留 chip 形态；unknown 快照仍存展开后文本（已实际投递的内容）
        restoreRejectedSnapshot(sessionId, rawDraft, imageSnapshot);
        setSendState({
          sessionId,
          state: { status: "error", requestId, error: deliveryError },
        });
        options.showError?.(toastMessage, 4000);
      }
    } catch (error) {
      setSendState({
        sessionId,
        state: {
          status: "unknown",
          requestId,
          error: error instanceof Error ? error.message : String(error),
          unknownSnapshot: {
            message,
            ...(imageSnapshot ? { images: imageSnapshot } : {}),
          },
        },
      });
      options.showUnknown?.();
    } finally {
      sendingSessionIdsRef.current.delete(sourceSessionId);
    }
  };
}
