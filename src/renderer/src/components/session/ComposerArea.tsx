import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useAtom, useAtomValue } from "jotai";
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
import { modelPendingByIdAtom, thinkingLevelPendingByIdAtom } from "../../atoms/composer-atoms";
import { ComposerRuntimeIntegrations } from "./ComposerRuntimeIntegrations";
import { useSessionPaneServices } from "./SessionPaneServices";
import { desktopApi } from "../../desktopApi";
import { COMPOSER_DEFAULT_HEIGHT, COMPOSER_TEXT_MAX_HEIGHT } from "../../rendererUtils";
import { chatContentWidthStyle } from "./chatContentWidth";
import { ComposerStatsLine } from "./ComposerStatsLine";
import type { GitBranchInfo } from "../../../../shared/types";
import type { EnqueuePromptSnapshot } from "../../hooks/useSessionSend";

export type ComposerAreaProps = {
  sessionId: string;
  gitInfo?: GitBranchInfo;
  /** 输入框上方独立卡（todo / goal）；放在 widgets 槽位。
   *  与 queue / 输入卡一并测量，面板 hug 内容总高。 */
  widgets?: ReactNode;
  /** 排队消息独立卡（与 todo/goal 同列同宽，不贴输入框、不右浮）。 */
  queuePanel?: ReactNode;
  onOpenFile?: (path: string) => void;
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
 * widget 的关闭/更新只会重渲染这棵子树，不会重渲染外层 ComposerArea。
 * 测量 effect 放在这里，才能在 widget / 正文变化的同一帧 hug 面板，而不是等下一次输入。
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
  onHeightChangeRef.current = props.onHeightChange;

  const measureContentHeight = () => {
    const widgetsH = widgetsRef.current?.offsetHeight ?? 0;
    const imageBarH = attachmentBarRef.current?.offsetHeight ?? 0;
    const boxH = composerBoxRef.current?.offsetHeight ?? 0;
    // gap / 底 padding 实测：Tailwind gap-2 是 rem；无指标时 footer pb-0，有指标才由 StatsLine 占位。
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

  // props.widgets / 正文高度变化会重渲染本组件；在 paint 前同步 hug，输入区不会闪高一帧。
  useLayoutEffect(() => {
    if (!mountedRef.current) return;
    reportContentHeight();
  });

  const hasAttachmentBar = props.attachmentBar != null;
  useEffect(() => {
    let rafId = 0;
    const schedule = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        mountedRef.current = true;
        reportContentHeight();
      });
    };
    const observer = new ResizeObserver(schedule);
    if (widgetsRef.current) observer.observe(widgetsRef.current);
    if (attachmentBarRef.current) observer.observe(attachmentBarRef.current);
    if (composerBoxRef.current) observer.observe(composerBoxRef.current);
    // 首测延迟到下一帧：此时 ResizablePanel 已注册到 group。
    schedule();
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [hasAttachmentBar]);

  return (
    <>
      <div
        ref={widgetsRef}
        className="flex shrink-0 min-h-0 min-w-0 flex-col gap-2 empty:hidden"
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
  );
}

export const ComposerArea = forwardRef<HTMLElement, ComposerAreaProps>(function ComposerArea(
  props,
  footerRef,
) {
  const composer = useSessionComposerController({
    sessionId: props.sessionId,
    onOpenFile: props.onOpenFile,
    enqueue: props.enqueue,
    ensureSessionId: props.ensureSessionId,
    // 预览 Tab 里发消息 → 自动晋升常驻（由 App 装配的 SessionPaneServices 提供）
    onPromoteSession: useSessionPaneServices().promoteSessionToPermanent,
  });

  // 流式生成中切换思考强度产生的「待生效」指示（issue #146）：
  // 飞行中的生成仍用旧档位，新档位下一轮才生效；流式一结束就没有“当前生效”参照，直接清除。
  const [thinkingPendingMap, setThinkingPendingMap] = useAtom(thinkingLevelPendingByIdAtom);
  const modelPendingMap = useAtomValue(modelPendingByIdAtom);
  const isStreaming = Boolean(composer.runtime?.state?.isStreaming);
  useEffect(() => {
    if (!isStreaming && thinkingPendingMap[props.sessionId]) {
      setThinkingPendingMap((prev) =>
        prev[props.sessionId] ? { ...prev, [props.sessionId]: undefined } : prev,
      );
    }
  }, [isStreaming, props.sessionId, setThinkingPendingMap, thinkingPendingMap]);

  const prewarmStartedForSessionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!props.sessionId || !window.piDesktop) return;
    if (!composer.draft.trim() && composer.attachments.length === 0) return;
    if (prewarmStartedForSessionRef.current === props.sessionId) return;
    prewarmStartedForSessionRef.current = props.sessionId;

    // 输入是比“打开会话”更可靠的发送意图信号；只在首次输入后预热一次，
    // 避免用户仅浏览历史时创建进程，也避免每个按键重复触发 IPC。
    void desktopApi.sessions.activateRuntime(props.sessionId).catch(() => undefined);
  }, [composer.attachments.length, composer.draft, props.sessionId]);

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
              attachmentBar={composer.attachments.length > 0 ? (
                <ComposerAttachmentBar
                  images={composer.attachments}
                  onPreview={composer.images.preview}
                  onRemove={composer.images.remove}
                  onClear={composer.images.clear}
                />
              ) : null}
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
              {/* 运行中仍可切换思考强度（下一轮生效）和模型（本轮结束后套上）；仅启动中禁用 */}
              <ComposerBottomBar
                state={composer.runtime?.state}
                disabled={composer.isBusy || composer.isStarting}
                thinkingDisabled={composer.isStarting}
                modelDisabled={composer.isStarting}
                thinkingPending={thinkingPendingMap[props.sessionId]}
                modelPending={modelPendingMap[props.sessionId]}
                composerAgentMode={composer.mode}
                gitInfo={props.gitInfo}
                record={composer.record}
                defaultModel={composer.dshDefaultModel}
                defaultThinkingLevel={composer.dshDefaultThinkingLevel}
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
                onCompact={composer.delivery.compact}
                onOpenComposerModePicker={() => composer.pickers.open("mode")}
                onCancelPlan={() => composer.pickers.setMode("normal")}
                onAttachFile={composer.editor.attachFile}
                imageGenOptions={
                  composer.mode === "imagegen"
                    ? {
                        size: composer.delivery.imageGenSize,
                        outputFormat: composer.delivery.imageGenOutputFormat,
                        watermark: composer.delivery.imageGenWatermark,
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
            onPickMode={composer.pickers.setMode}
            currentMode={composer.mode}
            defaultModel={composer.dshDefaultModel}
            defaultThinkingLevel={composer.dshDefaultThinkingLevel}
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
