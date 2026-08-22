import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useEffect, useRef, useState } from "react";
import type { AvailableModel, SessionRuntimeTarget } from "../../../../shared/types";
import {
  modelPendingByIdAtom,
  sessionRecordByIdAtomFamily,
  sessionRuntimeByIdAtom,
  sessionRuntimeBySessionIdAtomFamily,
  thinkingLevelPendingByIdAtom,
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
  requireSessionCommand,
  toSessionRuntimeTarget,
} from "../../utils/sessionCommands";
import { ConfirmDialog } from "../app/AppParts";
import { useSessionPaneServices } from "./SessionPaneServices";
import { usePendingModelApply } from "../../hooks/usePendingModelApply";
import { useBackendModelCatalog } from "../../hooks/useBackendModelCatalog";
import type { ComposerPickerKind } from "../../hooks/useSessionComposerController";
import { WELCOME_MODEL_KEY, WELCOME_THINKING_KEY, readWelcomeModelPreference, readWelcomeThinkingPreference } from "../../utils/chatSessionBootstrap";
import { THINKING_LEVELS } from "./sessionPickerOptions";

export type ComposerPickerHostProps = {
  sessionId: string;
  picker: ComposerPickerKind | null;
  templates: PromptTemplateInfo[];
  onClose: () => void;
  onInsertTemplate: (template: PromptTemplateInfo) => void;
  /** 技能选择：插入 /技能名 到输入框（由 controller 的 insertSkillInvocation 提供）。 */
  onInsertSkill: (name: string) => void;
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
  const thinkingPending = useAtomValue(thinkingLevelPendingByIdAtom)[sessionId];
  const setThinkingPendingMap = useSetAtom(thinkingLevelPendingByIdAtom);
  const modelPending = useAtomValue(modelPendingByIdAtom)[sessionId];
  const setModelPendingMap = useSetAtom(modelPendingByIdAtom);
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

  // C19：模型目录数据源统一 hook——打开模型选择器即加载（不依赖 record：欢迎页/未启动
  // Agent 时 record 为 undefined，但模型列表是全量的）。思考选择器也要加载：DSH 按当前
  // 模型 reasoningEfforts 过滤档位，模型目录只在「打开模型选择器」时加载会导致用户先开
  // 思考选择器时拿不到过滤数据（显示全量档位）。
  const isDshSession = record?.backend === "dsh" || runtime?.backend === "dsh";
  const pickerNeedsModels = props.picker === "model" || (props.picker === "thinking" && isDshSession);
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
    return {
      provider: runtime?.state?.provider ?? record?.model?.provider ?? "",
      modelId: runtime?.state?.modelId ?? record?.model?.modelId ?? "",
      modelName: runtime?.state?.modelName,
    };
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
   * 生成进行中：pi 不支持运行中切模型。快照里已有的模型只写会话记录，
   * 本轮结束后由本组件再调 setRuntimeModel；不在快照里的新加模型走重启确认。
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
    const generationInFlight =
      Boolean(handle) &&
      (runtime?.status === "running" || Boolean(runtime?.state?.isStreaming));
    try {
      if (handle && generationInFlight) {
        await pickModelWhileBusy(handle, model);
        return;
      }
      if (handle) {
        try {
          const result = requireSessionCommand(await desktopApi.sessions.setRuntimeModel(
            handle,
            model.provider,
            model.id,
          ));
          upsertSession({
            ...record,
            model: { provider: model.provider, modelId: model.id },
            updatedAt: Date.now(),
          });
          setModelPendingMap((prev) => ({ ...prev, [sessionId]: undefined }));
          // 立即将返回的 AgentRuntimeState 合并到 runtime state atom，
          // 使底部栏的模型名称、provider 即刻刷新，无需等待 emitState 事件
          applyRuntimeModelState(result.value);
        } catch (error) {
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
          upsertSession({ ...record, thinkingLevel: level, updatedAt: Date.now() });
          // 生成进行中：飞行中的生成仍用旧档位，新档位下一轮才生效。
          // 记录待生效指示（issue #146：xhigh->max），由 ComposerArea 在流式结束时清除。
          if (runtime?.state?.isStreaming) {
            const from = thinkingPending?.from ?? runtime.state.thinkingLevel ?? record.thinkingLevel;
            if (from && from !== level) {
              setThinkingPendingMap((prev) => ({ ...prev, [sessionId]: { from, to: level } }));
            }
          }
          // 立即将返回的 AgentRuntimeState 合并到 runtime state atom，
          // 使底部栏的思考强度即刻刷新
          const agentState = result.value;
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
      />
    );
  }
  if (props.picker === "model") {
    // DSH 会话的模型归属 host（agent-default-model），不读 pi 的欢迎页偏好：
    // 否则 localStorage 里的 pi 模型会被当成「当前模型」高亮，误导用户以为已选中。
    // 草稿期用部署默认模型（settings.yaml agent-default-model）作当前值。
    const isDshSession = record?.backend === "dsh" || runtime?.backend === "dsh";
    const welcomeModel = isDshSession ? undefined : readWelcomeModelPreference()?.model;
    return (
      <ModelPicker
        models={models}
        report={report}
        refreshing={refreshing}
        onRefresh={() => reload(true)}
        current={{
          provider: runtime?.state?.provider ?? record?.model?.provider ?? props.defaultModel?.provider ?? welcomeModel?.provider,
          modelId: runtime?.state?.modelId ?? record?.model?.modelId ?? props.defaultModel?.modelId ?? welcomeModel?.modelId,
          modelName: runtime?.state?.modelName,
        }}
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
    const isDsh = record?.backend === "dsh" || runtime?.backend === "dsh";
    const currentProvider = runtime?.state?.provider ?? record?.model?.provider ?? props.defaultModel?.provider;
    const currentModelId = runtime?.state?.modelId ?? record?.model?.modelId ?? props.defaultModel?.modelId;
    const currentModel = models.find(
      (model) => model.provider === currentProvider && model.id === currentModelId,
    );
    const thinkingLevels = isDsh && currentModel?.reasoningEfforts
      ? currentModel.reasoningEfforts.map((effort) => {
          const known = THINKING_LEVELS.find((level) => level.value === effort.id);
          return known
            ? { value: known.value, labelKey: known.labelKey, descriptionKey: known.descriptionKey }
            : { value: effort.id, label: effort.name ?? effort.id, description: effort.description };
        })
      : undefined;
    return (
      <ThinkingPicker
        current={runtime?.state?.thinkingLevel ?? record?.thinkingLevel ?? props.defaultThinkingLevel ?? readWelcomeThinkingPreference()?.thinkingLevel}
        levels={thinkingLevels}
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
