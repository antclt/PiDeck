/**
 * SessionWidgetsCard — 任务 / 子代理 / 编辑文件分段长条卡（纯分段条）。
 *
 * 挂在 composer widgets 槽位，替代原 SessionTodoStrip + SessionModifiedFilesStrip。
 * SessionGoalStrip 保持独立（D4）。
 *
 * Pi 会话展示任务、子代理、文件三段；DSH 会话展示任务、文件两段。
 * 交互设计：分段长条常驻平分一整条可点击；点击切换弹层分段（弹层本体
 * SessionWidgetsPopover 渲染在 timeline 面板底部悬浮层，本组件只写
 * widgetsPopoverSegmentFamily，不再持有弹层/开合动画/高度管理）。
 */

import { useAtom, useAtomValue } from "jotai";
import { useMemo, type ReactNode } from "react";
import { Bot, FileEdit, ListChecks } from "lucide-react";
import type { AgentRunItem } from "./timeline/types";
import {
  parseAgentTodoItems,
  runtimeTodosToItems,
  sessionTodoSnapshotToItems,
  stripPiDeckTodoWidgetMetadata,
} from "./agentTodoParser";
import { useSessionSubagents } from "../../hooks/useSessionSubagents";
import { useSessionFileChanges } from "../../hooks/useSessionFileChanges";
import { useSessionTodoSnapshot } from "../../hooks/useSessionTodoSnapshot";
import { useSessionDismissedFiles } from "../../hooks/useSessionDismissedFiles";
import {
  sessionRuntimeBySessionIdAtomFamily,
  sessionRuntimeUiBySessionIdAtomFamily,
} from "../../atoms";
import {
  widgetsPopoverSegmentFamily,
  type WidgetsPopoverSegment,
} from "../../atoms/composer-atoms";
import { t } from "../../i18n";
import { ComposerWidgetFrame } from "./ComposerWidgetLayout";
import {
  isCoherentComposerRuntimeUi,
  type RuntimeHandle,
} from "./ComposerRuntimeIntegrations";

