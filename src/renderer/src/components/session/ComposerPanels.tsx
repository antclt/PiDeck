import {
  AlertTriangle,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Clock,
  ListOrdered,
  LoaderCircle,
  Pencil,
  Split,
  Square,
  X,
  XCircle,
} from "lucide-react";
import { useId, useState, type RefObject } from "react";
import { useAtomValue } from "jotai";
import type { ImageContent } from "../../../../shared/types";
import type { QueuedPromptSnapshot } from "../../utils/queuedPromptQueue";
import {
  canChangeQueuedPromptBehavior,
  canDiscardQueuedPrompt,
  canRetractQueuedPromptToInput,
  discardControlHint,
  retractControlHint,
} from "../../utils/queuedPromptQueue";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { sessionRecordByIdAtomFamily } from "../../atoms";
import { sessionRuntimeBySessionIdAtomFamily } from "../../atoms/session-selectors";
import { useAskPanel } from "../../hooks/useAskPanel";
import { isSessionRuntimeBusy } from "../../hooks/useSessionTimelineController";
import { ExtensionWidgetCard } from "./ComposerParts";

export function ComposerAttachmentBar(props: {
  images: ImageContent[];
  onPreview: (image: ImageContent) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
}) {
  if (!props.images.length) return null;
  return (
    <div className="image-preview-area w-full">
      {props.images.map((image, index) => (
        <div key={index} className="image-preview-item">
          <img
            src={`data:${image.mimeType};base64,${image.data}`}
            alt={t("app.imageAlt", { index: index + 1 })}
            onClick={() => props.onPreview(image)}
            style={{ cursor: "pointer" }}
          />
          <Button variant="ghost" size="icon"
            className="image-remove-btn"
            aria-label={t("app.imageRemove")} title={t("app.imageRemove")}
            onClick={() => props.onRemove(index)}
          >
            <X size={12} strokeWidth={2.4} aria-hidden="true" />
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        size="sm"
        className="image-clear-btn"
        onClick={props.onClear}
      >
        {t("app.clearImages")}
      </Button>
    </div>
  );
}

export function ExtensionWidgetPanel(props: {
  widgets?: Record<string, string[]>;
  sessionId?: string;
  /** @deprecated A8 compatibility for the pre-leaf App call site. */
  sessionKey?: string;
  dismissedKeys: string[];
  collapsed: boolean;
  onDismiss: (widgetKey: string) => void;
}) {
  const sessionId = props.sessionId ?? props.sessionKey;
  if (!sessionId || !props.widgets || !Object.keys(props.widgets).length) return null;
  return (
    <div className="extension-widgets-container w-full">
      {!props.collapsed &&
        Object.entries(props.widgets)
          .filter(([widgetKey]) => !props.dismissedKeys.includes(widgetKey))
          .map(([widgetKey, lines]) => (
            <ExtensionWidgetCard
              key={widgetKey}
              widgetKey={widgetKey}
              lines={lines}
              sessionIdOrPath={sessionId}
              onClose={() => props.onDismiss(widgetKey)}
            />
          ))}
    </div>
  );
}

function QueueStatusGlyph(props: { status: QueuedPromptSnapshot["status"] }) {
  const status = props.status ?? "pending";
  if (status === "sending") {
    return <LoaderCircle size={14} strokeWidth={2} className="shrink-0 animate-spin text-text-secondary" aria-hidden="true" />;
  }
  if (status === "failed") {
    return <XCircle size={14} strokeWidth={2} className="shrink-0 text-[var(--color-danger)]" aria-hidden="true" />;
  }
  if (status === "unknown") {
    return <AlertTriangle size={14} strokeWidth={2} className="shrink-0 text-[var(--color-warning)]" aria-hidden="true" />;
  }
  return <Clock size={14} strokeWidth={2} className="shrink-0 text-text-tertiary" aria-hidden="true" />;
}

function QueuedPromptRow(props: {
  prompt: QueuedPromptSnapshot;
  index: number;
  showQueueGlyph: boolean;
  sessionId: string;
  agentBusy: boolean;
  onRetract: (sessionId: string, prompt: QueuedPromptSnapshot) => void;
  onDiscard: (sessionId: string, promptId: string) => void;
  onChangeBehavior: (sessionId: string, promptId: string, behavior: "steer" | "followUp") => void;
  onSendAsk: (prompt: QueuedPromptSnapshot) => void;
}) {
  const status = props.prompt.status ?? "pending";
  const previewText = props.prompt.displayText.trim() || t("app.queuedImageMessage");
  const retractHint = retractControlHint(status);
  const discardHint = discardControlHint(status);
  const canChangeBehavior = canChangeQueuedPromptBehavior(status);
  const isSteer = props.prompt.behavior === "steer";
  const isFollowUp = props.prompt.behavior === "followUp" || props.prompt.behavior === "direct";
  // 并行问询只投递纯文本，带图的排队项不能误丢附件。
  const canAsk = canChangeBehavior
    && Boolean((props.prompt.message || props.prompt.displayText).trim())
    && !props.prompt.images?.length;
  const retractTitle = [
    t("app.retractToInput"),
    !retractHint.disabled
      ? ""
      : retractHint.reason === "unknown"
        ? t("app.queuedRetractDisabledUnknown")
        : t("app.queuedRetractDisabledSending"),
  ]
    .filter(Boolean)
    .join("\n");
  const discardTitle = discardHint.disabled
    ? [t("app.retractDiscard"), t("app.queuedDiscardDisabledSending")]
      .filter(Boolean)
      .join("\n")
    : t("app.retractDiscard");
  const steerTitle = canChangeBehavior
    ? (props.agentBusy ? t("app.sendSteerTitle") : t("app.queuedSteerUnavailable"))
    : t("app.queuedBehaviorLocked");
  const followUpTitle = canChangeBehavior
    ? t("app.sendFollowUpTitle")
    : t("app.queuedBehaviorLocked");
  const askTitle = !canChangeBehavior
    ? t("app.queuedBehaviorLocked")
    : props.prompt.images?.length
      ? t("app.queuedAskUnsupported")
      : t("app.sendAskTitle");
  const rowTitle = [
    t("app.queuedOrder", { n: props.index + 1 }),
    isSteer ? t("app.sendSteerTitle") : t("app.sendFollowUpTitle"),
    previewText,
    props.prompt.error,
    status === "unknown" ? t("app.queuedUnknown") : "",
  ]
    .filter(Boolean)
    .join("\n");
  const actionClass = "size-7 rounded-full text-text-tertiary hover:bg-muted/70 hover:text-foreground";

  return (
    <li
      className={`queued-row flex h-9 min-h-9 shrink-0 items-center gap-2.5 border-transparent px-3 transition-[border-color,background-color] duration-100 ${status} queued-behavior-${props.prompt.behavior}`}
      title={rowTitle}
    >
      {props.showQueueGlyph ? (
        <ListOrdered size={14} aria-hidden="true" className="shrink-0 text-text-tertiary" />
      ) : (
        <QueueStatusGlyph status={status} />
      )}
      <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-text-secondary">{previewText}</span>
      {props.prompt.images?.length ? (
        <span className="shrink-0 font-mono text-micro leading-none text-text-tertiary">
          {t("app.queuedImageCount", { count: String(props.prompt.images.length) })}
        </span>
      ) : null}
      {status === "sending" ? (
        <span className="shrink-0 font-mono text-micro leading-none text-text-tertiary">{t("app.queuedSending")}</span>
      ) : status === "failed" ? (
        <span className="shrink-0 font-mono text-micro leading-none text-[var(--color-danger)]">{t("app.queuedFailed")}</span>
      ) : status === "unknown" ? (
        <span className="shrink-0 font-mono text-micro leading-none text-[var(--color-warning)]">
          {t("app.queuedUnknownShort")}
        </span>
      ) : (
        <span className="shrink-0 font-mono text-micro leading-none text-text-tertiary">
          {isSteer ? t("app.queuedBehaviorSteerShort") : t("app.queuedBehaviorFollowUpShort")}
        </span>
      )}
      <div className="inline-flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          className={`${actionClass}${isSteer ? " text-foreground" : ""}`}
          aria-label={t("app.sendSteerTitle")}
          title={steerTitle}
          disabled={!canChangeBehavior || !props.agentBusy}
          onClick={() => props.onChangeBehavior(props.sessionId, props.prompt.id, "steer")}
        >
          <ArrowUp size={14} strokeWidth={2} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className={`${actionClass}${isFollowUp ? " text-foreground" : ""}`}
          aria-label={t("app.sendFollowUpTitle")}
          title={followUpTitle}
          disabled={!canChangeBehavior}
          onClick={() => props.onChangeBehavior(props.sessionId, props.prompt.id, "followUp")}
        >
          <ListOrdered size={14} strokeWidth={2} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className={actionClass}
          aria-label={t("app.sendAskTitle")}
          title={askTitle}
          disabled={!canAsk}
          onClick={() => props.onSendAsk(props.prompt)}
        >
          <Split size={14} strokeWidth={2} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-7 rounded-full text-text-tertiary hover:bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)] hover:text-[color:var(--color-accent)]"
          aria-label={t("app.retractToInput")}
          title={retractTitle}
          disabled={!canRetractQueuedPromptToInput(status)}
          onClick={() => props.onRetract(props.sessionId, props.prompt)}
        >
          <Pencil size={14} strokeWidth={2} aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-7 rounded-full text-text-tertiary hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)]"
          aria-label={t("app.retractDiscard")}
          title={discardTitle}
          disabled={!canDiscardQueuedPrompt(status)}
          onClick={() => props.onDiscard(props.sessionId, props.prompt.id)}
        >
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}

