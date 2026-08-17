import { memo, useEffect, useState } from "react";
import type { AppSettings } from "../../../../../shared/types";
import { desktopApi as api } from "../../../desktopApi";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { SettingBox, SettingRow, SettingSwitchRow } from "./SettingRows";

type DshTabProps = {
  draft: AppSettings;
  updateDraft: (patch: Partial<AppSettings>) => void;
  isDirty: (field: keyof AppSettings) => boolean;
};

/**
 * 设置弹框「DSH」tab（G11）：DSH 后端全局设置入口——DSH_HOME 目录、审批自动放行、
 * host 状态。完整配置（模型/预设/插件/认证）仍在 ConfigModal 的 DSH 页。
 * 目录切换写入草稿，保存后由主进程生效（重启 host）。
 */
export const DshTab = memo(function DshTab(props: DshTabProps) {
  const { draft, updateDraft } = props;
  const [status, setStatus] = useState<{ started: boolean; homeDir: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.sessions.getDshStatus().then((next) => {
      if (!cancelled) setStatus(next);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const pickHome = async () => {
    const picked = await api.dialog.pickFiles({
      title: t("config.dsh.pickHomeTitle"),
      includeDirectories: true,
    });
    const dir = picked?.[0];
    if (dir) updateDraft({ dshHomeDir: dir });
  };

  return (
    <SettingBox>
      <SettingRow
        level={1}
        title={t("settings.dsh.statusTitle")}
        description={
          status?.homeDir
            ? t("settings.dsh.statusDesc", { home: status.homeDir })
            : t("settings.dsh.statusDescUnknown")
        }
      >
        <span className="text-control">
          {status
            ? status.started
              ? t("settings.dsh.started")
              : t("settings.dsh.notStarted")
            : "…"}
        </span>
      </SettingRow>
      <SettingRow
        title={t("settings.dsh.homeDir")}
        description={t("settings.dsh.homeDirDesc")}
        stacked
      >
        <div className="flex w-full gap-2">
          <Input
            value={draft.dshHomeDir ?? ""}
            placeholder={t("settings.dsh.homeDirPlaceholder")}
            onChange={(event) =>
              updateDraft({ dshHomeDir: event.target.value.trim() ? event.target.value : undefined })
            }
          />
          <Button variant="outline" onClick={() => void pickHome()}>
            {t("config.dsh.changeHome")}
          </Button>
        </div>
      </SettingRow>
      <SettingSwitchRow
        title={t("settings.dsh.autoAllowApproval")}
        description={t("settings.dsh.autoAllowApprovalDesc")}
        checked={draft.dshApprovalAutoAllow === true}
        onChange={(checked) => updateDraft({ dshApprovalAutoAllow: checked })}
      />
      <SettingSwitchRow
        title={t("settings.dsh.autoImportForeign")}
        description={t("settings.dsh.autoImportForeignDesc")}
        checked={draft.dshAutoImportSessions !== false}
        onChange={(checked) => updateDraft({ dshAutoImportSessions: checked })}
      />
    </SettingBox>
  );
});
