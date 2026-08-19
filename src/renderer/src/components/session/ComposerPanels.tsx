import {
  AlertTriangle,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Clock,
  ListOrdered,
  LoaderCircle,
  Pencil,
  Square,
  X,
  XCircle,
} from "lucide-react";
import { useId, useState, type RefObject } from "react";
import type { ImageContent } from "../../../../shared/types";
import type { QueuedPromptSnapshot } from "../../utils/queuedPromptQueue";
import {
  canDiscardQueuedPrompt,
  canRetractQueuedPromptToInput,
  discardControlHint,
  retractControlHint,
} from "../../utils/queuedPromptQueue";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui-shadcn/dropdown-menu";
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
  onRetract: (sessionId: string, prompt: QueuedPromptSnapshot) => void;
  onDiscard: (sessionId: string, promptId: string) => void;
}) {
  const status = props.prompt.status ?? "pending";
  const previewText = props.prompt.displayText.trim() || t("app.queuedImageMessage");
  const retractHint = retractControlHint(status);
  const discardHint = discardControlHint(status);
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
  const rowTitle = [
    t("app.queuedOrder", { n: props.index + 1 }),
    previewText,
    props.prompt.error,
    status === "unknown" ? t("app.queuedUnknown") : "",
  ]
    .filter(Boolean)
    .join("\n");

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
      ) : null}
      <div className="inline-flex shrink-0 items-center gap-0.5">
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
 * 操作仍是 PiDeck 的撤回进输入框 / 丢弃，不引入 dsh 的行内编辑与 steer。
 */
export function QueuedPromptPanel(props: {
  trackRef: RefObject<HTMLDivElement | null>;
  sessionId?: string;
  prompts: QueuedPromptSnapshot[];
  /** @deprecated 独立卡展示全部排队项并由 180px 列表滚动；保留以免调用点同步炸掉。 */
  visiblePrompts: QueuedPromptSnapshot[];
  onRetract: (sessionId: string, prompt: QueuedPromptSnapshot) => void;
  onDiscard: (sessionId: string, promptId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const listId = useId();
  if (!props.sessionId || !props.prompts.length) return null;

  const multiple = props.prompts.length > 1;
  const listVisible = !multiple || !collapsed;

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
            ? "mb-1 flex max-h-[180px] flex-col overflow-y-auto"
            : "flex flex-col"}
        >
          {props.prompts.map((prompt, index) => (
            <QueuedPromptRow
              key={prompt.id}
              prompt={prompt}
              index={index}
              showQueueGlyph={!multiple}
              sessionId={props.sessionId!}
              onRetract={props.onRetract}
              onDiscard={props.onDiscard}
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
  /** 显式插入当前回合；DSH 忙碌默认发送是下一轮，不能复用 onSend。 */
  onSendSteer: () => void;
  onSendFollowUp: () => void;
  /** 并行发送：独立匿名会话后台处理（不打断当前输出），始终可选 */
  onSendAsk: () => void;
  onStop: () => void;
}) {
  return (
    <div className="composer-send-controls flex items-center">
      <div className="send-behavior-menu-wrap relative flex items-center gap-1.5">
        {/* 发送按钮 + 行为下拉常显（无需输入内容）：默认点击发送到当前会话，
            chevron 展开菜单选择发送行为 */}
        <div className="send-behavior-toggle inline-flex h-8 overflow-hidden rounded-full bg-primary text-primary-foreground">
          <Button
            variant="default"
            size="icon-sm"
            className="send-behavior-primary size-8 rounded-none shadow-none hover:bg-primary/90"
            aria-label={t("app.send")} title={t("app.send")}
            disabled={props.isAgentStarting || props.isGeneratingImage || !props.canSend}
            onClick={props.onSend}
          >
            {props.isGeneratingImage ? (
              <LoaderCircle size={15} strokeWidth={2.4} className="animate-spin" aria-hidden="true" />
            ) : (
              <ArrowUp size={15} strokeWidth={2.4} aria-hidden="true" />
            )}
          </Button>
          {/* 非受控 DropdownMenu：开关状态由 Radix 内部管理，点击外部/选择菜单项后
              立即关闭，避免受控 + 延迟关闭导致菜单卡住无法收起 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="default"
                size="icon"
                className="send-behavior-chevron h-8 w-5 rounded-none border-l border-primary-foreground/20 p-0 shadow-none hover:bg-primary/90"
                aria-label={t("app.sendBehaviorTitle")} title={t("app.sendBehaviorTitle")}
              >
                <ChevronDown size={12} strokeWidth={2.2} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="end"
              sideOffset={8}
              className="send-behavior-menu w-44"
            >
              {/* 当前回合/下一轮仅在会话进行中显示（隐藏而非置灰）；并行发送始终可用 */}
              {props.isAgentBusy && (
                <DropdownMenuItem
                  className="send-behavior-option steer gap-2"
                  onClick={props.onSendSteer}
                >
                  <span className="send-behavior-option-dot size-1.5 rounded-full bg-foreground" aria-hidden="true" />
                  <span>{t("app.sendSteerTitle")}</span>
                </DropdownMenuItem>
              )}
              {props.isAgentBusy && (
                <DropdownMenuItem
                  className="send-behavior-option follow-up gap-2"
                  onClick={props.onSendFollowUp}
                >
                  <span className="send-behavior-option-dot size-1.5 rounded-full bg-muted-foreground" aria-hidden="true" />
                  <span>{t("app.sendFollowUpTitle")}</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                className="send-behavior-option ask gap-2"
                title={t("app.sendAskDesc")}
                onClick={props.onSendAsk}
              >
                <span className="send-behavior-option-dot size-1.5 rounded-full bg-primary" aria-hidden="true" />
                <span>{t("app.sendAskTitle")}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {props.isAgentBusy ? (
          <Button
            variant="destructive"
            size="icon-sm"
            className="composer-bar-btn stop size-8 rounded-full"
            aria-label={t("app.stop")} title={t("app.stop")}
            onClick={props.onStop}
          >
            <Square size={15} strokeWidth={0} fill="currentColor" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
