import { memo, useEffect, useMemo, useState } from "react";
import type { AppSettings, AvailableModel } from "../../../../../shared/types";
import { Search } from "lucide-react";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Checkbox } from "../../ui-shadcn/checkbox";
import { Input } from "../../ui-shadcn/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../ui-shadcn/table";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingRow, SettingSwitchRow } from "./SettingRows";
import { desktopApi } from "../../../desktopApi";

/** 代理相关字段：用于判断代理 tab 是否有未保存变更。 */
const PROXY_FIELDS: (keyof AppSettings)[] = [
  "piProxyEnabled",
  "piProxyUrl",
  "piProxyBypass",
  "piProxyModels",
  "desktopProxyEnabled",
  "desktopProxyUrl",
  "desktopProxyBypass",
];

type ProxyTabProps = {
  draft: AppSettings;
  updateDraft: (patch: Partial<AppSettings>) => void;
  isDirty: (field: keyof AppSettings) => boolean;
  piProxyChecking: boolean;
  piProxyNotice: string;
  piProxyNoticeTone: "info" | "success" | "error";
  onTestPiProxy: () => void;
};

/**
 * 设置弹框「代理设置」tab：pi / 桌面代理两段（未保存变更提示 + 统一保存/取消）。
 * 独立组件 + memo：切换 tab 或壳层无关状态变化时不重渲染本 tab。
 * 「按模型走代理」用模型表格（与 Pi 管理 → 模型 同款 Table 展示），搜索按 provider/ID/名称过滤。
 */
