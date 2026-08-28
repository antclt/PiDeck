/**
 * SessionWidgetsPopover — 分段长条的弹层本体。
 *
 * 渲染在 timeline 面板底部悬浮层（absolute bottom-0，SessionSurfaceStage 内），
 * 不参与 composer 面板布局：开合不改变任何面板高度，timeline 视口与滚动完全不受影响。
 *
 * 分段条（SessionWidgetsCard）只负责写 widgetsPopoverSegmentFamily；本组件常驻挂载
 * （displaySegment 为 null 时渲染 null，但 hooks 保持订阅），避免弹层开关时二次发
 * IPC 造成空态 → 加载中 → 列表三态跳变。
 *
 * 注意：本组件位于 ComposerWidgetLayoutProvider 之外，行级折叠不能走 composer
 * collapsed 通道，改用 widgetsDisclosureCollapsedFamily（见 composer-atoms）。
 */

import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  ChevronDown,
  CornerUpRight,
  ExternalLink,
  FileText,
  Loader2,
  Save,
  Square,
  X,
} from "lucide-react";
import type { AgentRunItem } from "./timeline/types";
import type { DiffFileHandler } from "./ToolCallComponents";
import { FileDiff } from "../agents/file-diff";
import { MarkdownStream } from "./MarkdownStream";
import { desktopApi } from "../../desktopApi";
import { fileChangeToDiffLines } from "./TimelineFormat";
import {
  parseAgentTodoItems,
  runtimeTodosToItems,
  sessionTodoSnapshotToItems,
  stripPiDeckTodoWidgetMetadata,
  type AgentTodoItem,
} from "./agentTodoParser";
import { useSessionSubagents } from "../../hooks/useSessionSubagents";
import { useSessionFileChanges } from "../../hooks/useSessionFileChanges";
import { useSessionTodoSnapshot } from "../../hooks/useSessionTodoSnapshot";
import { useSessionDismissedFiles } from "../../hooks/useSessionDismissedFiles";
import type { PiSubagentEntry, SessionFileChange } from "../../../../shared/types";
import {
  sessionRuntimeBySessionIdAtomFamily,
  sessionRuntimeUiBySessionIdAtomFamily,
} from "../../atoms";
import {
  widgetsDisclosureCollapsedFamily,
  widgetsPopoverSegmentFamily,
  type WidgetsPopoverSegment,
} from "../../atoms/composer-atoms";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui-shadcn/dialog";
import {
  isFailureSubagentStatus,
  subagentIconKind,
  subagentStatusLabelSuffix,
} from "./subagentStatus";
import {
  isCoherentComposerRuntimeUi,
  type RuntimeHandle,
} from "./ComposerRuntimeIntegrations";
import { chatContentWidthStyle } from "./chatContentWidth";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** 任务段关闭记录已废弃：悬浮弹层改为点击外部自动收起，不再需要手动关闭指纹。 */
function progressLabel(items: { done: number; active: number; pending: number }): string {
  return [
    items.done > 0 ? t("sessionTodo.done", { done: items.done }) : null,
    items.active > 0 ? t("sessionTodo.active", { active: items.active }) : null,
    items.pending > 0 ? t("sessionTodo.pending", { pending: items.pending }) : null,
  ].filter(Boolean).join("\u2002·\u2002");
}

/* ------------------------------------------------------------------ */
/* Status Glyphs (copied from SessionTodoStrip)                       */
/* ------------------------------------------------------------------ */

