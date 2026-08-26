import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useEffect, useRef, useState } from "react";
import type { AvailableModel, SessionRuntimeTarget } from "../../../../shared/types";
import {
  beginPiRuntimeThinkingLevelsAtom,
  clearPiRuntimeThinkingLevelsAtom,
  matchesPiRuntimeThinkingLevelsTarget,
  modelPendingByIdAtom,
  piRuntimeThinkingLevelsBySessionIdAtomFamily,
  resolvePiRuntimeThinkingLevelsAtom,
  sessionRecordByIdAtomFamily,
  sessionRuntimeByIdAtom,
  sessionRuntimeBySessionIdAtomFamily,
  upsertSessionAtom,
} from "../../atoms";
import type { PromptTemplateInfo } from "../../composerBehavior";
import {
  ModelPicker,
  PromptTemplatePicker,
  ThinkingPicker,
} from "./ComposerParts";
import { ComposerSkillPicker } from "./ComposerSkillPicker";
import { desktopApi } from "../../desktopApi";
import { showNotice } from "../../utils/notice";
import { t } from "../../i18n";
import {
  SessionCommandFailure,
  isLiveRuntimeStatus,
  requireSessionCommand,
  toSessionRuntimeTarget,
} from "../../utils/sessionCommands";
import { resolveComposerLiveModel } from "../../utils/modelPendingDisplay";
import { resolveComposerThinkingLevel } from "../../utils/thinkingDisplay";
import { ConfirmDialog } from "../app/AppParts";
import { useSessionPaneServices } from "./SessionPaneServices";
import { usePendingModelApply } from "../../hooks/usePendingModelApply";
import { useBackendModelCatalog } from "../../hooks/useBackendModelCatalog";
import type { ComposerPickerKind } from "../../hooks/useSessionComposerController";
import { WELCOME_MODEL_KEY, WELCOME_THINKING_KEY, readWelcomeModelPreference, readWelcomeThinkingPreference } from "../../utils/chatSessionBootstrap";
import { THINKING_LEVELS, toThinkingPickerLevels } from "./sessionPickerOptions";

export type ComposerPickerHostProps = {
  sessionId: string;
  picker: ComposerPickerKind | null;
  templates: PromptTemplateInfo[];
  onClose: () => void;
  onInsertTemplate: (template: PromptTemplateInfo) => void;
  /** 一键插入模板全文（controller insertTemplateContent）：直接塞正文，不走斜线命令。 */
  onInsertTemplateContent: (template: PromptTemplateInfo) => void;
  /** 技能选择：把技能调用命令插入输入框（由 controller 的 insertSkillInvocation 提供）。
   *  插入的斜杠形态由后端决定：pi 用 /skill:名称，DSH 用 /名称——保证与各自的
   *  技能命令解析一致，避免「从列表选了却调不动」（bare 斜杠在 pi 会被过滤）。 */
  onInsertSkill: (name: string) => void;
  /** 一键插入技能全文（controller insertSkillContent）：正文由选择器先读 SKILL.md。 */
  onInsertSkillContent: (content: string) => void;
  /** DSH 部署默认模型/思考档位（settings.yaml agent-default-model）：草稿期高亮与过滤用。 */
  defaultModel?: { provider?: string; modelId?: string; modelName?: string };
  defaultThinkingLevel?: string;
};

