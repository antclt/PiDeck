import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useAtomValue } from "jotai";
import {
  ComposerBottomBar,
  ImagePreviewModal,
  PromptSuggestions,
} from "./ComposerParts";
import {
  TipTapComposer,
} from "./composer";
import { SessionReferenceModal } from "../app/SessionReferenceModal";
import { t } from "../../i18n";
import { useSessionComposerController } from "../../hooks/useSessionComposerController";
import {
  ComposerAttachmentBar,
  ComposerSendControls,
  SessionDeliveryNotice,
} from "./ComposerPanels";
import { ComposerPickerHost } from "./ComposerPickerHost";
import { SecurityControl } from "./SecurityControl";
import { modelPendingByIdAtom } from "../../atoms/composer-atoms";
import { ComposerRuntimeIntegrations } from "./ComposerRuntimeIntegrations";
import { useSessionPaneServices } from "./SessionPaneServices";
import { desktopApi } from "../../desktopApi";
import { COMPOSER_DEFAULT_HEIGHT, COMPOSER_TEXT_MAX_HEIGHT } from "../../rendererUtils";
import { chatContentWidthStyle } from "./chatContentWidth";
import { ComposerStatsLine } from "./ComposerStatsLine";
import {
  ComposerWidgetLayoutProvider,
  type ComposerWidgetCollapsedByKey,
  useComposerWidgetLayoutValue,
} from "./ComposerWidgetLayout";
import type { GitBranchInfo } from "../../../../shared/types";
import type { EnqueuePromptSnapshot } from "../../hooks/useSessionSend";
import { isLiveRuntimeStatus } from "../../utils/sessionCommands";

export type ComposerAreaProps = {
  sessionId: string;
  gitInfo?: GitBranchInfo;
  /** 底栏分支下拉的切换回调（owner 为 App 级 switchBranch，保持 Git 面板同步） */
  onSwitchBranch?: (branch: string) => void;
  /** 输入框上方独立卡（todo / goal）；放在 widgets 槽位。
   *  与 queue / 输入卡一并测量，面板 hug 内容总高。 */
  widgets?: ReactNode;
  /** 排队消息独立卡（与 todo/goal 同列同宽，不贴输入框、不右浮）。 */
  queuePanel?: ReactNode;
  /** 受控高度（px）。传入时由外层面板（react-resizable-panels）持有尺寸，
   *  本地 state 仅作非受控回退（#115 U5 布局换装）。 */
  height?: number;
  /** 非受控模式的起步高度（px），默认 COMPOSER_DEFAULT_HEIGHT；
   *  起始页等需要大输入框的场景传更高值，内容增高时仍自适应。 */
  defaultHeight?: number;
  onHeightChange?: (height: number) => void;
  /** 独立卡栈 + 输入卡 + footer 间距/底 padding 的内容总高度（px）。
   *  外层面板 hug 该值，避免裁切；输入卡本身 shrink-0，不吃面板剩余高度。 */
  onContentHeightChange?: (contentHeight: number) => void;
  enqueue?: (sessionId: string, snapshot: EnqueuePromptSnapshot) => boolean;
  ensureSessionId?: (sessionId: string) => Promise<string>;
  /** 当前会话中用户发起的轮次，用于 pi 统计栏；DSH 自带 sessionStats 时不重复显示。 */
  turnCount?: number;
  /** 引导页虚拟会话没有 SessionRecord，用它兑底确定文件树/模型目录所属项目。 */
  bootstrapProjectId?: string;
};

const CONTENT_GAP_PX = 8;

/** footer 同时带标准 CSS 与自定义封顶变量；交叉类型避免 `as` 强转。 */
function composerFooterStyle(height: number | string): CSSProperties & {
  "--composer-text-max-height": string;
} {
  return {
    ...chatContentWidthStyle,
    height,
    "--composer-text-max-height": `${COMPOSER_TEXT_MAX_HEIGHT}px`,
  };
}

type ComposerMeasuredExtrasProps = {
  widgets: ReactNode;
  queuePanel?: ReactNode;
  deliveryNotice: ReactNode;
  attachmentBar: ReactNode;
  composerBox: ReactNode;
  /** 输入卡正下方 StatsLine；与输入卡同一测量块，面板 hug 卡+指标。 */
  statsLine?: ReactNode;
  onHeightChange: (contentHeight: number) => void;
};

