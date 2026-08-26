import React from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
	resolvePaneTerminal,
	terminalOwnerKey,
	shouldMountPaneTerminalDock,
} from "../../terminalDockState";
import { settingsOpenAtom } from "../../atoms";
import {
  claimSessionRuntimeUiResponseAtom,
  rollbackSessionRuntimeUiResponseAtom,
} from "../../atoms/session-atoms";
import {
  sessionRecordByIdAtomFamily,
  sessionRuntimeBySessionIdAtomFamily,
  sessionRuntimeUiBySessionIdAtomFamily,
} from "../../atoms/session-selectors";
import { projectByIdAtomFamily } from "../../atoms/project-atoms";
import { useSessionRuntimeController } from "../../hooks/useSessionRuntimeController";
import {
  createSessionRuntimeUiResponder,
  SessionRuntimeUiOverlay,
} from "../overlays/SessionRuntimeUiOverlay";
import type { QueuedPrompt } from "../../hooks/useQueuedPrompt";
import type { SessionTimelineController } from "../../hooks/useSessionTimelineController";
import { QueuedPromptPanel } from "./ComposerPanels";
import { SessionView } from "./SessionView";
import { useSessionPaneServices } from "./SessionPaneServices";

export type SessionRuntimeInjectorProps = {
  currentSessionId: string;
  sessionTitle: string;
  sessionTimeline: SessionTimelineController;
  /** 分屏栏加聚焦边框；单栏 Tab 已外置，同样只渲染本栏 Header */
  splitPane?: boolean;
  focused?: boolean;
  onFocusPane?: () => void;
  chatHeaderRef: React.RefObject<HTMLDivElement | null>;
  composerRef: React.RefObject<HTMLElement | null>;
  composerOffsetHeight: number;
  terminalRowHeight: number;
  activeQueuedPrompts: QueuedPrompt[];
  queuedTrackRef: React.MutableRefObject<HTMLElement | null>;
};

/**
 * 绑定本栏 runtime 订阅与 UI overlay，再交给 SessionView。
 * 共享服务从 SessionPaneServices 读取，避免 App 大 props 袋。
 */
