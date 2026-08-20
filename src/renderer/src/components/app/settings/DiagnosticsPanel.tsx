import { useCallback, useEffect, useState } from "react";
import type { DiagnosticsSnapshot } from "../../../../../shared/types";
import { formatBytes } from "../../../../../shared/formatBytes";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { SettingRow, SettingSwitchRow } from "./SettingRows";

type DiagnosticsPanelProps = {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
};

/**
 * 开发设置里的性能诊断：开关 + 即时快照。
 * 采样在主进程，本面板只拉 snapshot / 打开目录，不做轮询以免关着也有开销。
 */
export function DiagnosticsPanel(props: DiagnosticsPanelProps) {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await desktopApi.system.getDiagnosticsSnapshot();
      setSnapshot(next);
    } catch {
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (props.enabled) void refresh();
  }, [props.enabled, refresh]);

  const lag = snapshot?.eventLoopLagMs ?? 0;
  const maxLag = snapshot?.eventLoopLagMaxMs ?? 0;
  const timings = snapshot?.recentTimings ?? [];

  return (
    <>
      <SettingSwitchRow
        title={t("settings.developerDiagnostics")}
        description={t("settings.developerDiagnosticsDesc")}
        checked={props.enabled}
        onChange={props.onChange}
      />
      {props.enabled ? (
        <SettingRow
          title={<span>{t("settings.developerDiagnosticsRefresh")}</span>}
          description={
            snapshot
              ? `${t("settings.developerDiagnosticsMemory", {
                  rss: formatBytes(snapshot.main.rssBytes),
                  heap: formatBytes(snapshot.main.heapUsedBytes),
                })} · ${t("settings.developerDiagnosticsLag", {
                  lag: String(lag),
                  max: String(maxLag),
                })}`
              : t("settings.developerDiagnosticsEmpty")
          }
          stacked
        >
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={loading} onClick={() => void refresh()}>
              {t("settings.developerDiagnosticsRefresh")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => void desktopApi.system.openDiagnosticsFolder()}
            >
              {t("settings.developerDiagnosticsOpenFolder")}
            </Button>
          </div>
          {timings.length > 0 ? (
            <ul className="mt-2 max-h-48 overflow-auto font-mono text-caption text-muted-foreground">
              {timings.slice(0, 20).map((item, index) => (
                <li key={`${item.name}-${item.startedAt}-${index}`}>
                  {item.durationMs}ms {item.name}
                  {item.detail?.agentId ? ` ${String(item.detail.agentId).slice(0, 8)}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </SettingRow>
      ) : null}
    </>
  );
}