function CompletedGlyph() { /* ... same as SessionTodoStrip */ return <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className="text-[var(--color-success)]"><circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" /><path d="M10.9631 5.71411L7.70154 8.97571C7.48011 9.19714 7.27736 9.40099 7.09229 9.54993C6.89742 9.70669 6.66314 9.85279 6.3634 9.90027C6.2049 9.92534 6.04339 9.92534 5.88489 9.90027C5.58515 9.85279 5.35087 9.70669 5.15601 9.54993C4.97093 9.40099 4.76818 9.19714 4.54675 8.97571L3.03516 7.46411L3.96313 6.53613L5.47473 8.04773C5.7169 8.28989 5.86196 8.43389 5.97888 8.52795C6.08597 8.61409 6.10875 8.60701 6.08997 8.604C6.11259 8.60758 6.13571 8.60758 6.15833 8.604C6.13954 8.60701 6.16232 8.61409 6.26941 8.52795C6.38633 8.43389 6.53139 8.28989 6.77356 8.04773L10.0352 4.78613L10.9631 5.71411Z" fill="currentColor" /></svg>; }
function SubagentStatusIcon({ status }: { status: string }) {
  const kind = subagentIconKind(status);
  if (kind === "completed") return <CompletedGlyph />;
  if (kind === "active") return <Loader2 size={14} className="animate-pideck-spin text-[var(--color-accent)]" />;
  if (kind === "error") return <X size={14} className="text-[var(--color-danger)]" />;
  // 非成功终态必须可明确区分：stopped/aborted 用红色系图形，绝不允许看起来像完成/未知
  if (kind === "stopped") return <Square size={11} strokeWidth={2.5} className="text-[var(--color-danger)]" />;
  if (kind === "aborted") return <Ban size={13} className="text-[var(--color-warning)]" />;
  if (kind === "steered") return <CornerUpRight size={13} className="text-[var(--color-info)]" />;
  return <span className="flex size-3.5 items-center justify-center rounded-full border border-text-tertiary" />;
}

/** 状态徽标配色：失败类红、steered 蓝、completed 绿、运行中琥珀、其余中性。 */
function subagentStatusBadgeClass(status: string): string {
  switch (subagentIconKind(status)) {
    case "completed": return "bg-success/15 text-success";
    case "active": return "bg-warning/15 text-warning";
    case "error":
    case "stopped":
    case "aborted": return "border border-danger/30 bg-danger-soft text-danger";
    case "steered": return "bg-info/15 text-info";
    default: return "bg-muted text-text-secondary";
  }
}

function formatDuration(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/* ------------------------------------------------------------------ */
/* Pane: Tasks                                                        */
/* ------------------------------------------------------------------ */

const TasksPane = (props: { sessionId: string; snapshotItems: AgentTodoItem[] }) => {
  const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(props.sessionId));
  const runtimeUi = useAtomValue(sessionRuntimeUiBySessionIdAtomFamily(props.sessionId));
  const runtimeHandle: RuntimeHandle | undefined = runtime?.agentId
    ? { agentId: runtime.agentId, runtimeGeneration: runtime.runtimeGeneration }
    : undefined;
  const coherent = isCoherentComposerRuntimeUi(runtimeHandle, runtimeUi) ? runtimeUi : undefined;
  const widgets = coherent?.widgets ?? {};

  const items = useMemo(() => {
    // DSH 不产出 Pi widget，优先消费其运行时的结构化 todos；Pi 活会话仍以 widget 为实时真源。
    if (runtime?.backend === "dsh") return runtimeTodosToItems(runtime.state?.todos);
    if (!coherent) return props.snapshotItems;
    const lines: string[] = [];
    for (const key of ["pi-deck-todo", "pi-deck-plan-todos"]) {
      const raw = widgets[key];
      if (!raw?.length) continue;
      const trimmed = key === "pi-deck-todo" ? stripPiDeckTodoWidgetMetadata(raw) : raw;
      lines.push(...trimmed);
    }
    return parseAgentTodoItems(lines);
  }, [coherent, runtime?.backend, runtime?.state?.todos, widgets, props.snapshotItems]);

  if (items.length === 0) {
    return <p className="px-3 py-4 text-[13px] text-text-tertiary">{t("sessionTodo.empty")}</p>;
  }

  return (
    <>
      <div className="px-3 pt-1">
        <span className="text-[13px] text-text-tertiary">{progressLabel({
          done: items.filter(i => i.status === "completed").length,
          active: items.filter(i => i.status === "in-progress").length,
          pending: items.filter(i => i.status === "pending").length,
        })}</span>
      </div>
      <ul className="mb-2 flex max-h-[180px] flex-col gap-2 overflow-y-auto overscroll-contain [contain:layout_paint] [scrollbar-gutter:stable] px-3">
        {items.map((item) => (
          <li key={item.id} className="flex min-w-0 items-center gap-2.5 text-[13px] leading-5 text-text-secondary">
            <span className="grid size-4 shrink-0 place-items-center">
              {item.status === "completed" ? <CompletedGlyph /> : item.status === "in-progress" ? <Loader2 size={14} className="animate-pideck-spin text-[var(--color-accent)]" /> : <svg width={14} height={14} viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.4 2.4" className="text-text-tertiary" /></svg>}
            </span>
            <span className="min-w-0 truncate">{item.title}</span>
          </li>
        ))}
      </ul>
    </>
  );
};

/* ------------------------------------------------------------------ */
/* Pane: Subagents                                                     */
/* ------------------------------------------------------------------ */

/** 单条子代理：点击行展开详情（描述 / 错误 / 结果预览 / 元信息 / 打开子会话）。 */
const SubagentEntryRow = (props: {
  entry: PiSubagentEntry;
  /** 所属会话：打开结果 Dialog 时从会话文件 record 拉取全文 */
  sessionId: string;
  onOpenChildSession?: (sessionId: string) => void;
}) => {
  const { entry } = props;
  // 失败类终态默认展开，让失败原因一眼可见；其余默认收起。
  // 弹层在 ComposerWidgetLayoutProvider 之外，用独立 family 保留展开态记忆。
  const [collapsed, setCollapsed] = useAtom(
    widgetsDisclosureCollapsedFamily({
      key: `subagent-entry:${entry.id}`,
      defaultCollapsed: !isFailureSubagentStatus(entry.status),
    }),
  );
  const isActive = entry.status === "running" || entry.status === "queued";
  const [resultDialogOpen, setResultDialogOpen] = useState(false);
  // 运行中时长平滑走秒：时长是 Date.now() - startedAt 的派生值，仅靠 bridge 事件
  // 推送重渲染会"一会儿蹦一下"；运行中的行自己挂 1s 心跳，终态/卸载时清理
  const [, tickNow] = useState(0);
  useEffect(() => {
    if (!isActive) return;
    const timer = window.setInterval(() => tickNow((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isActive]);
  // 「查看完整结果」每次打开现拉 record 全文：bridge 实时预览截断 2000 字符，
  // 只有会话文件里的 record 承载全文；record 尚未落盘（刚完成的瞬间）回落
  // 到截断文本并提示。只在 Dialog 打开期间拉一次，长文本由 MarkdownStream
  // 按 block memo 渲染，容器限高滚动。
  const [fullResult, setFullResult] = useState<string | null>(null);
  useEffect(() => {
    if (!resultDialogOpen) return;
    let cancelled = false;
    desktopApi.sessions
      .listSessionSubagents(props.sessionId)
      .then((entries) => {
        if (cancelled) return;
        setFullResult(entries.find((e) => e.id === entry.id)?.result ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [resultDialogOpen, entry.id, props.sessionId]);
  const hasLongText = Boolean(entry.result || entry.error);
  const displayResult = fullResult ?? entry.result ?? undefined;
  const duration = entry.completedAt && entry.startedAt
    ? formatDuration(entry.completedAt - entry.startedAt)
    : entry.startedAt && isActive
      ? formatDuration(Date.now() - entry.startedAt)
      : null;

  return (
    <li className={`rounded ${isActive ? "bg-muted/40" : ""}`}>
      <button
        type="button"
        className="flex min-w-0 w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] leading-5 hover:bg-muted/60"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className="grid size-5 shrink-0 place-items-center">
          <SubagentStatusIcon status={entry.status} />
        </span>
        <span className="shrink-0 font-medium text-foreground">{entry.type}</span>
        <span className="min-w-0 flex-1 truncate text-text-secondary">{entry.description}</span>
        {duration && <span className="shrink-0 tabular-nums text-text-tertiary">{duration}</span>}
        {entry.tokens != null && entry.tokens > 0 && <span className="shrink-0 tabular-nums text-xs text-text-tertiary">{entry.tokens.toLocaleString()} tk</span>}
        <ChevronDown
          size={13}
          className={`shrink-0 text-text-tertiary transition-transform ${collapsed ? "" : "rotate-180"}`}
          aria-hidden="true"
        />
      </button>
      {!collapsed && (
        <div className="flex flex-col gap-1.5 px-2 pb-2 pl-9 text-xs leading-5 text-text-secondary">
          {/* 元信息行：本地化状态徽标 + 起止时间与量化指标 */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-text-tertiary">
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${subagentStatusBadgeClass(entry.status)}`}>
              {t(`sessionSubagents.status.${subagentStatusLabelSuffix(entry.status)}`)}
            </span>
            {entry.toolUses != null && entry.toolUses > 0 && (
              <span>{t("sessionSubagents.detailToolUses", { count: entry.toolUses })}</span>
            )}
            {entry.tokens != null && entry.tokens > 0 && (
              <span>{t("sessionSubagents.detailTokens", { count: entry.tokens.toLocaleString() })}</span>
            )}
            {entry.startedAt != null && (
              <span>{t("sessionSubagents.detailStartedAt", { time: new Date(entry.startedAt).toLocaleTimeString() })}</span>
            )}
            {entry.completedAt != null && (
              <span>{t("sessionSubagents.detailCompletedAt", { time: new Date(entry.completedAt).toLocaleTimeString() })}</span>
            )}
          </div>
          {entry.description && (
            <p className="whitespace-pre-wrap break-words">{entry.description}</p>
          )}
          {entry.error && (
            <div className="whitespace-pre-wrap break-words rounded border border-danger/30 bg-danger-soft px-2 py-1.5 text-danger">
              {entry.error}
            </div>
          )}
          {entry.result && (
            <div className="max-h-32 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words rounded bg-muted/50 px-2 py-1.5">
              {entry.result}
            </div>
          )}
          {(entry.childSessionId || hasLongText) && (
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              {entry.childSessionId && props.onOpenChildSession && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 gap-1 px-2 text-xs text-text-secondary hover:text-foreground"
                  onClick={() => props.onOpenChildSession?.(entry.childSessionId ?? "")}
                >
                  <ExternalLink size={12} />
                  {t("sessionSubagents.openChildSession")}
                </Button>
              )}
              {hasLongText && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-xs text-text-secondary hover:text-foreground"
                  onClick={() => setResultDialogOpen(true)}
                >
                  <FileText size={12} />
                  {t("sessionSubagents.viewFullResult")}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {/* 完整结果 Dialog：长结果/无子会话文件时的完整终态文本与元信息 */}
      {hasLongText && (
        <Dialog open={resultDialogOpen} onOpenChange={setResultDialogOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{t("sessionSubagents.dialogTitle", { type: entry.type })}</DialogTitle>
            </DialogHeader>
            <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto overscroll-contain">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-tertiary">
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${subagentStatusBadgeClass(entry.status)}`}>
                  {t(`sessionSubagents.status.${subagentStatusLabelSuffix(entry.status)}`)}
                </span>
                {entry.toolUses != null && entry.toolUses > 0 && (
                  <span>{t("sessionSubagents.detailToolUses", { count: entry.toolUses })}</span>
                )}
                {entry.tokens != null && entry.tokens > 0 && (
                  <span>{t("sessionSubagents.detailTokens", { count: entry.tokens.toLocaleString() })}</span>
                )}
                {entry.startedAt != null && (
                  <span>{t("sessionSubagents.detailStartedAt", { time: new Date(entry.startedAt).toLocaleTimeString() })}</span>
                )}
                {entry.completedAt != null && (
                  <span>{t("sessionSubagents.detailCompletedAt", { time: new Date(entry.completedAt).toLocaleTimeString() })}</span>
                )}
              </div>
              {entry.description && (
                <p className="whitespace-pre-wrap break-words text-xs text-text-secondary">{entry.description}</p>
              )}
              {entry.error && (
                <div className="whitespace-pre-wrap break-words rounded border border-danger/30 bg-danger-soft px-2 py-1.5 text-xs text-danger">
                  {entry.error}
                </div>
              )}
              {(displayResult) && (
                // 完整结果按 Markdown 渲染：子代理返回普遍是 md 文本，与会话正文
                // /FileDiffViewer 预览共用同一 Streamdown 引擎（code/mermaid/math）。
                // 优先 record 全文（fullResult），record 未落盘时回落 bridge 截断预览
                <div className="markdown-body break-words rounded bg-muted/50 px-3 py-2 text-xs text-text-secondary">
                  <MarkdownStream text={displayResult} onOpenExternal={() => undefined} />
                </div>
              )}
              {!fullResult && entry.source === "bridge" && entry.result && entry.result.length >= 2000 && (
                <p className="text-[11px] text-text-tertiary">{t("sessionSubagents.fullResultPending")}</p>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </li>
  );
};

const SubagentsPane = (props: {
  entries: PiSubagentEntry[];
  pluginActive: boolean | undefined;
  loading: boolean;
  sessionId: string;
  onOpenChildSession?: (sessionId: string) => void;
}) => {
  // 数据由弹层主组件传入（主组件常驻订阅），避免弹层开关时二次发 IPC 导致
  // 空态→加载中→列表 三态跳变闪烁
  const { entries, pluginActive, loading } = props;

  if (loading && entries.length === 0) {
    return <p className="px-3 py-4 text-[13px] text-text-tertiary">{t("sessionSubagents.loading")}</p>;
  }

  if (entries.length === 0) {
    // 空态区分插件是否在运行：让用户知道为什么没数据
    if (pluginActive === true) {
      return <p className="px-3 py-4 text-[13px] text-text-tertiary">{t("sessionSubagents.emptyActive")}</p>;
    }
    if (pluginActive === false) {
      return (
        <p className="px-3 py-4 text-[13px] text-text-tertiary">
          {t("sessionSubagents.notInstalled")}
          {" "}
          {t("sessionSubagents.installHint")}
        </p>
      );
    }
    // pluginActive undefined = 纯历史会话，无桥接 → 简单空态
    return <p className="px-3 py-4 text-[13px] text-text-tertiary">{t("sessionSubagents.empty")}</p>;
  }

  return (
    <ul className="mb-2 flex max-h-[240px] flex-col gap-1 overflow-y-auto overscroll-contain [contain:layout_paint] [scrollbar-gutter:stable] px-3">
      {entries.map((entry) => (
        <SubagentEntryRow
          key={entry.id}
          entry={entry}
          sessionId={props.sessionId}
          onOpenChildSession={props.onOpenChildSession}
        />
      ))}
    </ul>
  );
};

/* ------------------------------------------------------------------ */
/* Pane: Files                                                        */
/* ------------------------------------------------------------------ */

type ModifiedFileEntry = SessionFileChange;

const FileEntry = (props: { sessionId: string; runId: string; entry: ModifiedFileEntry; onDiffFile?: DiffFileHandler }) => {
  const [collapsed, setCollapsed] = useAtom(
    widgetsDisclosureCollapsedFamily({
      key: `modified-file-diff:${props.sessionId}:${props.runId}:${props.entry.path}`,
      defaultCollapsed: true,
    }),
  );
  return (
    // items-start + h-9 包裹：跳转按钮始终与顶部文件行（min-h-9）垂直居中对齐，
    // 不会因 FileDiff 展开后整体变高而跑到中间
    // flex-1 必须加在根 div 上：行宽撑满卡片后统计组（+N -N）才统一钉在右缘；
    // 否则行宽收缩为内容宽，而收起的 AgentDisclosure（height:0 但仍占位宽度）
    // 会让每行宽度随各自 diff 最长行变化，统计组逐行错位
    <div className="flex min-w-0 flex-1 items-start gap-1">
      <FileDiff
        className="min-w-0 flex-1"
        file={`${props.entry.path}${props.entry.count > 1 ? ` ×${props.entry.count}` : ""}`}
        lines={fileChangeToDiffLines(props.entry)}
        status="complete"
        open={!collapsed}
        onOpenChange={(open) => { setCollapsed(!open); }}
        maxHeight={200}
        language="diff"
        // 弹层悬浮后高度变化不再传导布局；保留瞬时开合避免面板内滚动跳变
        animateHeight={false}
      />
      {props.onDiffFile && (
        <div className="flex h-9 shrink-0 items-center">
          <Button variant="ghost" size="icon-xs" className="size-6 rounded" title={t("sessionFiles.openInDiffViewer")} onClick={() => props.onDiffFile?.(props.entry.path)}>
            <ExternalLink size={12} />
          </Button>
        </div>
      )}
    </div>
  );
};

const FilesPane = (props: {
  sessionId: string;
  entries: SessionFileChange[];
  loading: boolean;
  onDiffFile?: DiffFileHandler;
  onSaveAll?: () => void;
}) => {
  const { entries, loading } = props;

  if (loading && entries.length === 0) {
    return <p className="px-3 py-4 text-[13px] text-text-tertiary">{t("sessionFiles.loading")}</p>;
  }

  if (entries.length === 0) {
    return <p className="px-3 py-4 text-[13px] text-text-tertiary">{t("sessionFiles.empty")}</p>;
  }

  // 会话级全量列表 + 限高滚动（与任务/子代理 pane 一致，不再截断为「更多」）
  return (
    <>
      <div className="flex items-center justify-between px-3 pt-1">
        <span className="text-[13px] text-text-tertiary">{t("sessionFiles.count", { count: entries.length })}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 text-xs text-text-tertiary hover:bg-muted hover:text-foreground"
          onClick={props.onSaveAll}
        >
          <Save size={13} />
          <span>{t("sessionFiles.saveAll")}</span>
        </Button>
      </div>
      <ul className="mb-2 flex max-h-[200px] flex-col gap-1 overflow-y-auto overscroll-contain [contain:layout_paint] [scrollbar-gutter:stable] px-3">
        {entries.map((entry) => (
          <li key={entry.path} className="flex min-w-0 items-center gap-1">
            <FileEntry sessionId={props.sessionId} runId="session" entry={entry} onDiffFile={props.onDiffFile} />
          </li>
        ))}
      </ul>
    </>
  );
};

/* ------------------------------------------------------------------ */
/* Popover                                                             */
/* ------------------------------------------------------------------ */

export function SessionWidgetsPopover(props: {
  sessionId: string;
  run?: AgentRunItem;
  onDiffFile?: DiffFileHandler;
  /** 打开子会话只读视图（SessionView 透传 openSidebarSessionById 通路） */
  onOpenChildSession?: (sessionId: string) => void;
}) {
  const [openSegment, setOpenSegment] = useAtom(widgetsPopoverSegmentFamily(props.sessionId));

  // 退出动画：openSegment 置 null 后先播 100ms 淡出（纯 transform/opacity），
  // 再卸载内容。弹层是悬浮层不参与布局，动画只是纯装饰。
  const [displaySegment, setDisplaySegment] = useState<WidgetsPopoverSegment | null>(null);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (openSegment !== null) {
      setClosing(false);
      setDisplaySegment(openSegment);
      return;
    }
    if (displaySegment === null) return;
    setClosing(true);
    const timer = window.setTimeout(() => {
      setDisplaySegment(null);
      setClosing(false);
    }, 100);
    return () => window.clearTimeout(timer);
  }, [openSegment, displaySegment]);

  // 点击弹窗外部自动收起：弹层内点击、分段条自身切换点击、Dialog 内点击均不触发。
  // mousedown 早于 click，先收起；分段条按钮被排除，由其 onClick 自行切换。
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (displaySegment === null) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      // 分段条按钮：由 Card 的 onClick 切换，不能在这里收起（否则 mousedown 关、click 又开）
      if (target.closest('[data-testid="session-widgets-card"]')) return;
      // 子代理完整结果 Dialog 渲染在 body portal，点击 Dialog 内容不应连带收起弹层
      if (target.closest('[role="dialog"]')) return;
      setOpenSegment(null);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [displaySegment, setOpenSegment]);

  const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(props.sessionId));
  const runtimeUi = useAtomValue(sessionRuntimeUiBySessionIdAtomFamily(props.sessionId));
  const runtimeHandle: RuntimeHandle | undefined = runtime?.agentId
    ? { agentId: runtime.agentId, runtimeGeneration: runtime.runtimeGeneration }
    : undefined;
  const coherent = isCoherentComposerRuntimeUi(runtimeHandle, runtimeUi) ? runtimeUi : undefined;

  // 会话级 todo 快照：仅历史会话（无 coherent runtime）拉取，避免活会话多余 IPC
  const todoSnapshot = useSessionTodoSnapshot(props.sessionId, !coherent);
  const snapshotTodoItems = useMemo(() => sessionTodoSnapshotToItems(todoSnapshot), [todoSnapshot]);

  const { entries: subagentEntries, pluginActive: subagentsPluginActive, loading: subagentsLoading } = useSessionSubagents(props.sessionId);

  // 会话级文件汇总（主进程全量 + 当前 run 增量），跨轮次/会话切换不丢
  const { entries: fileEntries, loading: fileLoading } = useSessionFileChanges(props.sessionId, props.run);

  // “保存全部”清空快照跨组件共享（分段条徽标也要读），见 useSessionDismissedFiles
  const { snapshot: dismissedFilesSnapshot, dismissAll } = useSessionDismissedFiles(props.sessionId);

  const visibleFileEntries = useMemo(() => {
    if (!dismissedFilesSnapshot) return fileEntries;
    return fileEntries.filter((e) => (dismissedFilesSnapshot[e.path] ?? 0) < e.count);
  }, [fileEntries, dismissedFilesSnapshot]);

  const saveAllFiles = useCallback(() => {
    dismissAll(fileEntries);
  }, [dismissAll, fileEntries]);

  if (displaySegment === null) return null;

  return (
    // 外层只做定位；内层卡片宽度与分段条同基准（chatContentWidthStyle），
    // 底部留 6px 间距形成悬浮感，与贴底“整片面板”观感区分开
    <div className="absolute inset-x-0 bottom-1.5 z-20">
      <div
        ref={popoverRef}
        style={chatContentWidthStyle}
        className={`max-h-[260px] overflow-y-auto overscroll-contain rounded-lg border border-border/50 bg-bg-panel shadow-lg [scrollbar-gutter:stable] ${
          closing
            ? "motion-safe:animate-out motion-safe:fade-out-0 motion-safe:slide-out-to-bottom-1 motion-safe:duration-100 motion-reduce:animate-none"
            : "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-100 motion-reduce:animate-none"
        }`}
      >
        {displaySegment === "tasks" && (
          <TasksPane sessionId={props.sessionId} snapshotItems={snapshotTodoItems} />
        )}
        {displaySegment === "subagents" && (
          <SubagentsPane
            entries={subagentEntries}
            pluginActive={subagentsPluginActive}
            loading={subagentsLoading}
            sessionId={props.sessionId}
            onOpenChildSession={props.onOpenChildSession}
          />
        )}
        {displaySegment === "files" && (
          <FilesPane
            sessionId={props.sessionId}
            entries={visibleFileEntries}
            loading={fileLoading}
            onDiffFile={props.onDiffFile}
            onSaveAll={saveAllFiles}
          />
        )}
      </div>
    </div>
  );
}
