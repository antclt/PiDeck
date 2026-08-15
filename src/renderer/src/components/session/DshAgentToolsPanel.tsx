import { useAtomValue } from "jotai";
import { CheckCircle2, Loader2, Pause, Play, Target, Users, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { sessionRuntimeBySessionIdAtomFamily } from "../../atoms";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent } from "../ui-shadcn/dialog";
import { Input } from "../ui-shadcn/input";

/**
 * DSH 会话工具面板（G5/G6）：目标管理 + 子代理呈现。
 * - 目标：当前 goal（runtime state 投影）显示 + 创建 / pause / resume / complete / clear；
 * - 子代理：subagent.list 直接子代目录 + 展开只读 transcript。
 */
export function DshAgentToolsPanel(props: {
  sessionId: string;
  agentId: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"goals" | "subagents">("goals");
  return (
    <Dialog open onOpenChange={(next) => !next && props.onClose()}>
      <DialogContent showCloseButton className="sm:max-w-lg">
        <div className="flex gap-1 border-b border-border-subtle pb-2">
          <Button
            variant={tab === "goals" ? "secondary" : "ghost"}
            size="sm"
            className="gap-1.5"
            onClick={() => setTab("goals")}
          >
            <Target size={14} aria-hidden="true" />
            {t("dshTools.goals")}
          </Button>
          <Button
            variant={tab === "subagents" ? "secondary" : "ghost"}
            size="sm"
            className="gap-1.5"
            onClick={() => setTab("subagents")}
          >
            <Users size={14} aria-hidden="true" />
            {t("dshTools.subagents")}
          </Button>
        </div>
        <div className="min-h-40 overflow-y-auto">
          {tab === "goals"
            ? <GoalsPanel sessionId={props.sessionId} agentId={props.agentId} />
            : <SubagentsPanel agentId={props.agentId} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 目标管理：当前 goal（runtime state 投影）+ 创建/操作。 */
function GoalsPanel(props: { sessionId: string; agentId: string }) {
  const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(props.sessionId));
  const goal = runtime?.state?.goal;
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), 4000);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const create = () => {
    if (!objective.trim()) return;
    void run(async () => {
      await desktopApi.sessions.createDshGoal(props.agentId, objective);
      setObjective("");
    });
  };

  const act = (action: "pause" | "resume" | "complete" | "clear") => {
    void run(() => desktopApi.sessions.runDshGoalAction(props.agentId, action));
  };

  return (
    <div className="flex flex-col gap-3 p-1">
      {goal ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-bg-panel/60 p-3">
          <div className="flex items-center gap-2">
            <Target size={14} className="shrink-0 text-primary" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-control font-medium text-foreground">
              {goal.objective}
            </span>
            <span className="shrink-0 rounded bg-accent/50 px-1.5 py-0.5 text-micro text-text-secondary">
              {t(`dshTools.goalPhase.${goal.phase}`)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-micro text-text-tertiary">
              {t("dshTools.goalRounds", { rounds: goal.roundsStarted, cap: goal.maxGoalRounds })}
            </span>
            <div className="flex shrink-0 gap-1">
              {goal.phase === "active" && (
                <Button variant="outline" size="sm" className="h-7 gap-1 px-2" disabled={busy} onClick={() => act("pause")}>
                  <Pause size={12} aria-hidden="true" />{t("dshTools.goalPause")}
                </Button>
              )}
              {(goal.phase === "paused" || goal.phase === "blocked") && (
                <Button variant="outline" size="sm" className="h-7 gap-1 px-2" disabled={busy} onClick={() => act("resume")}>
                  <Play size={12} aria-hidden="true" />{t("dshTools.goalResume")}
                </Button>
              )}
              {goal.phase !== "complete" && (
                <Button variant="outline" size="sm" className="h-7 gap-1 px-2" disabled={busy} onClick={() => act("complete")}>
                  <CheckCircle2 size={12} aria-hidden="true" />{t("dshTools.goalComplete")}
                </Button>
              )}
              <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-destructive" disabled={busy} onClick={() => act("clear")}>
                <XCircle size={12} aria-hidden="true" />{t("dshTools.goalClear")}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <p className="px-1 text-caption text-text-secondary">{t("dshTools.goalEmpty")}</p>
      )}
      <div className="flex gap-2">
        <Input
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          placeholder={t("dshTools.goalPlaceholder")}
          onKeyDown={(event) => {
            if (event.key === "Enter") create();
          }}
        />
        <Button size="sm" className="shrink-0 gap-1" disabled={busy || !objective.trim()} onClick={create}>
          {busy && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
          {t("dshTools.goalCreate")}
        </Button>
      </div>
    </div>
  );
}

type SubagentEntry = {
  id: string;
  label?: string;
  activity: "running" | "inactive";
  hasChildren: boolean;
  mode: "one-shot" | "continuable";
  kind: "child" | "diagnostic";
};

/** 子代理列表 + 展开只读 transcript。 */
function SubagentsPanel(props: { agentId: string }) {
  const [entries, setEntries] = useState<SubagentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Array<{ role: string; text: string }>>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void desktopApi.sessions.listDshSubagents(props.agentId).then((items) => {
      if (!cancelled) setEntries(items);
    }).catch(() => {
      if (!cancelled) setEntries([]);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [props.agentId]);

  const toggle = async (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      setTranscript([]);
      return;
    }
    setExpanded(id);
    setTranscript([]);
    const page = await desktopApi.sessions.readDshSubagentHistory(props.agentId, id).catch(() => null);
    if (page) {
      setTranscript(page.messages.map((message) => ({ role: message.role, text: message.text })));
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 p-3 text-caption text-text-secondary"><Loader2 size={14} className="animate-spin" aria-hidden="true" />{t("dshTools.loading")}</div>;
  }
  if (entries.length === 0) {
    return <p className="p-3 text-caption text-text-secondary">{t("dshTools.subagentsEmpty")}</p>;
  }
  return (
    <div className="flex flex-col gap-1.5 p-1">
      {entries.map((entry) => (
        <div key={entry.id} className="flex flex-col rounded-lg border border-border-subtle bg-bg-panel/60">
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/40"
            onClick={() => void toggle(entry.id)}
          >
            <Users size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-control font-medium text-foreground">
              {entry.label ?? entry.id}
            </span>
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-micro ${entry.activity === "running" ? "bg-primary/15 text-primary" : "bg-accent/50 text-text-secondary"}`}>
              {entry.activity === "running" ? t("dshTools.subagentRunning") : t("dshTools.subagentInactive")}
            </span>
            {entry.mode === "continuable" && (
              <span className="shrink-0 text-micro text-text-tertiary">{t("dshTools.subagentContinuable")}</span>
            )}
          </button>
          {expanded === entry.id && (
            <div className="flex max-h-56 flex-col gap-1 overflow-y-auto border-t border-border-subtle p-2">
              {transcript.length === 0 && <p className="px-1 text-caption text-text-tertiary">{t("dshTools.subagentTranscriptEmpty")}</p>}
              {transcript.map((message, index) => (
                <div key={index} className={`flex flex-col gap-0.5 rounded-md px-2 py-1 ${message.role === "user" ? "bg-accent/30" : "bg-bg-panel"}`}>
                  <span className="text-micro text-text-tertiary">{message.role === "user" ? t("dshTools.roleUser") : t("dshTools.roleAssistant")}</span>
                  <span className="whitespace-pre-wrap break-words text-caption text-foreground">{message.text || "…"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
