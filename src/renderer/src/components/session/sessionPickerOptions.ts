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