/**
 * 必须作为 ComposerRuntimeIntegrations render-prop 子树中的独立组件存在：
 * 父级 props、受控 disclosure 和输入正文变化都会使本组件重渲染，layout effect
 * 会在绘制前同步 hug 面板。Diff 流式、图片加载和字体换行等无法预先表达的变化仍由
 * ResizeObserver 兜底，避免把观察器作为普通点击交互的第一响应者。
 *
 * 上报的是「独立卡 + 附件栏 + 输入卡」总高度，不是 extras 增量：输入卡 shrink-0，
 * 面板 hug 内容，拉伸 todo / 拖终端都不会把输入框撑高。
 */
function ComposerMeasuredExtras(props: ComposerMeasuredExtrasProps) {
  const widgetsRef = useRef<HTMLDivElement | null>(null);
  const attachmentBarRef = useRef<HTMLDivElement | null>(null);
  const composerBoxRef = useRef<HTMLDivElement | null>(null);
  const lastContentHeightRef = useRef(0);
  const mountedRef = useRef(false);
  const onHeightChangeRef = useRef(props.onHeightChange);
  const [collapsedByWidgetKey, setCollapsedByWidgetKey] = useState<ComposerWidgetCollapsedByKey>({});
  const widgetLayoutValue = useComposerWidgetLayoutValue(
    collapsedByWidgetKey,
    setCollapsedByWidgetKey,
  );
  onHeightChangeRef.current = props.onHeightChange;

  const measureContentHeight = () => {
    const widgetsEl = widgetsRef.current;
    // 面板碰到 timeline/terminal 的硬约束后，widget 栈可独立滚动以确保输入卡
    // 不被裁切。此时 offsetHeight 是可见高度，而 scrollHeight 保留内容的自然需求；
    // 正常状态二者相同，取较大值让 hug 逻辑始终以完整内容预算面板。
    const widgetsH = widgetsEl
      ? Math.max(widgetsEl.offsetHeight, widgetsEl.scrollHeight)
      : 0;
    const imageBarH = attachmentBarRef.current?.offsetHeight ?? 0;
    const boxH = composerBoxRef.current?.offsetHeight ?? 0;
    // 从实际 footer 读取 gap / 底部留白，避免 Tailwind token 或视觉留白变更后
    // 面板高度少算；所有可见内容都必须纳入 hug 高度。
    let gapPx = CONTENT_GAP_PX;
    let paddingBottom = 0;
    const footerEl = widgetsRef.current?.parentElement;
    if (footerEl && typeof window !== "undefined") {
      const style = window.getComputedStyle(footerEl);
      const rowGap = parseFloat(style.rowGap || "");
      if (!Number.isNaN(rowGap) && rowGap > 0) gapPx = rowGap;
      const pb = parseFloat(style.paddingBottom || "");
      if (!Number.isNaN(pb) && pb > 0) paddingBottom = pb;
    }
    // 空独立卡用 empty:hidden 从文档流拿掉，避免 0 高节点仍占 gap。
    const parts = [widgetsH, imageBarH, boxH].filter((h) => h > 0);
    const gaps = Math.max(0, parts.length - 1) * gapPx;
    return Math.ceil(parts.reduce((sum, h) => sum + h, 0) + gaps + paddingBottom);
  };

  const reportContentHeight = () => {
    const contentHeight = measureContentHeight();
    if (contentHeight === lastContentHeightRef.current) return;
    lastContentHeightRef.current = contentHeight;
    onHeightChangeRef.current(contentHeight);
  };

  // 父级 props / 输入正文变化会重渲染本组件，layout effect 在绘制前同步 hug。
  useLayoutEffect(() => {
    if (!mountedRef.current) return;
    reportContentHeight();
  });

  const hasAttachmentBar = props.attachmentBar != null;
  useEffect(() => {
    let initialMeasureFrame = 0;
    const reportObservedContentHeight = () => {
      if (!mountedRef.current) return;
      // ResizeObserver 在布局完成、浏览器绘制前投递。这里不能再套 rAF：
      // 否则子组件先把输入卡挤开，下一帧面板才增高，会产生可见跳动。flushSync
      // 使由 observer 发起的父级 setState / Group.setLayout 在本次绘制前一并提交。
      flushSync(() => {
        reportContentHeight();
      });
    };
    const observer = new ResizeObserver(reportObservedContentHeight);
    if (widgetsRef.current) observer.observe(widgetsRef.current);
    if (attachmentBarRef.current) observer.observe(attachmentBarRef.current);
    if (composerBoxRef.current) observer.observe(composerBoxRef.current);
    // 首次挂载时 Panel 仍可能尚未注册到 group；仅这一轮延迟到下一帧。
    initialMeasureFrame = requestAnimationFrame(() => {
      initialMeasureFrame = 0;
      mountedRef.current = true;
      reportContentHeight();
    });
    return () => {
      // ResizeObserver 可能已排队回调；先撤销 mounted 标记，避免卸载/重绑后的
      // 旧观察器向父级写入过期高度。
      mountedRef.current = false;
      if (initialMeasureFrame) cancelAnimationFrame(initialMeasureFrame);
      observer.disconnect();
    };
  }, [hasAttachmentBar]);

  return (
    <ComposerWidgetLayoutProvider value={widgetLayoutValue}>
      <>
        {/* Keep a physical raster row after the last card. The panel group can
            resolve a fractional pixel short under its timeline budget; without
            this guard the final card's lower border becomes the scrollport edge.
            scrollHeight includes the padding, so the existing hug measurement
            reserves it in normal layouts and preserves it at the scroll end. */}
        <div
          ref={widgetsRef}
          className="flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto overscroll-contain pb-px empty:hidden"
        >
          {props.widgets}
          {props.queuePanel}
          {props.deliveryNotice}
        </div>
        {hasAttachmentBar ? (
          <div ref={attachmentBarRef} className="shrink-0">
            {props.attachmentBar}
          </div>
        ) : null}
        {/* 外层只承担测量；输入卡 + StatsLine 一并 shrink-0，不吃 footer 剩余高度。 */}
        <div ref={composerBoxRef} className="flex w-full min-w-0 shrink-0 flex-col">
          {props.composerBox}
          {props.statsLine}
        </div>
      </>
    </ComposerWidgetLayoutProvider>
  );
}

