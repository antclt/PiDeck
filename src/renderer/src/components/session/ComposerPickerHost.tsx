import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useEffect, useRef, useState } from "react";
import type { AvailableModel, ComposerAgentMode, SessionRuntimeTarget } from "../../../../shared/types";
import {
  modelPendingByIdAtom,
  sessionComposerModeByIdAtom,
  sessionRecordByIdAtomFamily,
  sessionRuntimeByIdAtom,
  sessionRuntimeBySessionIdAtomFamily,
  setSessionComposerModeAtom,
  thinkingLevelPendingByIdAtom,
  upsertSessionAtom,
} from "../../atoms";
import type { PromptTemplateInfo } from "../../composerBehavior";
import {
  ComposerModePicker,
  ModelPicker,
  PromptTemplatePicker,
  ThinkingPicker,
} from "./ComposerParts";
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
import type { ComposerPickerKind } from "../../hooks/useSessionComposerController";
import { WELCOME_MODEL_KEY, WELCOME_THINKING_KEY, readWelcomeModelPreference, readWelcomeThinkingPreference } from "../../utils/chatSessionBootstrap";
import { THINKING_LEVELS } from "./sessionPickerOptions";

export type ComposerPickerHostProps = {
  sessionId: string;
  picker: ComposerPickerKind | null;
  templates: PromptTemplateInfo[];
  onClose: () => void;
  onInsertTemplate: (template: PromptTemplateInfo) => void;
  /** 模式选择回调（DSH 后端走 controller 的 DSH 分支：plan 发 /plan 命令）；缺省写本地 atom。 */
  onPickMode?: (mode: ComposerAgentMode) => void;
  /** 当前派生模式（DSH：planModeActive 驱动的 plan）；缺省读本地 atom。 */
  currentMode?: ComposerAgentMode;
};