export const ProxyTab = memo(function ProxyTab(props: ProxyTabProps) {
  const { draft, updateDraft, isDirty } = props;
  // 代理 tab 仍展示未保存提示；实际保存/取消统一走全局草稿，避免旧 proxyDirty 局部状态残留。
  const proxyDirty = PROXY_FIELDS.some((field) => isDirty(field));
  // 模型白名单候选：从 models.json 拉全量（与会话模型选择器同一数据源），保留 AvailableModel 结构，
  // 搜索可同时命中 provider/modelId 与显示名。
  const [availableModelList, setAvailableModelList] = useState<AvailableModel[] | null>(null);
  const [modelSearch, setModelSearch] = useState("");
  const [proxyListLoading, setProxyListLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setProxyListLoading(true);
    void desktopApi.projects.listModels(undefined).then((models) => {
      if (cancelled) return;
      // 无 provider 的模型无法参与 provider/modelId 匹配（策略层直接跳过），不进名单候选。
      setAvailableModelList(models.filter((m) => m.provider && m.id));
    }).catch(() => {
      if (!cancelled) setAvailableModelList([]);
    }).finally(() => {
      if (!cancelled) setProxyListLoading(false);
    });
    return () => { cancelled = true; };
  }, []);
  const selectedModels = useMemo(() => new Set(draft.piProxyModels ?? []), [draft.piProxyModels]);
  const availableModelKeys = useMemo(
    () => new Set((availableModelList ?? []).map((m) => `${m.provider}/${m.id}`)),
    [availableModelList],
  );
  // 已选但不在当前 models.json 的条目（可能已删模型/改名），单独小节展示可取消，防止坏值残留不可见。
  const extraModelKeys = useMemo(
    () => [...selectedModels].filter((key) => !availableModelKeys.has(key)).sort((a, b) => a.localeCompare(b)),
    [selectedModels, availableModelKeys],
  );
  const hasModelFilter = (draft.piProxyModels?.length ?? 0) > 0;
  // 搜索：本地即时过滤（provider/modelId 与显示名均可命中），仅影响显示，不影响已保存名单。
  const modelSearchQuery = modelSearch.trim().toLowerCase();
  const visibleModels = useMemo(() => {
    const list = availableModelList ?? [];
    if (!modelSearchQuery) return list;
    return list.filter((m) => {
      const key = `${m.provider}/${m.id}`;
      return key.toLowerCase().includes(modelSearchQuery) || (m.name ?? "").toLowerCase().includes(modelSearchQuery);
    });
  }, [availableModelList, modelSearchQuery]);
  // 勾选/取消：provider/modelId 为原子条目，与策略层 resolveModelProxyMode 的匹配格式一致。
  const toggleModelKey = (key: string, checked: boolean) => {
    const nextSet = new Set(selectedModels);
    if (checked) nextSet.add(key);
    else nextSet.delete(key);
    updateDraft({ piProxyModels: [...nextSet] });
  };
  /** extras 的紧凑勾选行（无供应商/名称列，整串 key 展示）。 */
  const renderExtraRow = (key: string) => {
    const checked = selectedModels.has(key);
    return (
      <label key={key} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-control hover:bg-muted/40">
        <Checkbox
          checked={checked}
          onCheckedChange={(next) => toggleModelKey(key, next === true)}
        />
        <span className="min-w-0 truncate font-mono text-caption" title={key}>{key}</span>
      </label>
    );
  };

  return (
    <>
      {/* 未保存更改的提示横幅 */}
      {proxyDirty && (
        <div className="setting-proxy-unsaved-bar">
          <span className="setting-proxy-unsaved-dot" />
          <span>{t("settings.proxyUnsaved")}</span>
          <small>{t("settings.proxyApplyHint")}</small>
        </div>
      )}
      <SettingsSection
        title={t("settings.piProxy")}
        description={t("settings.piProxyDesc")}
      >
        <SettingSwitchRow
          title={t("settings.enablePiProxy")}
          description={t("settings.enablePiProxyDesc")}
          checked={draft.piProxyEnabled}
          onChange={(checked) =>
            updateDraft({ piProxyEnabled: checked })
          }
        />
        {/* 配置与开关解耦：地址/绕过/测试始终可编辑，关闭开关时仅保存配置不启用——
            单会话「会话代理」的 on 模式会复用下方地址，无需全局开启。 */}
        <div className="setting-proxy-panel">
          <SettingRow
            title={<span>{t("settings.proxyUrl")}</span>}
            stacked
          >
            <Input type="text" value={draft.piProxyUrl} placeholder={"http://127.0.0.1:7890"} onChange={(event) => updateDraft({ piProxyUrl: event.target.value })} />
          </SettingRow>
          <SettingRow
            title={<span>{t("settings.proxyBypass")}</span>}
            description={t("settings.noProxyHint")}
            stacked
          >
            <Input type="text" value={draft.piProxyBypass} placeholder={"localhost,127.0.0.1,::1"} onChange={(event) => updateDraft({ piProxyBypass: event.target.value })} />
          </SettingRow>
          <SettingRow
            title={<span>{t("settings.proxyTest")}</span>}
            description={
              <>
                {t("settings.proxyNoApiKey")}
                {props.piProxyNotice && (
                  <span className={`setting-status ${props.piProxyNoticeTone}`}>
                    {props.piProxyNotice}
                  </span>
                )}
              </>
            }
          >
            <Button variant="secondary"
              onClick={props.onTestPiProxy}
              disabled={props.piProxyChecking}
            >
              {props.piProxyChecking
                ? t("settings.testingProxy")
                : t("settings.testProxy")}
            </Button>
          </SettingRow>
          {/* 按模型走代理：名单内模型强制走代理（即使全局关闭也复用上方地址），名单外强制直连；
              留空则跟随全局/会话设置。模型表格与 Pi 管理 → 模型 同款展示，搜索按任意列过滤。 */}
          <SettingRow
            title={<span>{t("settings.piProxyModels")}</span>}
            description={t("settings.piProxyModelsDesc")}
            stacked
          >
            <div className="flex flex-col gap-2.5">
              {/* 顶部操作行：搜索 + 已选计数 + 清空（结构对齐 Pi 管理模型列表头部） */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1 basis-52">
                  <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/70" aria-hidden="true" />
                  <Input
                    type="text"
                    value={modelSearch}
                    onChange={(event) => setModelSearch(event.target.value)}
                    placeholder={t("settings.piProxyModelsSearch")}
                    className="h-8 pl-8 text-control"
                    disabled={proxyListLoading}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-micro text-muted-foreground/80">
                  {hasModelFilter ? (
                    <span>{t("settings.piProxyModelsSelected", { count: selectedModels.size })}</span>
                  ) : (
                    <span>{t("settings.piProxyModelsAllFollow")}</span>
                  )}
                  {hasModelFilter && (
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-micro" onClick={() => updateDraft({ piProxyModels: [] })}>{t("settings.piProxyModelsClear")}</Button>
                  )}
                </div>
              </div>
              {/* 已选但不在当前列表的模型（可能已删/改名）：独立小节防止坏值残留不可见 */}
              {extraModelKeys.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="px-0.5 text-micro font-medium text-muted-foreground">{t("settings.piProxyModelsExtras")}</span>
                  <div className="flex flex-col gap-1 rounded-md border border-amber-500/25 bg-amber-500/5 p-2">
                    {extraModelKeys.map(renderExtraRow)}
                  </div>
                </div>
              )}
              {proxyListLoading ? (
                <span className="text-micro text-muted-foreground">{t("settings.piProxyModelsLoading")}</span>
              ) : visibleModels.length === 0 ? (
                <span className="text-micro text-muted-foreground">{t("settings.piProxyModelsEmpty")}</span>
              ) : (
                <div className="max-h-80 overflow-auto rounded-lg border border-border/60 bg-popover/40">
                  <Table>
                    <TableHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur">
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="w-10" />
                        <TableHead className="min-w-0">{t("config.modelId")}</TableHead>
                        <TableHead className="w-36 max-w-36">{t("settings.proxyProvider")}</TableHead>
                        <TableHead className="w-48 max-w-48">{t("config.modelDisplayName")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleModels.map((m) => {
                        const key = `${m.provider}/${m.id}`;
                        const checked = selectedModels.has(key);
                        return (
                          // 整行可点击切换；勾选列拦截冒泡避免 checkbox 触发两次（onChange + row onClick）。
                          <TableRow
                            key={key}
                            className="cursor-pointer"
                            onClick={() => toggleModelKey(key, !checked)}
                          >
                            <TableCell className="w-10 p-2 pl-3" onClick={(event) => event.stopPropagation()}>
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(next) => toggleModelKey(key, next === true)}
                                aria-label={key}
                              />
                            </TableCell>
                            <TableCell className="p-2 font-mono text-caption text-foreground" title={key}>{m.id}</TableCell>
                            <TableCell className="max-w-36 p-2 font-mono text-caption text-muted-foreground">
                              <span className="block truncate">{m.provider}</span>
                            </TableCell>
                            <TableCell className="min-w-0 max-w-48 p-2 text-caption text-muted-foreground">
                              <span className="block truncate" title={m.name}>{m.name ?? ""}</span>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
              {modelSearchQuery && visibleModels.length > 0 && (
                <span className="text-micro text-muted-foreground/70">{t("settings.piProxyModelsSearchHint")}</span>
              )}
              <span className="text-micro text-muted-foreground/70">{t("settings.piProxyModelsHint")}</span>
            </div>
          </SettingRow>
        </div>
      </SettingsSection>
      <SettingsSection
        title={t("settings.desktopProxy")}
        description={t("settings.desktopProxyDesc")}
      >
        <SettingSwitchRow
          title={t("settings.enableDesktopProxy")}
          description={t("settings.desktopProxyDesc")}
          checked={draft.desktopProxyEnabled}
          onChange={(checked) =>
            updateDraft({ desktopProxyEnabled: checked })
          }
        />
        {draft.desktopProxyEnabled && (
          <div className="setting-proxy-panel">
            <SettingRow
              title={<span>{t("settings.proxyUrl")}</span>}
              stacked
            >
              <Input type="text" value={draft.desktopProxyUrl} placeholder={"http://127.0.0.1:7890"} onChange={(event) => updateDraft({ desktopProxyUrl: event.target.value })} />
            </SettingRow>
            <SettingRow
              title={<span>{t("settings.proxyBypass")}</span>}
              description={t("settings.electronProxyHint")}
              stacked
            >
              <Input type="text" value={draft.desktopProxyBypass} placeholder={"localhost,127.0.0.1,::1"} onChange={(event) => updateDraft({ desktopProxyBypass: event.target.value })} />
            </SettingRow>
          </div>
        )}
      </SettingsSection>
      {/* 代理变更走全局草稿：顶部统一保存/取消，不再在 tab 底部重复放按钮 */}
    </>
  );
});