/**
 * composer 上方的排队消息卡（移植自 dsh-web QueueDock 的独立卡形态）。
 * 与 todo / goal 同列同宽：1 条直接一行；多条默认折叠计数头，展开后 180px 内滚动。
 * 行内操作：插入当前回合 / 排队下一轮 / 并行发送，以及撤回进输入框 / 丢弃。
 */
export function QueuedPromptPanel(props: {
  trackRef: RefObject<HTMLDivElement | null>;
  sessionId?: string;
  prompts: QueuedPromptSnapshot[];
  /** @deprecated 独立卡展示全部排队项并由 180px 列表滚动；保留以免调用点同步炸掉。 */
  visiblePrompts: QueuedPromptSnapshot[];
  onRetract: (sessionId: string, prompt: QueuedPromptSnapshot) => void;
  onDiscard: (sessionId: string, promptId: string) => void;
  onChangeBehavior: (sessionId: string, promptId: string, behavior: "steer" | "followUp") => void;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const listId = useId();
  const sessionId = props.sessionId;
  const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId ?? ""));
  const sessionRecord = useAtomValue(sessionRecordByIdAtomFamily(sessionId ?? ""));
  const askPanel = useAskPanel();
  const agentBusy = isSessionRuntimeBusy(runtime?.status, runtime?.state);
  if (!sessionId || !props.prompts.length) return null;

  const multiple = props.prompts.length > 1;
  const listVisible = !multiple || !collapsed;

  const sendAsk = (prompt: QueuedPromptSnapshot) => {
    const projectId = sessionRecord?.projectId;
    const text = prompt.message.trim() || prompt.displayText.trim();
    if (!projectId || !text) return;
    // 并行是立刻开独立会话，不再占着当前会话队列；成功后再从排队区拿掉。
    void askPanel.sendToAsk(projectId, text).then((ok) => {
      if (ok) props.onDiscard(sessionId, prompt.id);
    });
  };

  return (
    <section
      ref={props.trackRef}
      className="queued-track w-full shrink-0 overflow-hidden rounded-xl border border-border bg-card"
      data-testid="session-queue-strip"
      aria-label={t("app.queuedMessagesLabel")}
    >
      {multiple ? (
        <button
          type="button"
          className="flex h-9 w-full items-center gap-2.5 px-3 text-left"
          aria-controls={listId}
          aria-expanded={listVisible}
          onClick={() => { setCollapsed((value) => !value); }}
        >
          <ListOrdered size={14} aria-hidden="true" className="shrink-0 text-text-tertiary" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-6 text-foreground">
            {t("sessionQueue.count", { n: props.prompts.length })}
          </span>
          <span className="shrink-0 text-text-tertiary" aria-hidden="true">
            {listVisible ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </span>
        </button>
      ) : null}
      {listVisible ? (
        <ul
          id={listId}
          className={multiple
            ? "mb-1 flex max-h-[180px] flex-col overflow-y-auto overscroll-contain [contain:layout_paint]"
            : "flex flex-col"}
        >
          {props.prompts.map((prompt, index) => (
            <QueuedPromptRow
              key={prompt.id}
              prompt={prompt}
              index={index}
              showQueueGlyph={!multiple}
              sessionId={sessionId}
              agentBusy={agentBusy}
              onRetract={props.onRetract}
              onDiscard={props.onDiscard}
              onChangeBehavior={props.onChangeBehavior}
              onSendAsk={sendAsk}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function SessionDeliveryNotice(props: {
  status: "unknown" | "idle" | "activating" | "sending" | "error";
  message?: string;
  images?: ImageContent[];
  error?: string;
  onAcknowledge: () => void;
}) {
  if (props.status !== "unknown") return null;
  const preview = props.message?.trim() || (props.images?.length ? t("app.queuedImageMessage") : "");
  return (
    <div className="session-delivery-notice" role="status">
      <div className="session-delivery-notice-copy">
        <strong>{t("app.queuedUnknownShort")}</strong>
        {preview ? <span title={preview}>{preview}</span> : null}
        <small>{t("app.queuedUnknown")}</small>
        {props.error ? <small>{props.error}</small> : null}
      </div>
      <Button variant="secondary" size="sm" onClick={props.onAcknowledge}>
        {t("common.confirm")}
      </Button>
    </div>
  );
}

export function ComposerSendControls(props: {
  isAgentBusy: boolean;
  isAgentStarting: boolean;
  canSend: boolean;
  /** 生图进行中：发送按钮显示转圈并禁用（与 busy 区分，不显示停止按钮） */
  isGeneratingImage?: boolean;
  onSend: () => void;
  onStop: () => void;
}) {
  // dsh-web 同款：一颗蓝圆钮。空闲发送；忙碌同一颗变停止。插入/排队/并行在排队行上选。
  const primaryStops = props.isAgentBusy && !props.isGeneratingImage;
  const label = primaryStops ? t("app.stop") : t("app.send");
  const disabled = primaryStops
    ? false
    : props.isAgentStarting || props.isGeneratingImage || !props.canSend;
  return (
    <div className="composer-send-controls flex items-center">
      <Button
        variant="default"
        size="icon-sm"
        className="composer-send-primary size-8 rounded-full bg-[var(--color-info)] text-white shadow-none hover:bg-[color:color-mix(in_srgb,var(--color-info)_88%,black)] disabled:opacity-40"
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={primaryStops ? props.onStop : props.onSend}
      >
        {props.isGeneratingImage ? (
          <LoaderCircle size={15} strokeWidth={2.4} className="animate-spin" aria-hidden="true" />
        ) : primaryStops ? (
          <Square size={13} strokeWidth={0} fill="currentColor" aria-hidden="true" />
        ) : (
          <ArrowUp size={15} strokeWidth={2.4} aria-hidden="true" />
        )}
      </Button>
    </div>
  );
}