export function SessionWidgetsCard(props: {
  sessionId: string;
  run?: AgentRunItem;
}) {
  const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(props.sessionId));
  const runtimeUi = useAtomValue(sessionRuntimeUiBySessionIdAtomFamily(props.sessionId));

  // 子代理仅由 Pi 扩展提供；DSH 的官方 todos 同样需要在任务段实时展示。
  const isPi = runtime?.backend === "pi" || !runtime?.backend || runtime?.backend === "imagegen" /* default to pi */;
  const supportsTasks = isPi || runtime?.backend === "dsh";

  const runtimeHandle: RuntimeHandle | undefined = runtime?.agentId
    ? { agentId: runtime.agentId, runtimeGeneration: runtime.runtimeGeneration }
    : undefined;
  const coherent = isCoherentComposerRuntimeUi(runtimeHandle, runtimeUi) ? runtimeUi : undefined;
  const widgets = coherent?.widgets ?? {};

  // 会话级 todo 快照：仅历史会话（无 coherent runtime）拉取，避免活会话多余 IPC
  const todoSnapshot = useSessionTodoSnapshot(props.sessionId, !coherent);
  const snapshotTodoItems = useMemo(() => sessionTodoSnapshotToItems(todoSnapshot), [todoSnapshot]);

  const todoItems = useMemo(() => {
    // DSH 不产出 Pi widget，优先消费其运行时的结构化 todos；Pi 活会话仍以 widget 为实时真源。
    if (runtime?.backend === "dsh") return runtimeTodosToItems(runtime.state?.todos);
    if (!coherent) return snapshotTodoItems;
    const lines: string[] = [];
    for (const key of ["pi-deck-todo", "pi-deck-plan-todos"]) {
      const raw = widgets[key];
      if (raw?.length) {
        const trimmed = key === "pi-deck-todo" ? stripPiDeckTodoWidgetMetadata(raw) : raw;
        lines.push(...trimmed);
      }
    }
    return parseAgentTodoItems(lines);
  }, [coherent, runtime?.backend, runtime?.state?.todos, widgets, snapshotTodoItems]);
  const todoCount = todoItems.length;
  // 徽标展示「已完成/总数」，实时反映完成进度
  const todoDone = todoItems.filter((item) => item.status === "completed").length;

  const { entries: subagentEntries } = useSessionSubagents(props.sessionId);
  const subagentCount = subagentEntries.length;
  const subagentRunning = subagentEntries.filter(e => e.status === "running" || e.status === "queued").length;

  // 会话级文件汇总（主进程全量 + 当前 run 增量），跨轮次/会话切换不丢
  const { entries: fileEntries } = useSessionFileChanges(props.sessionId, props.run);

  // “保存全部”清空快照与弹层共享（useSessionDismissedFiles），徽标显示未清空数量
  const { snapshot: dismissedFilesSnapshot } = useSessionDismissedFiles(props.sessionId);

  const visibleFileEntries = useMemo(() => {
    if (!dismissedFilesSnapshot) return fileEntries;
    return fileEntries.filter((e) => (dismissedFilesSnapshot[e.path] ?? 0) < e.count);
  }, [fileEntries, dismissedFilesSnapshot]);
  const fileCount = visibleFileEntries.length;

  // 弹层打开分段：本组件只写 atom，弹层本体（SessionWidgetsPopover）负责渲染
  const [openSegment, setOpenSegment] = useAtom(widgetsPopoverSegmentFamily(props.sessionId));

  const segments: WidgetsPopoverSegment[] = isPi
    ? ["tasks", "subagents", "files"]
    : supportsTasks
      ? ["tasks", "files"]
      : ["files"];

  const countFor = (id: WidgetsPopoverSegment): number =>
    id === "tasks" ? todoCount : id === "subagents" ? subagentCount : fileCount;

  const labelFor = (id: WidgetsPopoverSegment): string => {
    if (id === "tasks") return t("sessionWidgets.tasksTab");
    if (id === "subagents") return t("sessionWidgets.subagentsTab");
    return t("sessionWidgets.filesTab");
  };

  const iconFor = (id: WidgetsPopoverSegment): ReactNode => {
    if (id === "tasks") return <ListChecks size={13} />;
    if (id === "subagents") return <Bot size={13} />;
    return <FileEdit size={13} />;
  };

  return (
    <ComposerWidgetFrame data-testid="session-widgets-card">
      {/* 分段长条：三段平分一整条，段间分隔线；点击切换上方弹层分段 */}
      <div className="flex divide-x divide-border/40">
        {segments.map((seg) => {
          const count = countFor(seg);
          // 待办段展示「已完成/总数」，其余段保持纯计数
          const badgeText = seg === "tasks" ? `${todoDone}/${count}` : String(count);
          const isOpen = openSegment === seg;
          return (
            <button
              key={seg}
              type="button"
              className={`flex flex-1 items-center justify-center gap-1.5 px-2 py-2 text-[13px] leading-5 transition-colors ${
                isOpen
                  ? "text-foreground font-medium"
                  : "text-text-tertiary hover:text-text-secondary"
              }`}
              aria-pressed={isOpen}
              onClick={() => setOpenSegment((cur) => (cur === seg ? null : seg))}
            >
              {iconFor(seg)}
              <span>{labelFor(seg)}</span>
              {count > 0 && (
                <span className={`rounded-full px-1.5 py-0.5 text-[11px] leading-none font-medium ${
                  isOpen ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]" : "bg-muted text-text-tertiary"
                }`}>
                  {badgeText}
                </span>
              )}
              {seg === "subagents" && subagentRunning > 0 && (
                <span className="flex size-1.5 rounded-full bg-[var(--color-accent)] animate-pulse" aria-label={t("sessionWidgets.runningIndicator")} />
              )}
            </button>
          );
        })}
      </div>
    </ComposerWidgetFrame>
  );
}
