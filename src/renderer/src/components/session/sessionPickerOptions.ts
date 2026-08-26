import type { AvailableModel } from "../../../../shared/types";
import type { TranslationKey } from "../../i18n";

/** Shared thinking options used by both the composer picker and the first-session setup. */
export const THINKING_LEVELS = [
  { value: "off", labelKey: "thinking.levelLabel.off", descriptionKey: "thinking.level.off" },
  { value: "minimal", labelKey: "thinking.levelLabel.minimal", descriptionKey: "thinking.level.minimal" },
  { value: "low", labelKey: "thinking.levelLabel.low", descriptionKey: "thinking.level.low" },
  { value: "medium", labelKey: "thinking.levelLabel.medium", descriptionKey: "thinking.level.medium" },
  { value: "high", labelKey: "thinking.levelLabel.high", descriptionKey: "thinking.level.high" },
  { value: "xhigh", labelKey: "thinking.levelLabel.xhigh", descriptionKey: "thinking.level.xhigh" },
  { value: "max", labelKey: "thinking.levelLabel.max", descriptionKey: "thinking.level.max" },
] satisfies Array<{ value: string; labelKey: TranslationKey; descriptionKey: TranslationKey }>;

export type ThinkingPickerLevel = {
  value: string;
  labelKey?: TranslationKey;
  descriptionKey?: TranslationKey;
  label?: string;
  description?: string;
};

/** Map Pi/DSH wire level ids to localized options without dropping future ids. */
export function toThinkingPickerLevels(levels: readonly string[]): ThinkingPickerLevel[] {
  const seen = new Set<string>();
  const options: ThinkingPickerLevel[] = [];
  for (const value of levels) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const known = THINKING_LEVELS.find((level) => level.value === normalized);
    if (known) {
      options.push({
        value: known.value,
        labelKey: known.labelKey,
        descriptionKey: known.descriptionKey,
      });
    } else {
      options.push({ value: normalized, label: normalized });
    }
  }
  return options;
}

/** Keep provider grouping deterministic so the same model order appears in both pickers. */
export function groupModelsByProvider(models: AvailableModel[]) {
  const groups = models.reduce<Record<string, AvailableModel[]>>((result, model) => {
    const provider = model.provider || "other";
    (result[provider] ??= []).push(model);
    return result;
  }, {});

  for (const providerModels of Object.values(groups)) {
    providerModels.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  }
  return groups;
}

/**
 * 模型选择器初始展开规则（「当前选中模型可见」驱动）：打开时只保证当前模型所在分组可见，
 * 其余提供商分组全部折叠。
 *
 * 1) 当前模型在收藏栏 → 仅展开收藏栏；
 * 2) 当前模型在某个提供商分组 → 展开收藏栏 + 该提供商分组（面板据此滚动定位到选中项）；
 * 3) 收藏为 0 → 展开当前模型所在提供商；无当前模型/当前提供商不在列表时，展开第一个提供商兜底，避免空列表。
 *
 * 返回需要初始展开的分组 id：收藏栏固定为 "favorites"，提供商分组为 "provider:<provider>"。
 */
export function computeModelPickerDefaultExpanded(params: {
  /** 已按收藏栏展示顺序排列的收藏模型（仅目录内存在的） */
  favorites: Array<{ provider: string; id: string }>;
  /** 当前选中模型（无选中时省略，如欢迎页草稿期） */
  current?: { provider?: string; modelId?: string };
  /** 排序后的提供商 key 列表（与选择器分组顺序一致） */
  providers: string[];
}): string[] {
  const { favorites, current, providers } = params;
  const expanded: string[] = [];
  if (favorites.length > 0) expanded.push("favorites");

  const currentProvider = current?.provider?.trim();
  const currentModelId = current?.modelId?.trim();
  const currentKey = currentProvider && currentModelId
    ? `${currentProvider}/${currentModelId}`
    : undefined;
  const currentInFavorites = currentKey
    ? favorites.some((model) => `${model.provider}/${model.id}` === currentKey)
    : false;
  // 当前模型不在收藏栏：展开其所在提供商分组，保证打开时能看到选中项（面板会滚动定位）。
  if (currentKey && !currentInFavorites && currentProvider && providers.includes(currentProvider)) {
    expanded.push(`provider:${currentProvider}`);
  }
  // 兜底：无任何可见分组时（收藏为 0 且无当前模型 / 当前提供商不在列表），
  // 展开第一个提供商，避免打开即空列表。
  if (expanded.length === 0 && providers[0]) {
    expanded.push(`provider:${providers[0]}`);
  }
  return expanded;
}
