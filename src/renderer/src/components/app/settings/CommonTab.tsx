import { memo, useState } from "react";
import { useAtomValue } from "jotai";
import type { AppSettings } from "../../../../../shared/types";
import { dshUiVisibilityFor } from "../../../../../shared/types/dshRuntime";
import { dshRuntimeStatusAtom } from "../../../atoms";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";
import { ConfirmDialog } from "../../ui-shadcn/ConfirmDialog";
import { Button } from "../../ui-shadcn/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui-shadcn/select";
import { SettingsSection } from "./SettingsStorageTab";
import { DirtyMarker, SettingBox, SettingRow, SettingSwitchRow } from "./SettingRows";

type CommonTabProps = {
  draft: AppSettings;
  updateDraft: (patch: Partial<AppSettings>) => void;
  isDirty: (field: keyof AppSettings) => boolean;
};

/** 下拉选项：disabled 可选（SelectItem 透传） */
type SelectOption = { value: string; label: string; disabled?: boolean };

/**
 * 设置弹框「常用设置」tab：语言/会话/通知/窗口（Git 分区已拆为独立 tab）。
 * 独立组件 + memo：切换 tab 或壳层无关状态变化时不重渲染本 tab。
 */
export const CommonTab = memo(function CommonTab(props: CommonTabProps) {
  const { draft, updateDraft, isDirty } = props;
  // DSH runtime 安装态：runtime 不可用时 dsh 选项禁选，
  // 否则用户能选到一个「保存成功但新建会话必失败」的后端。
  const dshRuntimeStatus = useAtomValue(dshRuntimeStatusAtom);
  const dshAvailable = dshUiVisibilityFor(dshRuntimeStatus.state).canCreateDshSession;
  const [uninstallOpen, setUninstallOpen] = useState(false);

  // 版本文案按来源分：外部安装的可卸，内置的不行（删了无法补回）。
  const dshRuntimeLabel = dshRuntimeStatus.runtimeVersion
    ? dshRuntimeStatus.source === "managed"
      ? t("settings.dshRuntimeManaged", { version: dshRuntimeStatus.runtimeVersion })
      : t("settings.dshRuntimeBuiltin", { version: dshRuntimeStatus.runtimeVersion })
    : t("settings.dshRuntimeUnknown");
  const dshRuntimeDescription =
    dshRuntimeStatus.source === "managed"
      ? t("dsh.runtime.managedHint")
      : t("dsh.runtime.builtinHint");

  const handleUninstallRuntime = async () => {
    setUninstallOpen(false);
    const result = await desktopApi.sessions.uninstallDshRuntime();
    if (result.ok) showNotice(t("settings.dshRuntimeUninstalled"), 3000);
    else showNotice(result.error ?? t("settings.dshRuntimeUninstall"), 4000, "error");
  };
  const languageOptions: SelectOption[] = [
    { value: "system", label: t("settings.languageSystem") },
    { value: "zh-CN", label: t("settings.languageZh") },
    { value: "en-US", label: t("settings.languageEn") },
    { value: "pseudo", label: t("settings.languagePseudo") },
  ];
  const sendShortcutOptions: SelectOption[] = [
    { value: "enter-send", label: t("settings.sendShortcut.enter") },
    { value: "ctrl-enter-send", label: t("settings.sendShortcut.ctrl") },
    { value: "shift-enter-send", label: t("settings.sendShortcut.shift") },
  ];
  const linkOpenModeOptions: SelectOption[] = [
    { value: "external", label: t("settings.linkOpenMode.external") },
    { value: "internal", label: t("settings.linkOpenMode.internal") },
  ];
  const workspaceContentOpenModeOptions: SelectOption[] = [
    { value: "split", label: t("settings.workspaceContentOpenMode.split") },
    { value: "maximize", label: t("settings.workspaceContentOpenMode.maximize") },
  ];
  const busySendDeliveryOptions: SelectOption[] = [
    { value: "steer", label: t("settings.busySendDeliverySteer") },
    { value: "followUp", label: t("settings.busySendDeliveryFollowUp") },
  ];
  const startupWindowModeOptions: SelectOption[] = [
    { value: "last", label: t("settings.startupWindow.last") },
    { value: "maximized", label: t("settings.startupWindow.maximized") },
    { value: "normal-large", label: t("settings.startupWindow.large") },
    { value: "normal-medium", label: t("settings.startupWindow.medium") },
    { value: "normal-compact", label: t("settings.startupWindow.compact") },
    { value: "fullscreen", label: t("settings.startupWindow.fullscreen") },
  ];

  return (
    <>
      {/* 语言（单行分区：行标题即一级标题，内容行入淡色框） */}
      <SettingBox>
        <SettingRow
          level={1}
          title={
            <>
              <span>{t("settings.language")}</span>
              <DirtyMarker dirty={isDirty("language")} label={t("settings.language")} />
            </>
          }
          alignEnd={false}
        >
          <Select value={draft.language} onValueChange={(value) =>
              updateDraft({ language: value as AppSettings["language"] })
            }>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {languageOptions.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingBox>

      {/* 会话 */}
      <SettingsSection title={t("settings.sectionSession")}>
        <SettingRow
          title={
            <>
              <span>{t("settings.sessionTabOpenMode")}</span>
              <DirtyMarker dirty={isDirty("sessionTabOpenMode")} label={t("settings.sessionTabOpenMode")} />
            </>
          }
          alignEnd={false}
        >
          <Select value={draft.sessionTabOpenMode} onValueChange={(value) =>
              updateDraft({ sessionTabOpenMode: value as AppSettings["sessionTabOpenMode"] })
            }>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="preview">{t("settings.sessionTabOpenModePreview")}</SelectItem>
              <SelectItem value="permanent">{t("settings.sessionTabOpenModePermanent")}</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={
            <>
              <span>{t("settings.inputShortcut")}</span>
              <DirtyMarker dirty={isDirty("sendShortcut")} label={t("settings.inputShortcut")} />
            </>
          }
          alignEnd={false}
        >
          <Select value={draft.sendShortcut} onValueChange={(value) =>
              updateDraft({ sendShortcut: value as AppSettings["sendShortcut"] })
            }>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {sendShortcutOptions.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={
            <>
              <span>{t("settings.defaultAgentBackend")}</span>
              <DirtyMarker dirty={isDirty("defaultAgentBackend")} label={t("settings.defaultAgentBackend")} />
            </>
          }
          description={t("settings.defaultAgentBackendDesc")}
          alignEnd={false}
        >
          <Select
            value={draft.defaultAgentBackend}
            onValueChange={(value) =>
              updateDraft({ defaultAgentBackend: value as AppSettings["defaultAgentBackend"] })
            }
          >
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="pi">{t("settings.defaultAgentBackendPi")}</SelectItem>
              <SelectItem value="dsh" disabled={!dshAvailable}>
                {dshAvailable
                  ? t("settings.defaultAgentBackendDsh")
                  : t("settings.defaultAgentBackendDshUnavailable")}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        {/* DSH runtime 状态行：装了要能看到版本，也要能卸（否则用户只能手工去
            userData 里翻目录）。内置 runtime 不可卸载——它随应用分发，删了也没法
            用「安装」补回来（内置那份不会再有）。 */}
        {dshAvailable ? (
          <SettingRow
            title={<span>{t("settings.dshRuntime")}</span>}
            description={dshRuntimeDescription}
            alignEnd={false}
          >
            <div className="flex items-center justify-end gap-2">
              <span className="text-[13px] text-muted-foreground">{dshRuntimeLabel}</span>
              {dshRuntimeStatus?.source === "managed" ? (
                <Button size="sm" variant="outline" onClick={() => setUninstallOpen(true)}>
                  {t("settings.dshRuntimeUninstall")}
                </Button>
              ) : null}
            </div>
          </SettingRow>
        ) : null}
        {/* ConfirmDialog 自身恒 open（靠 AlertDialog 内部控制），必须条件渲染。 */}
        {uninstallOpen ? (
          <ConfirmDialog
            title={t("settings.dshRuntimeUninstall")}
            message={t("settings.dshRuntimeUninstallConfirm")}
            confirmLabel={t("settings.dshRuntimeUninstall")}
            danger
            onConfirm={() => void handleUninstallRuntime()}
            onCancel={() => setUninstallOpen(false)}
          />
        ) : null}
        {/* 忙碌时投递行为：Agent 回复期间发送消息的默认语义（pi/dsh 统一）。 */}
        <SettingRow
          title={
            <>
              <span>{t("settings.busySendDelivery")}</span>
              <DirtyMarker dirty={isDirty("busySendDelivery")} label={t("settings.busySendDelivery")} />
            </>
          }
          description={t("settings.busySendDeliveryDesc")}
          alignEnd={false}
        >
          <Select
            value={draft.busySendDelivery}
            onValueChange={(value) =>
              updateDraft({ busySendDelivery: value as AppSettings["busySendDelivery"] })
            }
          >
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {busySendDeliveryOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={
            <>
              <span>{t("settings.linkOpenMode")}</span>
              <DirtyMarker dirty={isDirty("linkOpenMode")} label={t("settings.linkOpenMode")} />
            </>
          }
          alignEnd={false}
        >
          <Select value={draft.linkOpenMode} onValueChange={(value) =>
              updateDraft({ linkOpenMode: value as AppSettings["linkOpenMode"] })
            }>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {linkOpenModeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title={
            <>
              <span>{t("settings.workspaceContentOpenMode")}</span>
              <DirtyMarker dirty={isDirty("workspaceContentOpenMode")} label={t("settings.workspaceContentOpenMode")} />
            </>
          }
          description={t("settings.workspaceContentOpenModeDesc")}
          alignEnd={false}
        >
          <Select
            value={draft.workspaceContentOpenMode ?? "split"}
            onValueChange={(value) =>
              updateDraft({
                workspaceContentOpenMode: value as AppSettings["workspaceContentOpenMode"],
              })
            }
          >
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {workspaceContentOpenModeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        {/* 流式对话设置：中间过程与本轮修改文件的默认展示行为。 */}
        <SettingSwitchRow
          title={t("settings.expandInterimDuringStream")}
          description={t("settings.expandInterimDuringStreamDesc")}
          checked={draft.expandInterimDuringStream}
          onChange={(checked) => updateDraft({ expandInterimDuringStream: checked })}
        />
        <SettingSwitchRow
          title={t("settings.collapsePrevRunsOnNewTurn")}
          description={t("settings.collapsePrevRunsOnNewTurnDesc")}
          checked={draft.collapsePrevRunsOnNewTurn}
          onChange={(checked) => updateDraft({ collapsePrevRunsOnNewTurn: checked })}
        />
      </SettingsSection>

      {/* 通知 */}
      <SettingsSection title={t("settings.notificationSection")}>
        <SettingSwitchRow
          title={t("settings.enableNotifications")}
          checked={draft.enableNotifications}
          onChange={(checked) =>
            updateDraft({ enableNotifications: checked })
          }
        />
        <SettingSwitchRow
          title={t("settings.askNotification")}
          description={t("settings.askNotificationDesc")}
          checked={draft.askNotificationEnabled}
          onChange={(checked) =>
            updateDraft({ askNotificationEnabled: checked })
          }
        />
        <SettingSwitchRow
          title={t("settings.agentCountReminder")}
          description={t("settings.agentCountReminderDesc")}
          checked={draft.agentCountReminderEnabled}
          onChange={(checked) =>
            updateDraft({ agentCountReminderEnabled: checked })
          }
        />
      </SettingsSection>

      {/* 窗口 */}
      <SettingsSection title={t("settings.sectionWindow")}>
        <SettingRow
          title={
            <>
              <span>{t("settings.startupWindowMode")}</span>
              <DirtyMarker
                dirty={isDirty("startupWindowMode")}
                label={t("settings.startupWindowMode")}
              />
            </>
          }
          description={t("settings.startupWindowModeDesc")}
          alignEnd={false}
        >
          <Select value={draft.startupWindowMode} onValueChange={(value) =>
              updateDraft({
                startupWindowMode: value as AppSettings["startupWindowMode"],
              })
            }>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {startupWindowModeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingSwitchRow
          title={t("settings.closeToTray")}
          checked={draft.closeToTray}
          onChange={(checked) =>
            updateDraft({ closeToTray: checked })
          }
        />
        <SettingSwitchRow
          title={t("settings.singleInstance")}
          description={t("settings.singleInstanceDesc")}
          checked={draft.singleInstance}
          onChange={(checked) =>
            updateDraft({ singleInstance: checked })
          }
        />
      </SettingsSection>
    </>
  );
});