export function ComposerPickerHost(props: ComposerPickerHostProps) {
  const { sessionId } = props;
  const store = useStore();
  const record = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
  const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
  const upsertSession = useSetAtom(upsertSessionAtom);
  const modelPending = useAtomValue(modelPendingByIdAtom)[sessionId];
  const setModelPendingMap = useSetAtom(modelPendingByIdAtom);
  const piRuntimeThinkingEntry = useAtomValue(
    piRuntimeThinkingLevelsBySessionIdAtomFamily(sessionId),
  );
  const beginPiRuntimeThinkingLevels = useSetAtom(beginPiRuntimeThinkingLevelsAtom);
  const clearPiRuntimeThinkingLevels = useSetAtom(clearPiRuntimeThinkingLevelsAtom);
  const resolvePiRuntimeThinkingLevels = useSetAtom(resolvePiRuntimeThinkingLevelsAtom);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
  /** 模型在本地 models.json 存在但运行中 Agent 未加载：待确认重启的目标。 */
  const [restartTarget, setRestartTarget] = useState<{
    handle: SessionRuntimeTarget;
    model: string;
  } | null>(null);
  const [restarting, setRestarting] = useState(false);
  // 与 Tab 栏「重启」共用 App.restartActiveAgent：置 restartingAgentId，
  // SessionView overlay（loader + 文案）才会亮。选择器自己调 restartRuntime
  // 能换进程，但不会驱动那套 UI 状态。
  const { restartActiveAgent } = useSessionPaneServices();
  // 不跟 restartTarget state 同步：ConfirmDialog 点确定会先 onOpenChange(false)
  // 走 onCancel 清掉 state；确认意图放 ref，避免当成取消后丢数据。
  const restartIntentRef = useRef<{
    agentId: string;
    provider: string;
    modelId: string;
  } | null>(null);
  const confirmingRestartRef = useRef(false);

  useEffect(() => {
    void desktopApi.settings.get().then((settings) => {
      setFavoriteModels(settings.favoriteModels ?? []);
    }).catch(() => undefined);
  }, []);

  // C19：模型目录数据源统一 hook——打开模型/思考选择器即加载（不依赖 record：欢迎页/
  // 未启动 Agent 时 record 为 undefined，但模型列表是全量的）。Pi 欢迎页也要加载，才能
  // 使用启动 capability snapshot 的精确 thinkingLevels；DSH 继续按 reasoningEfforts 过滤。
  const isDshSession = record?.backend === "dsh" || runtime?.backend === "dsh";
  const welcomeModel = isDshSession ? undefined : readWelcomeModelPreference()?.model;
  // 非 live 残留 state 不能盖住 catalog：Agent 未启动时改模型，选择器高亮必须跟记录走。
  const runtimeLive = isLiveRuntimeStatus(runtime?.status);
  const resolvedLiveModel = resolveComposerLiveModel({
    state: runtime?.state,
    record: record?.model,
    fallback: {
      provider: props.defaultModel?.provider ?? welcomeModel?.provider,
      modelId: props.defaultModel?.modelId ?? welcomeModel?.modelId,
      modelName: props.defaultModel?.modelName,
    },
    isLive: runtimeLive,
  });
  const runtimeThinkingEntryRef = useRef(piRuntimeThinkingEntry);
  runtimeThinkingEntryRef.current = piRuntimeThinkingEntry;

  useEffect(() => {
    return () => {
      // The host is scoped to one mounted session pane; releasing here keeps the
      // per-session atom map bounded without coupling global session atoms to it.
      clearPiRuntimeThinkingLevels(sessionId);
    };
  }, [sessionId, clearPiRuntimeThinkingLevels]);

  /**
   * Pi 0.81+ resolves thinkingLevelMap inside the running Agent. Query once when
   * a runtime first reports its model and again only after that model/agent/generation
   * changes; menu opening is deliberately not part of this dependency set.
   */
  useEffect(() => {
    const agentId = runtime?.agentId;
    const runtimeGeneration = runtime?.runtimeGeneration;
    // 只向仍 live 的 Agent 查 thinkingLevelMap；已关闭/解绑的残留绑定不能拿 catalog 新模型去打 RPC。
    const provider = resolvedLiveModel.provider;
    const modelId = resolvedLiveModel.modelId;
    if (
      isDshSession ||
      !runtimeLive ||
      !agentId ||
      typeof runtimeGeneration !== "number" ||
      !provider ||
      !modelId
    ) {
      return;
    }
    const target = { agentId, runtimeGeneration, provider, modelId };
    if (matchesPiRuntimeThinkingLevelsTarget(runtimeThinkingEntryRef.current, target)) return;

    beginPiRuntimeThinkingLevels({ sessionId, target });
    void desktopApi.sessions.listRuntimeThinkingLevels({
      sessionId,
      agentId,
      runtimeGeneration,
    }).then((result) => {
      // The atom accepts the result only while this exact runtime/model still owns the slot.
      resolvePiRuntimeThinkingLevels({
        sessionId,
        target,
        levels: result.ok ? result.value.value : undefined,
      });
    }).catch(() => {
      resolvePiRuntimeThinkingLevels({ sessionId, target });
    });
  }, [
    sessionId,
    isDshSession,
    runtimeLive,
    runtime?.agentId,
    runtime?.runtimeGeneration,
    resolvedLiveModel.provider,
    resolvedLiveModel.modelId,
    beginPiRuntimeThinkingLevels,
    resolvePiRuntimeThinkingLevels,
  ]);

  const pickerNeedsModels = props.picker === "model" || props.picker === "thinking";
  // 模型目录 + 加载诊断报告：report 为空列表时给出失败原因引导（版本过低/配置损坏/pi 未安装），
  // reload(true) 为手动刷新（绕过缓存重新 fork pi --list-models），选择器右上角提供刷新按钮。
  const { models, report, refreshing, reload } = useBackendModelCatalog({
    sessionId,
    backend: isDshSession ? "dsh" : "pi",
    projectId: record?.projectId,
    enabled: pickerNeedsModels,
  });

  function currentHandle() {
    const current = store.get(sessionRuntimeByIdAtom)[sessionId];
    return toSessionRuntimeTarget(sessionId, current);
  }

  /**
   * 运行时代理命令失败时，若错误是「运行时不可用/绑定已变化」（例如 Agent 已被关闭、
   * 或历史会话尚未启动 Agent），降级为只更新会话记录。Agent 下次启动时
   * SessionRuntimeCoordinator.applyPreferences 会把记录里的模型应用到新进程。
   */
  function isStaleRuntimeFailure(error: unknown): boolean {
    return error instanceof SessionCommandFailure &&
      (error.code === "SESSION_RUNTIME_UNAVAILABLE" ||
        error.code === "SESSION_RUNTIME_CHANGED");
  }

  async function applyModelToRecord(model: AvailableModel) {
    const updated = await desktopApi.sessions.updateRecord(sessionId, {
      model: { provider: model.provider, modelId: model.id },
    });
    upsertSession(updated);
  }

  function currentLiveModel() {
    // pending「from」只取 live state / catalog，不掺欢迎页兜底，避免把草稿偏好当成已生效模型。
    return resolveComposerLiveModel({
      state: runtime?.state,
      record: record?.model,
      isLive: runtimeLive,
    });
  }

  function markModelPending(model: AvailableModel) {
    const live = currentLiveModel();
    const from = modelPending?.from ?? {
      provider: live.provider,
      modelId: live.modelId,
      modelName: live.modelName,
    };
    if (from.provider === model.provider && from.modelId === model.id) {
      setModelPendingMap((prev) => ({ ...prev, [sessionId]: undefined }));
      return;
    }
    setModelPendingMap((prev) => ({
      ...prev,
      [sessionId]: {
        from,
        to: {
          provider: model.provider,
          modelId: model.id,
          modelName: model.name ?? model.id,
        },
      },
    }));
  }

  function offerModelRestart(handle: SessionRuntimeTarget, model: AvailableModel) {
    props.onClose();
    restartIntentRef.current = {
      agentId: handle.agentId,
      provider: model.provider,
      modelId: model.id,
    };
    setRestartTarget({
      handle,
      model: `${model.provider}/${model.id}`,
    });
  }

  function applyRuntimeModelState(agentState: { provider?: string; modelId?: string; modelName?: string }) {
    const current = store.get(sessionRuntimeByIdAtom)[sessionId];
    if (!current) return;
    store.set(sessionRuntimeByIdAtom, {
      ...store.get(sessionRuntimeByIdAtom),
      [sessionId]: {
        ...current,
        state: current.state ? { ...current.state, ...agentState } : agentState,
      },
    });
  }

  usePendingModelApply({
    sessionId,
    runtime,
    modelPending,
    applyRuntimeModelState,
    clearPending: () => setModelPendingMap((prev) => ({ ...prev, [sessionId]: undefined })),
    offerRestart: offerModelRestart,
  });

  /**
   * 后端明确返回 busy 时才排队模型切换；支持运行中选择的 Pi/DSH 会直接在当前 runtime
   * 入口应用，已发出的请求继续使用原配置，后续 step 使用新配置。
   */
  async function pickModelWhileBusy(handle: SessionRuntimeTarget, model: AvailableModel) {
    try {
      const listed = requireSessionCommand(await desktopApi.sessions.listRuntimeModels(handle));
      const snapshotHasModel = listed.value.some(
        (item) => item.provider === model.provider && item.id === model.id,
      );
      if (!snapshotHasModel) {
        offerModelRestart(handle, model);
        return;
      }
    } catch {
      // 查快照失败（含生成中 busy）不挡选择：先记下，本轮结束后 setRuntimeModel 再判断要不要重启。
    }
    await applyModelToRecord(model);
    markModelPending(model);
    props.onClose();
  }

  async function pickModel(model: AvailableModel) {
    // 欢迎页/未启动 Agent（无 record）：把选择存本地偏好，点「启动 Agent」创建会话时应用。
    if (!record) {
      try {
        localStorage.setItem(WELCOME_MODEL_KEY, JSON.stringify({
          provider: model.provider,
          modelId: model.id,
        }));
      } catch {
        // localStorage 不可用时静默；创建会话回退到 pi 默认模型
      }
      props.onClose();
      return;
    }
    const handle = currentHandle();
    try {
      if (handle) {
        try {
          const result = requireSessionCommand(await desktopApi.sessions.setRuntimeModel(
            handle,
            model.provider,
            model.id,
          ));
          const appliedModel = result.value.provider && result.value.modelId
            ? { provider: result.value.provider, modelId: result.value.modelId }
            : { provider: model.provider, modelId: model.id };
          upsertSession({
            ...record,
            model: appliedModel,
            updatedAt: Date.now(),
          });
          setModelPendingMap((prev) => ({ ...prev, [sessionId]: undefined }));
          // 立即将返回的 AgentRuntimeState 合并到 runtime state atom，
          // 使底部栏的模型名称、provider 即刻刷新，无需等待 emitState 事件
          applyRuntimeModelState(result.value);
        } catch (error) {
          if (error instanceof SessionCommandFailure && error.code === "SESSION_RUNTIME_BUSY") {
            await pickModelWhileBusy(handle, model);
            return;
          }
          // 运行时代理不可用（Agent 已关/绑定已换）时降级写记录，
          // 保证「先选模型、后启动 Agent」的流程始终可用。
          if (!isStaleRuntimeFailure(error)) throw error;
          await applyModelToRecord(model);
        }
      } else {
        await applyModelToRecord(model);
      }
      props.onClose();
    } catch (error) {
      // 模型在本地 models.json 存在但运行中 Agent 快照未加载（pi set_model 校验失败）：
      // 关闭选择器并提示用户重启 Agent 使新模型生效，而非直接报错。
      if (error instanceof SessionCommandFailure && error.needsRestart && handle) {
        offerModelRestart(handle, model);
        return;
      }
      showNotice(error instanceof Error ? error.message : String(error), 4000);
    }
  }

  /**
   * 确认后先把新模型写入会话记录，再走统一重启入口。
   * setRuntimeModel 失败时不写 catalog（避免取消后误套新模型）；
   * 重启后 applyPreferences 读 catalog 才能套上用户刚确认的模型。
   * 必须走 restartActiveAgent，才能点亮 SessionView 的重启动画。
   */
  async function confirmRestart() {
    const intent = restartIntentRef.current;
    if (!intent || restarting) return;
    confirmingRestartRef.current = true;
    setRestarting(true);
    // 先关确认框，避免 AlertDialog 关闭动画盖住 overlay。
    setRestartTarget(null);
    try {
      const updated = await desktopApi.sessions.updateRecord(sessionId, {
        model: { provider: intent.provider, modelId: intent.modelId },
      });
      upsertSession(updated);
      setModelPendingMap((prev) => ({ ...prev, [sessionId]: undefined }));
      await restartActiveAgent(intent.agentId);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), 4000);
    } finally {
      confirmingRestartRef.current = false;
      restartIntentRef.current = null;
      setRestarting(false);
    }
  }

  async function pickThinking(level: string) {
    // 欢迎页/未启动 Agent（无 record）：把选择存本地偏好，点「启动 Agent」创建会话时应用。
    if (!record) {
      try {
        localStorage.setItem(WELCOME_THINKING_KEY, level);
      } catch {
        // localStorage 不可用时静默
      }
      props.onClose();
      return;
    }
    const handle = currentHandle();
    try {
      if (handle) {
        try {
          const result = requireSessionCommand(await desktopApi.sessions.setRuntimeThinking(handle, level));
          const agentState = result.value;
          // runtime state carries the host-confirmed effort (DSH may normalize it);
          // fall back to the requested value only for runtimes without a selected model.
          const appliedThinkingLevel = agentState.thinkingLevel ?? level;
          upsertSession({ ...record, thinkingLevel: appliedThinkingLevel, updatedAt: Date.now() });
          // 立即将返回的 AgentRuntimeState 合并到 runtime state atom，
          // 使底部栏的思考强度即刻刷新
          const current = store.get(sessionRuntimeByIdAtom)[sessionId];
          if (current) {
            store.set(sessionRuntimeByIdAtom, {
              ...store.get(sessionRuntimeByIdAtom),
              [sessionId]: {
                ...current,
                state: current.state
                  ? { ...current.state, ...agentState }
                  : agentState,
              },
            });
          }
        } catch (error) {
          // 与模型选择同一策略：运行时不可用时降级为写记录，启动时生效
          if (!isStaleRuntimeFailure(error)) throw error;
          const updated = await desktopApi.sessions.updateRecord(sessionId, {
            thinkingLevel: level,
          });
          upsertSession(updated);
        }
      } else {
        const updated = await desktopApi.sessions.updateRecord(sessionId, {
          thinkingLevel: level,
        });
        upsertSession(updated);
      }
      props.onClose();
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), 4000);
    }
  }

  async function toggleFavorite(provider: string, modelId: string) {
    const key = `${provider}/${modelId}`;
    const next = favoriteModels.includes(key)
      ? favoriteModels.filter((item) => item !== key)
      : [...favoriteModels, key];
    setFavoriteModels(next);
    try {
      await desktopApi.settings.update({ favoriteModels: next });
    } catch (error) {
      setFavoriteModels(favoriteModels);
      showNotice(error instanceof Error ? error.message : String(error), 4000);
    }
  }

  if (props.picker === "template") {
    return (
      <PromptTemplatePicker
        templates={props.templates}
        onClose={props.onClose}
        onPick={props.onInsertTemplate}
        onInsertContent={props.onInsertTemplateContent}
      />
    );
  }
  if (props.picker === "skill") {
    return (
      <ComposerSkillPicker
        backend={isDshSession ? "dsh" : "pi"}
        projectId={record?.projectId}
        agentId={runtime?.agentId}
        onClose={props.onClose}
        onPick={props.onInsertSkill}
        onInsertContent={props.onInsertSkillContent}
      />
    );
  }
  if (props.picker === "model") {
    // DSH 会话的模型归属 host（agent-default-model），不读 pi 的欢迎页偏好：
    // 否则 localStorage 里的 pi 模型会被当成「当前模型」高亮，误导用户以为已选中。
    // 草稿期用部署默认模型（settings.yaml agent-default-model）作当前值。
    return (
      <ModelPicker
        models={models}
        report={report}
        refreshing={refreshing}
        onRefresh={() => reload(true)}
        current={resolvedLiveModel}
        onClose={props.onClose}
        onPick={(model) => void pickModel(model)}
        favoriteModels={favoriteModels}
        onToggleFavorite={(provider, modelId) => void toggleFavorite(provider, modelId)}
      />
    );
  }
  if (props.picker === "thinking") {
    // DSH：只显示当前模型支持的档位。host 的 models catalog 带 reasoningEfforts
    // （llm-deepseek 只接受 off/high/max，llm-pi-ai 按模型声明）——选不支持的档位
    // 不会立即报错，而是在下一次 LLM 请求抛 UNSUPPORTED_REASONING_EFFORT（回合失败）。
    // 草稿期当前模型 = 部署默认模型（settings.yaml agent-default-model）。
    const currentProvider = resolvedLiveModel.provider;
    const currentModelId = resolvedLiveModel.modelId;
    const currentModel = models.find(
      (model) => model.provider === currentProvider && model.id === currentModelId,
    );
    const thinkingLevels = isDshSession && currentModel?.reasoningEfforts
      ? currentModel.reasoningEfforts.map((effort) => {
          const known = THINKING_LEVELS.find((level) => level.value === effort.id);
          return known
            ? { value: known.value, labelKey: known.labelKey, descriptionKey: known.descriptionKey }
            : { value: effort.id, label: effort.name ?? effort.id, description: effort.description };
        })
      : undefined;
    const runtimeThinkingTarget = !isDshSession && runtimeLive && runtime?.agentId &&
      typeof runtime.runtimeGeneration === "number" && currentProvider && currentModelId
      ? {
          agentId: runtime.agentId,
          runtimeGeneration: runtime.runtimeGeneration,
          provider: currentProvider,
          modelId: currentModelId,
        }
      : undefined;
    const runtimeLevels = runtimeThinkingTarget &&
      matchesPiRuntimeThinkingLevelsTarget(piRuntimeThinkingEntry, runtimeThinkingTarget) &&
      piRuntimeThinkingEntry?.status === "resolved"
      ? piRuntimeThinkingEntry.levels
      : undefined;
    const runtimeFellBack = runtimeThinkingTarget &&
      matchesPiRuntimeThinkingLevelsTarget(piRuntimeThinkingEntry, runtimeThinkingTarget) &&
      piRuntimeThinkingEntry?.status === "fallback";
    // 活跃 runtime 一律先等其自身 RPC 结果，不能拿全局 snapshot 冒充当前 Agent。
    // 欢迎页/草稿没有 runtime 时才用启动 capability cache 的精确模型级结果。
    const piLevels = !isDshSession
      ? runtimeThinkingTarget
        ? runtimeLevels !== undefined ? toThinkingPickerLevels(runtimeLevels) : undefined
        : currentModel?.thinkingLevels !== undefined
          ? toThinkingPickerLevels(currentModel.thinkingLevels)
          : undefined
      : undefined;
    const piLevelsLoading = !isDshSession && (
      runtimeThinkingTarget
        ? !runtimeFellBack && runtimeLevels === undefined
        : report === null
    );
    // DSH 的思考档位属于 host 的模型选择，草稿期优先部署默认档位；settings.yaml
    // 没配 reasoningEffort 时回退到当前模型自己的 defaultEffort（DSH 官方语义），
    // 不回退到 pi 的欢迎页偏好——否则底栏无值、选择器却勾选 pi 的 max。
    const welcomeThinking = isDshSession ? undefined : readWelcomeThinkingPreference()?.thinkingLevel;
    return (
      <ThinkingPicker
        current={resolveComposerThinkingLevel({
          state: runtime?.state?.thinkingLevel,
          record: record?.thinkingLevel,
          fallback: props.defaultThinkingLevel ?? currentModel?.defaultEffort ?? welcomeThinking,
          isLive: runtimeLive,
        })}
        levels={isDshSession ? thinkingLevels : piLevels}
        loading={piLevelsLoading}
        onClose={props.onClose}
        onPick={(level) => void pickThinking(level)}
      />
    );
  }
  return (
    <>
      {restartTarget && (
        <ConfirmDialog
          title={t("app.modelRestartTitle")}
          message={t("app.modelRestartBody", { model: restartTarget.model })}
          confirmLabel={t("common.confirm")}
          onConfirm={() => {
            confirmingRestartRef.current = true;
            void confirmRestart();
          }}
          onCancel={() => {
            // 只关框：点确定也会先走 onOpenChange(false)→onCancel。
            // 不能在这里清 restartIntentRef，否则确认路径读到空、重启不会发生。
            setRestartTarget(null);
          }}
        />
      )}
    </>
  );
}
