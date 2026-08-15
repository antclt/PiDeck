/**
 * Agent preset 显示文案解析（纯函数，可单测）。
 *
 * 对齐 dsh-web 的 presetDisplayText：4 个随附预设（standard/code/minimal/cordis）
 * 在 system trust 时使用 i18n 文案（zh/en 各一套，避免文件元数据的中文名漏到英文界面）；
 * 其余（user 或未知 system）回退文件元数据（preset.yml 的 name/description）。
 */
import type { TranslationKey } from "../i18n";

/** 名单行的身份字段（agentPreset.list 返回子集）。 */
export type DshAgentPresetIdentity = {
	id: string;
	trust: "system" | "user";
	name?: string;
	description?: string;
};

/** 4 个随附预设 → i18n key 映射（与 dsh-web 的 BUILT_IN_PRESET_KEYS 同源）。 */
const BUILTIN_PRESET_KEYS: Record<string, { name: TranslationKey; description: TranslationKey }> = {
	standard: { name: "config.dsh.presetStandardName", description: "config.dsh.presetStandardDesc" },
	code: { name: "config.dsh.presetCodeName", description: "config.dsh.presetCodeDesc" },
	minimal: { name: "config.dsh.presetMinimalName", description: "config.dsh.presetMinimalDesc" },
	cordis: { name: "config.dsh.presetCordisName", description: "config.dsh.presetCordisDesc" },
};

/**
 * 内置预设的 i18n key：仅 system trust 且 id 属于随附 4 个时返回；
 * user 同名预设或未知 id 一律回退文件元数据（防本地预设冒用内置显示名）。
 */
export function builtinPresetKeys(
	preset: DshAgentPresetIdentity,
): { name: TranslationKey; description: TranslationKey } | undefined {
	return preset.trust === "system" ? BUILTIN_PRESET_KEYS[preset.id] : undefined;
}

/** 预设显示名：内置 system 预设走 i18n，其余用元数据 name，缺省回退 id。 */
export function presetDisplayName(preset: DshAgentPresetIdentity, t: (key: TranslationKey) => string): string {
	const keys = builtinPresetKeys(preset);
	return keys ? t(keys.name) : (preset.name ?? preset.id);
}

/** 预设显示描述：内置 system 预设走 i18n，其余用元数据 description（可缺省）。 */
export function presetDisplayDescription(
	preset: DshAgentPresetIdentity,
	t: (key: TranslationKey) => string,
): string | undefined {
	const keys = builtinPresetKeys(preset);
	return keys ? t(keys.description) : preset.description;
}
