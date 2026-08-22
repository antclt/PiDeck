import { memo, useEffect, useMemo, useState } from "react";
import type { AppSettings } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Checkbox } from "../../ui-shadcn/checkbox";
import { Input } from "../../ui-shadcn/input";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingRow, SettingSwitchRow } from "./SettingRows";
import { desktopApi } from "../../../desktopApi";

/** 代理相关字段：用于判断代理 tab 是否有未保存变更。 */
const PROXY_FIELDS: (keyof AppSettings)[] = [
  "piProxyEnabled",
  "piProxyUrl",
  "piProxyBypass",
  "piProxyProviders",
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
 */
export const ProxyTab = memo(function ProxyTab(props: ProxyTabProps) {
  const { draft, updateDraft, isDirty } = props;
  // 代理 tab 仍展示未保存提示；实际保存/取消统一走全局草稿，避免旧 proxyDirty 局部状态残留。
  const proxyDirty = PROXY_FIELDS.some((field) => isDirty(field));
  // 按供应商过滤：从 models.json 拉全量模型以展示可选供应商（与会话创建时的 provider 集合一致）。
  const [availableProviders, setAvailableProviders] = useState<string[] | null>(null);
  const [providersLoading, setProvidersLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setProvidersLoading(true);
    void desktopApi.projects.listModels(undefined).then((models) => {
      if (cancelled) return;
      const providers = [...new Set(models.map((m) => m.provider).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      setAvailableProviders(providers);
    }).catch(() => {
      if (!cancelled) setAvailableProviders([]);
    }).finally(() => {
      if (!cancelled) setProvidersLoading(false);
    });
    return () => { cancelled = true; };
  }, []);
  const selectedProviders = useMemo(() => new Set(draft.piProxyProviders ?? []), [draft.piProxyProviders]);
  // 已选但不在当前 models.json 中的供应商（可能已删模型/改名），仍需展示可取消。
  const allDisplayProviders = useMemo(() => {
    const base = availableProviders ?? [];
    const extras = (draft.piProxyProviders ?? []).filter((p) => !base.includes(p));
    return [...base, ...extras].sort((a, b) => a.localeCompare(b));
  }, [availableProviders, draft.piProxyProviders]);
  const hasProviderFilter = (draft.piProxyProviders?.length ?? 0) > 0;

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
          {/* 按供应商走代理：名单非空时仅名单内供应商强制走代理（即使全局关闭也复用下方地址），名单外强制直连。
              留空=不按供应商过滤（沿用全局开关/会话代理），解决“新建会话首条请求无代理”痛点。 */}
          <SettingRow
            title={<span>{t("settings.piProxyProviders")}</span>}
            description={t("settings.piProxyProvidersDesc")}
            stacked
          >
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-wrap items-center gap-2 text-micro text-muted-foreground/80">
                {hasProviderFilter ? (
                  <span>{t("settings.piProxyProvidersSelected", { count: selectedProviders.size })}</span>
                ) : (
                  <span>{t("settings.piProxyProvidersAllFollow")}</span>
                )}
                {hasProviderFilter && (
                  <Button variant="ghost" size="sm" className="h-6 px-2 text-micro" onClick={() => updateDraft({ piProxyProviders: [] })}>{t("settings.piProxyProvidersClear")}</Button>
                )}
              </div>
              {providersLoading ? (
                <span className="text-micro text-muted-foreground">{t("settings.piProxyProvidersLoading")}</span>
              ) : allDisplayProviders.length === 0 ? (
                <span className="text-micro text-muted-foreground">{t("settings.piProxyProvidersEmpty")}</span>
              ) : (
                <div className="grid max-h-48 grid-cols-2 gap-2 overflow-auto rounded-md border border-border/60 bg-muted/20 p-2.5 sm:grid-cols-3">
                  {allDisplayProviders.map((provider) => {
                    const checked = selectedProviders.has(provider);
                    return (
                      <label key={provider} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-control hover:bg-muted/60">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) => {
                            const nextSet = new Set(selectedProviders);
                            if (next === true) nextSet.add(provider);
                            else nextSet.delete(provider);
                            updateDraft({ piProxyProviders: [...nextSet] });
                          }}
                        />
                        <span className="min-w-0 truncate font-mono text-caption">{provider}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              <span className="text-micro text-muted-foreground/70">{t("settings.piProxyProvidersHint")}</span>
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