export const SessionRuntimeInjector = React.memo(function SessionRuntimeInjector(
  props: SessionRuntimeInjectorProps,
) {
  const {
    currentSessionId,
    sessionTitle,
    sessionTimeline,
    splitPane = false,
    focused = true,
    onFocusPane,
    chatHeaderRef,
    composerRef,
    composerOffsetHeight,
    terminalRowHeight,
    activeQueuedPrompts,
    queuedTrackRef,
  } = props;

  const services = useSessionPaneServices();
  const settingsOpen = useAtomValue(settingsOpenAtom);
  const sessionRecord = useAtomValue(sessionRecordByIdAtomFamily(currentSessionId));
  const currentSessionRuntime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(currentSessionId));
  const currentSessionRuntimeUi = useAtomValue(sessionRuntimeUiBySessionIdAtomFamily(currentSessionId));
  const claimSessionUiResponse = useSetAtom(claimSessionRuntimeUiResponseAtom);
  const rollbackSessionUiResponse = useSetAtom(rollbackSessionRuntimeUiResponseAtom);
  const runtimeRef = React.useRef(currentSessionRuntime);
  runtimeRef.current = currentSessionRuntime;

  // 本栏终端归属：从本会话自身的 runtime/record 解析（分屏各栏独立，不再跟随 App 聚焦态）；
  // owner 解析失败或目标不可落地时该栏不挂 dock。
  const paneProject = useAtomValue(
    projectByIdAtomFamily(sessionRecord?.projectId ?? ""),
  );
  const paneTerminal = React.useMemo(
    () =>
      resolvePaneTerminal({
        sessionId: currentSessionId,
        runtime: currentSessionRuntime,
        projectId: sessionRecord?.projectId,
        project: paneProject,
      }),
    [currentSessionId, currentSessionRuntime, sessionRecord?.projectId, paneProject],
  );
  const paneOwnerKey = paneTerminal ? terminalOwnerKey(paneTerminal.owner) : undefined;
  const paneTerminalState = paneOwnerKey
    ? services.terminalStatesByOwner[paneOwnerKey]
    : undefined;
  const paneTerminalOpen = Boolean(paneTerminalState?.open) && Boolean(paneTerminal);
  const paneTerminalCollapsed = Boolean(paneTerminalState?.collapsed);
  const paneTerminalDockVisible = shouldMountPaneTerminalDock({
    ownerKey: paneOwnerKey,
    activeOwnerKey: services.activeTerminalOwnerKey,
    focused,
    open: paneTerminalOpen,
  });
  // 本栏 dock 的开关回调绑定本栏自己的 owner key：非聚焦栏也能关自己的终端，
  // 不会写到当前聚焦会话的桶里（分屏双栏状态互不串台）。
  const setPaneTerminalOpen = React.useCallback(
    (open: boolean) => {
      if (paneOwnerKey) services.setTerminalOpenByOwnerKey(paneOwnerKey, open);
    },
    [paneOwnerKey, services.setTerminalOpenByOwnerKey],
  );
  const setPaneTerminalCollapsed = React.useCallback(
    (collapsed: boolean) => {
      if (paneOwnerKey) services.setTerminalCollapsedByOwnerKey(paneOwnerKey, collapsed);
    },
    [paneOwnerKey, services.setTerminalCollapsedByOwnerKey],
  );

  const runtimeUiResponder = React.useMemo(() => {
    if (!currentSessionRuntime?.agentId) return undefined;
    const binding = {
      sessionId: currentSessionId,
      agentId: currentSessionRuntime.agentId,
      runtimeGeneration: currentSessionRuntime.runtimeGeneration,
    };

    return createSessionRuntimeUiResponder({
      binding,
      readBinding: () => {
        const latest = runtimeRef.current;
        return latest?.agentId
          ? {
              sessionId: currentSessionId,
              agentId: latest.agentId,
              runtimeGeneration: latest.runtimeGeneration,
            }
          : undefined;
      },
      claim: claimSessionUiResponse,
      rollback: rollbackSessionUiResponse,
      send: services.api.sessions.sendUiResponse,
      onError: (error) =>
        services.showToast(error instanceof Error ? error.message : String(error), 4000),
    });
  }, [
    claimSessionUiResponse,
    currentSessionId,
    currentSessionRuntime?.agentId,
    currentSessionRuntime?.runtimeGeneration,
    rollbackSessionUiResponse,
    services.api.sessions.sendUiResponse,
    services.showToast,
  ]);

  const runtime = useSessionRuntimeController({
    sessionId: currentSessionId,
    agents: services.agents,
    queueFlushBySessionRef: services.queueFlushBySessionRef,
    activeQueuedPrompts,
    restartingAgentId: services.restartingAgentId,
    sessionDurationByAgent: services.sessionDurationByAgent,
    activeProjectId: services.activeProjectId,
    showNotice: services.showNotice,
  });

  const activeAgent = runtime.activeAgentId
    ? services.agents.find((a) => a.id === runtime.activeAgentId)
    : undefined;
  const canMutateActiveMessages = runtime.canMutateActiveMessages;
  // 未启动时 activeAgent 为空，必须看 catalog backend，不能只看 live tab。
  // DSH 本轮不做编辑/删除/重发（无 JSONL 离线改写）；fork 仍要求 live runtime。
  const isDshBackend = sessionRecord?.backend === "dsh" || activeAgent?.backend === "dsh";
  const canEditOrDeleteMessages = !isDshBackend;
  const canResend = !isDshBackend;
  const canFork = isDshBackend ? canMutateActiveMessages : true;

  return (
    <SessionView
      sessionId={currentSessionId}
      sessionTitle={sessionTitle}
      sessionTimeline={sessionTimeline}
      splitPane={splitPane}
      focused={focused}
      onFocusPane={onFocusPane}
      activeAgentId={runtime.activeAgentId ?? undefined}
      activeAgent={activeAgent}
      hasActiveConversation={runtime.hasActiveConversation}
      hasProject={runtime.sessionHasProject}
      chatHeaderRef={chatHeaderRef}
      composerRef={composerRef}
      composerOffsetHeight={composerOffsetHeight}
      terminalRowHeight={terminalRowHeight}
      isAgentStarting={runtime.isAgentStarting}
      isRestarting={runtime.isRestartingThisAgent}
      sessionDuration={runtime.sessionDuration}
      showThinking={services.showThinking}
      validCommandNames={services.validCommandNames}
      validFilePaths={services.validFilePaths}
      onPreviewImage={services.onPreviewImage}
      onOpenFile={services.onOpenFile}
      onDiffFile={services.onDiffFile}
      onResendUserMessage={canResend ? services.resendUserMessage : undefined}
      onEditMessage={canEditOrDeleteMessages ? services.editMessage : undefined}
      onDeleteMessage={canEditOrDeleteMessages ? services.deleteMessage : undefined}
      onForkMessage={canFork ? services.forkFromUserMessage : undefined}
      forkingMessageId={services.forkingMessageId}
      onToast={(message: string) => services.showToast(message)}
      onQuickPrompt={(message) => services.insertQuickPrompt(currentSessionId, message)}
      canMutateActiveMessages={canMutateActiveMessages}
      onOpenBranchSession={
        services.activeProjectId && services.openSidebarSessionById
          ? (sessionId: string) => {
              void services.openSidebarSessionById?.(services.activeProjectId!, sessionId);
            }
          : undefined
      }
      enqueueSessionPrompt={services.enqueueSessionPrompt}
      gitInfo={services.gitInfo}
      onSwitchBranch={services.onSwitchBranch}
      ensureSessionId={services.ensureSessionId}
      runtimeUi={
        runtimeUiResponder ? (
          <SessionRuntimeUiOverlay
            sessionId={currentSessionId}
            runtime={currentSessionRuntime}
            ui={currentSessionRuntimeUi}
            responder={runtimeUiResponder}
            // 展开工具/思考卡片不应抢夺用户当前滚动位置；只有新消息进入时由时间线控制自动贴底。
            onExpandedChange={() => undefined}
          />
        ) : null
      }
      queuePanel={
        currentSessionId ? (
          <QueuedPromptPanel
            trackRef={queuedTrackRef}
            sessionId={currentSessionId}
            prompts={activeQueuedPrompts}
            visiblePrompts={activeQueuedPrompts}
            onRetract={services.queueRetract}
            onDiscard={services.queueDiscard}
            onChangeBehavior={services.queueChangeBehavior}
          />
        ) : undefined
      }
      terminalDockVisible={paneTerminalDockVisible}
      terminalOpen={paneTerminalOpen}
      // 本栏 dock 卸载不播关闭动画（面板随 open 立即卸载，closing 只在 App 级空态路径有意义）
      terminalDockClosing={false}
      terminalCollapsed={paneTerminalCollapsed}
      availableTerminalHeight={services.availableTerminalHeight ?? 120}
      terminalOwnerKey={paneOwnerKey}
      terminalTarget={paneTerminal?.target}
      setTerminalOpenForOwner={setPaneTerminalOpen}
      setTerminalCollapsedForOwner={setPaneTerminalCollapsed}
      setTerminalHeight={services.setTerminalHeight}
      settingsOpen={settingsOpen}
      configOpen={services.configOpen}
      environmentDialog={services.environmentDialog}
      runCreateSessionDraft={services.runCreateSessionDraft}
      abortAgent={services.abortAgent}
    />
  );
});