export const ComposerArea = forwardRef<HTMLElement, ComposerAreaProps>(function ComposerArea(
  props,
  footerRef,
) {
  const composer = useSessionComposerController({
    sessionId: props.sessionId,
    enqueue: props.enqueue,
    ensureSessionId: props.ensureSessionId,
    // 引导页虚拟会话（GUIDE_BOOTSTRAP_SESSION_ID）无 record：用选中项目加载
    // @ 引用文件树；真实会话忽略该字段（record.projectId 优先）。
    bootstrapProjectId: props.bootstrapProjectId,
    // 预览 Tab 里发消息 → 自动晋升常驻（由 App 装配的 SessionPaneServices 提供）
    onPromoteSession: useSessionPaneServices().promoteSessionToPermanent,
    onCreateSession: useSessionPaneServices().runCreateSessionDraft,
  });

  const modelPendingMap = useAtomValue(modelPendingByIdAtom);

  const prewarmStartedForSessionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!props.sessionId || !window.piDesktop) return;
    if (!composer.draft.trim() && composer.attachments.length === 0 && composer.pasteFiles.files.length === 0) return;
    if (prewarmStartedForSessionRef.current === props.sessionId) return;
    prewarmStartedForSessionRef.current = props.sessionId;

    // 输入是比“打开会话”更可靠的发送意图信号；只在首次输入后预热一次，
    // 避免用户仅浏览历史时创建进程，也避免每个按键重复触发 IPC。
    void desktopApi.sessions.activateRuntime(props.sessionId).catch(() => undefined);
  }, [composer.attachments.length, composer.draft, composer.pasteFiles.files.length, props.sessionId]);

  // 受控：SessionView 面板 hug 测得的内容总高。非受控（起始页等）不写死 height，
  // 由独立卡 + 输入卡 intrinsic 撑开，避免再走 extra+DEFAULT 把输入区算进「被 extras 顶高」。
  const [localHeight, setLocalHeight] = useState(props.defaultHeight ?? COMPOSER_DEFAULT_HEIGHT);
  const handleContentHeightChange = (contentHeight: number) => {
    if (props.height != null) {
      props.onContentHeightChange?.(contentHeight);
      return;
    }
    if (contentHeight > 0) {
      // 非受控同样 hug 实测内容：起始页 defaultHeight 只作首帧占位，不预留指标空位。
      setLocalHeight(contentHeight);
    }
  };

  return (
    <ComposerRuntimeIntegrations sessionId={props.sessionId}>
      {({ feishuIndicator }) => (
        <>
          {/* overflow-hidden：面板到 minSize 时禁止整块 footer 再出滚动条；
              文本区自身仍可在 ProseMirror 内滚动，底栏 shrink-0 始终可见。
              默认顶对齐：面板被终端拖高时剩余空白落在输入卡与终端之间，
              输入卡仍贴在时间线/独立卡下方，不被撑开。 */}
          <footer
            ref={footerRef}
            // 历史会话加载时 composer 仍固定在面板底部；保留 8px 底 padding，避免输入卡贴住窗口边缘。
            className="composer flex min-h-0 min-w-0 flex-col gap-2 overflow-hidden bg-transparent px-0 pb-2"
            style={composerFooterStyle(
              props.height != null ? "100%" : localHeight,
            )}
            data-session-id={props.sessionId}
          >
            {/* 独立卡栈 + 输入卡一并测量：面板 hug 总高，输入卡 shrink-0。 */}
            <ComposerMeasuredExtras
              widgets={props.widgets ?? null}
              queuePanel={props.queuePanel}
              deliveryNotice={( 
                <SessionDeliveryNotice
                  status={composer.sendState.status}
                  message={composer.sendState.unknownSnapshot?.message}
                  images={composer.sendState.unknownSnapshot?.images}
                  error={composer.sendState.error}
                  onAcknowledge={composer.delivery.acknowledgeUnknown}
                />
              )}
              attachmentBar={
                composer.attachments.length > 0 || composer.pasteFiles.files.length > 0 ? (
                  <ComposerAttachmentBar
                    images={composer.attachments}
                    onPreview={composer.images.preview}
                    onRemove={composer.images.remove}
                    onClear={composer.images.clear}
                    pasteFiles={composer.pasteFiles.files}
                    onRemovePasteFile={composer.pasteFiles.remove}
                    onClearPasteFiles={composer.pasteFiles.clear}
                  />
                ) : null
              }
              onHeightChange={handleContentHeightChange}
              statsLine={<ComposerStatsLine state={composer.runtime?.state} turnCount={props.turnCount} />}
              composerBox={
            <div
              // overflow-visible：保留命令面板/建议浮层；面板 minSize 已保证底栏不被裁切
              className={["composer-box relative flex w-full min-w-0 shrink-0 flex-col overflow-visible rounded-[20px] border border-border bg-card text-card-foreground shadow-[var(--shadow-composer-lifted)] transition-[border-color,box-shadow,background-color]",
                composer.bangMode === "bang-bang"
                  ? "shell-silent-mode"
                  : composer.bangMode === "bang"
                    ? "shell-mode"
                    : composer.mode === "plan"
                      ? "plan-mode"
                      : composer.mode === "goal"
                        ? "goal-mode"
                        : "",
              ].filter(Boolean).join(" ")}
            >
              {/* 扩展 widget（Todo/Plan）由常驻 todo 条（SessionTodoStrip）展示。 */}
              <TipTapComposer
                ref={composer.editor.ref}
                value={composer.draft}
                className={
                  composer.bangMode === "bang-bang"
                    ? "bang-bang"
                    : composer.bangMode === "bang"
                      ? "bang"
                      : ""
                }
                disabled={composer.isStarting}
                validCommandNames={composer.editor.validCommandNames}
                validFilePaths={composer.editor.validFilePaths}
                validSessionRefs={composer.editor.validSessionRefs}
                validQuotes={composer.editor.validQuotes}
                caretRef={composer.editor.caretRef}
                placeholder={
                  composer.isStarting
                    ? t("app.agentStartingPlaceholder")
                    : composer.bangMode === "bang-bang"
                      ? t("app.composerSilentPlaceholder")
                      : composer.bangMode === "bang"
                        ? t("app.composerShellPlaceholder")
                        : composer.mode === "plan"
                          ? t("app.composerPlanPlaceholder")
                          : composer.mode === "goal"
                            ? t("app.composerGoalPlaceholder")
                            : t("app.composerEnterPlaceholder")
                }
                onFocus={composer.editor.onFocus}
                onChange={composer.editor.onChange}
                onCursorChange={composer.editor.onCursorChange}
                onKeyDown={composer.editor.onKeyDown}
                onPaste={composer.editor.onPaste}
                onPasteClipboard={composer.editor.onPasteClipboard}
                onDrop={composer.editor.onDrop}
                onDragOver={composer.editor.onDragOver}
                onBlur={composer.editor.onBlur}
                onChipClick={composer.editor.onChipClick}
              />
              {composer.suggestions.open && !composer.isStarting ? (
                <PromptSuggestions
                  prompt={composer.draft}
                  items={composer.suggestions.items}
                  selectedIndex={composer.suggestions.selectedIndex}
                  anchorStyle={composer.suggestions.anchorStyle}
                  onSelectedIndexChange={composer.suggestions.setSelectedIndex}
                  onClose={composer.suggestions.close}
                  onPick={composer.suggestions.pick}
                />
              ) : null}
              {/* 运行中允许后端尝试切换思考强度；是否能作用于当前回合由具体 Agent 后端决定。 */}
              <ComposerBottomBar
                state={composer.runtime?.state}
                runtimeLive={isLiveRuntimeStatus(composer.runtime?.status)}
                disabled={composer.isBusy || composer.isStarting}
                thinkingDisabled={composer.isStarting}
                modelDisabled={composer.isStarting}
                modelPending={modelPendingMap[props.sessionId]}
                composerAgentMode={composer.mode}
                gitInfo={props.gitInfo}
                onSwitchBranch={props.onSwitchBranch}
                record={composer.record}
                defaultModel={composer.dshDefaultModel ?? composer.bootstrapDefaultModel}
                defaultThinkingLevel={composer.dshDefaultThinkingLevel ?? composer.bootstrapDefaultThinkingLevel}
                backend={composer.backend}
                onChangeBackend={composer.changeBackend}
                feishuIndicator={feishuIndicator}
                securityControl={
                  /* C20：后端安全控制位统一入口（pi 安全等级 / DSH 权限预设） */
                  <SecurityControl sessionId={props.sessionId} backend={composer.backend} disabled={composer.isStarting} />
                }
                onPickModel={() => composer.pickers.open("model")}
                onPickThinking={() => composer.pickers.open("thinking")}
                onPickPromptTemplate={() => composer.pickers.open("template")}
                onPickSkill={() => composer.pickers.open("skill")}
                onCompact={composer.delivery.compact}
                onChangeMode={composer.pickers.setMode}
                imageGenLocked={composer.delivery.imageGenModeLocked}
                onCancelPlan={() => composer.pickers.setMode("normal")}
                onAttachFile={composer.editor.attachFile}
                imageGenOptions={
                  composer.mode === "imagegen"
                    ? {
                        config: composer.delivery.imageGenConfig,
                        providerId: composer.delivery.imageGenProviderId,
                        modelId: composer.delivery.imageGenModelId,
                        size: composer.delivery.imageGenSize,
                        outputFormat: composer.delivery.imageGenOutputFormat,
                        watermark: composer.delivery.imageGenWatermark,
                        onSelectionChange: composer.delivery.setImageGenSelection,
                        onSizeChange: composer.delivery.setImageGenSize,
                        onOutputFormatChange: composer.delivery.setImageGenOutputFormat,
                        onWatermarkChange: composer.delivery.setImageGenWatermark,
                      }
                    : undefined
                }
                sendControls={
                  <ComposerSendControls
                    isAgentBusy={composer.isBusy}
                    isAgentStarting={composer.isStarting}
                    canSend={composer.delivery.canSend}
                    isGeneratingImage={composer.delivery.generatingImage}
                    onSend={composer.delivery.send}
                    onStop={composer.delivery.abort}
                  />
                }
              />
            </div>
              }
            />
          </footer>
          <ComposerPickerHost
            sessionId={props.sessionId}
            picker={composer.picker}
            templates={composer.templates}
            onClose={composer.pickers.close}
            onInsertTemplate={composer.pickers.insertTemplate}
            onInsertTemplateContent={composer.pickers.insertTemplateContent}
            onInsertSkill={composer.pickers.insertSkillInvocation}
            onInsertSkillContent={composer.pickers.insertSkillContent}
            defaultModel={composer.dshDefaultModel ?? composer.bootstrapDefaultModel}
            defaultThinkingLevel={composer.dshDefaultThinkingLevel ?? composer.bootstrapDefaultThinkingLevel}
          />
          {composer.previewImage ? (
            <ImagePreviewModal
              image={composer.previewImage}
              onClose={composer.modals.closePreview}
            />
          ) : null}
          {composer.sessionReference ? (
            <SessionReferenceModal
              session={composer.sessionReference}
              initialSelected={composer.sessionReferenceSelection
                ? new Set(composer.sessionReferenceSelection.selectedIndices)
                : undefined}
              onClose={composer.modals.closeSessionReference}
              onConfirm={(result, selectedIndices) => {
                composer.modals.confirmSessionReference(
                  result.sessionName,
                  result.messages,
                  selectedIndices,
                );
              }}
              loadMessages={(sessionId) => desktopApi.sessions.readReferenceMessages(sessionId)}
            />
          ) : null}
        </>
      )}
    </ComposerRuntimeIntegrations>
  );
});
