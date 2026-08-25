import { Brain, Eye, Gauge, ImageIcon, RotateCcw, Scale } from "lucide-react";
import type { ModelSpec } from "../../../shared/types/modelSpecs";
import type { ModelItem } from "./configTypes";
import { Button } from "../components/ui-shadcn/button";
import { t } from "../i18n";

function formatTokens(value: number | undefined): string {
  if (value === undefined) return "-";
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}K`;
  return value.toLocaleString();
}

/**
 * 能力卡展示的是模型行当前有效配置（contextWindow / maxTokens / input / reasoning /
 * thinkingLevelMap），不是旧模板快照——用户手改任意字段后卡片立即反映新值。
 * template 只说明匹配到的标准模型与来源，并提供「重置为自适应」的模板输入。
 */
export function ModelCapabilityCard(props: {
  model: ModelItem;
  template: ModelSpec | null;
  onReset: () => void;
  resetting?: boolean;
}) {
  const { model, template } = props;
  const mappedLevels = Object.entries(model.thinkingLevelMap ?? {})
    .filter(([, wireValue]) => wireValue !== null)
    .map(([level]) => level);
  const source = t("config.modelCapabilitySourceCatalog");
  const match = template?.matchKind === "name-alias"
    ? t("config.modelCapabilityMatchAlias")
    : t("config.modelCapabilityMatchExact");
  const capabilityRows = [
    { icon: Gauge, label: t("config.contextWindow"), value: formatTokens(model.contextWindow) },
    { icon: Scale, label: t("config.maxTokens"), value: formatTokens(model.maxTokens) },
    {
      icon: ImageIcon,
      label: t("config.inputTypeImage"),
      value: model.input
        ? model.input.includes("image")
          ? t("config.modelCapabilitySupported")
          : t("config.modelCapabilityUnsupported")
        : t("config.modelCapabilityUnknown"),
    },
    {
      icon: Brain,
      label: t("config.reasoning"),
      value: model.reasoning === undefined
        ? t("config.modelCapabilityUnknown")
        : model.reasoning
          ? t("config.modelCapabilitySupported")
          : t("config.modelCapabilityUnsupported"),
    },
    {
      icon: Eye,
      label: t("config.modelCapabilityMappedLevels"),
      value: mappedLevels.length > 0 ? mappedLevels.join(", ") : "-",
    },
  ];

  return (
    <div className="grid gap-2 rounded-md border border-border-subtle bg-bg-subtle px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-control font-medium text-text-primary">{t("config.modelCapabilityTitle")}</span>
          {template ? (
            <>
              <span className="rounded-sm bg-bg-hover px-1.5 py-0.5 text-micro text-text-secondary">{source}</span>
              <span className="rounded-sm bg-bg-hover px-1.5 py-0.5 text-micro text-text-secondary">{match}</span>
            </>
          ) : (
            <span className="rounded-sm bg-bg-hover px-1.5 py-0.5 text-micro text-text-secondary">
              {t("config.modelCapabilityNotMatched")}
            </span>
          )}
        </div>
        <p className="mt-1 truncate font-mono text-caption text-text-secondary" title={template?.matchedId}>
          {template?.matchedId
            ? t("config.modelCapabilityMatched", { model: template.matchedId })
            : t("config.modelCapabilityNoTemplate")}
        </p>
      </div>
      <div className="flex items-start justify-end sm:items-center">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1"
          onClick={props.onReset}
          disabled={props.resetting}
          title={t("config.modelResetAdaptive")}
        >
          <RotateCcw size={13} className={props.resetting ? "animate-spin" : undefined} aria-hidden="true" />
          {props.resetting ? t("config.modelResetting") : t("config.modelResetAdaptive")}
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-caption text-text-secondary sm:col-span-2 sm:grid-cols-3">
        {capabilityRows.map(({ icon: Icon, label, value }) => (
          <div key={label} className="flex min-w-0 items-center gap-1.5" title={`${label}: ${value}`}>
            <Icon className="size-3 shrink-0 text-text-tertiary" aria-hidden="true" />
            <span className="shrink-0 text-text-tertiary">{label}</span>
            <span className="min-w-0 truncate font-mono text-text-secondary">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