export function ComposerPickerHost(props: ComposerPickerHostProps) {
  const { sessionId } = props;
  const store = useStore();
  const record = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
  const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
  const setMode = useSetAtom(setSessionComposerModeAtom);
  const upsertSession = useSetAtom(upsertSessionAtom);
  const thinkingPending = useAtomValue(thinkingLevelPendingByIdAtom)[sessionId];
  const setThinkingPendingMap = useSetAtom(thinkingLevelPendingByIdAtom);
  const modelPending = useAtomValue(modelPendingByIdAtom)[sessionId];
  const setModelPendingMap = useSetAtom(modelPendingByIdAtom);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const composerModes = useAtomValue(sessionComposerModeByIdAtom);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
  const [planModeAvailable, setPlanModeAvailable] = useState(true);
  const modelLoadSequenceRef = useRef(0);
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

  useEffect(() => {
    if (props.picker !== "mode") return;
    // 计划模式由内置扩展提供；每次打开模式选择器读取最新状态，避免禁用扩展后仍显示过期选项。
    const extensionsApi = (window as unknown as {
      piDesktop?: { extensions?: { list: () => Promise<{ extensions: Array<{ source: string; enabled?: boolean; builtIn?: boolean }> }> } };
    }).piDesktop?.extensions;
    if (!extensionsApi) return;
    void extensionsApi.list().then((result) => {
      const plan = result.extensions.find((extension) => extension.source === "pi-deck-plan-mode.ts");
      const available = plan?.enabled !== false;
      setPlanModeAvailable(available);
      // 扩展被禁用后清理残留的计划模式状态，避免下拉隐藏但编辑器仍保持计划模式。
      if (!available && composerModes[sessionId] === "plan") setMode({ sessionId, mode: "normal" });
    }).catch(() => {
      setPlanModeAvailable(false);
      if (composerModes[sessionId] === "plan") setMode({ sessionId, mode: "normal" });
    });
  }, [composerModes, props.picker, sessionId, setMode]);

  useEffect(() => {
    // 打开模型选择器即加载（不依赖 record：欢迎页/未启动 Agent 时 record 为 undefined，
    // 但模型列表是全量的，listModels 不依赖 projectId）。
    // 思考选择器也要加载：DSH 按当前模型 reasoningEfforts 过滤档位，模型目录只在
    // 「打开模型选择器」时加载会导致用户先开思考选择器时拿不到过滤数据（显示全量档位）。
    const isDshSession = record?.backend === "dsh" || runtime?.backend === "dsh";
    if (props.picker !== "model" && !(props.picker === "thinking" && isDshSession)) return;
    const sequence = ++modelLoadSequenceRef.current;
    // DSH 会话走 host 级模型目录；pi 走 models.json（与 Agent RPC 同源，无抖动）。
    const loader = isDshSession
      ? desktopApi.sessions.listDshModels()
      : desktopApi.projects.listModels(record?.projectId);
    void loader.then((next) => {
      if (sequence === modelLoadSequenceRef.current) setModels(next);
    }).catch((error) => {
      if (sequence === modelLoadSequenceRef.current) {
        setModels([]);
        showNotice(error instanceof Error ? error.message : String(error), 4000);
      }
    });
  }, [props.picker, record, runtime]);

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
  if (props.picker === "model") {
    // DSH 会话的模型归属 host（agent-default-model），不读 pi 的欢迎页偏好：
    // 否则 localStorage 里的 pi 模型会被当成「当前模型」高亮，误导用户以为已选中。
    const isDshSession = record?.backend === "dsh" || runtime?.backend === "dsh";
    const welcomeModel = isDshSession ? undefined : readWelcomeModelPreference()?.model;
    return (
      <ModelPicker
        models={models}
        current={{
          provider: runtime?.state?.provider ?? record?.model?.provider ?? welcomeModel?.provider,
          modelId: runtime?.state?.modelId ?? record?.model?.modelId ?? welcomeModel?.modelId,
          modelName: runtime?.state?.modelName,
        }}
        onClose={props.onClose}
        onPick={(model) => void pickModel(model)}
        favoriteModels={favoriteModels}
        onToggleFavorite={(provider, modelId) => void toggleFavorite(provider, modelId)}
      />
    );
  }
  if (props.picker === "mode") {
    // DSH 后端 plan 模式由 host 持有（/plan 命令）：plan 项恒可用，选中走
    // controller 的 DSH 分支（发命令而非本地 atom）；currentMode 以派生值为准。
    const isDshSession = record?.backend === "dsh" || runtime?.backend === "dsh";
    return (
      <ComposerModePicker
        currentMode={props.currentMode ?? composerModes[sessionId] ?? "normal"}
        onClose={props.onClose}
        planModeAvailable={isDshSession || planModeAvailable}
        onPick={(nextMode) => {
          if (props.onPickMode) props.onPickMode(nextMode);
          else setMode({ sessionId, mode: nextMode });
          props.onClose();
        }}
      />
    );
  }
  if (props.picker === "thinking") {
    // DSH：只显示当前模型支持的档位。host 的 models catalog 带 reasoningEfforts
    // （llm-deepseek 只接受 off/high/max，llm-pi-ai 按模型声明）——选不支持的档位
    // 不会立即报错，而是在下一次 LLM 请求抛 UNSUPPORTED_REASONING_EFFORT（回合失败）。
    const isDsh = record?.backend === "dsh" || runtime?.backend === "dsh";
    const currentProvider = runtime?.state?.provider ?? record?.model?.provider;
    const currentModelId = runtime?.state?.modelId ?? record?.model?.modelId;
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
        current={runtime?.state?.thinkingLevel ?? record?.thinkingLevel ?? readWelcomeThinkingPreference()?.thinkingLevel}
        levels={thinkingLevels}
        onClose={props.onClose}
        onPick={(level) => void pickThinking(level)}
      />
    );
  }
  return (
    <>
      {null}
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
