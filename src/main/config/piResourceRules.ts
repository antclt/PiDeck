/**
 * pi 原生资源配置规则的纯函数层（计划 A2）。
 *
 * 语义（pi 0.99.2 `package-manager.js` / `settings.md`）：
 * - `extensions/skills/prompts/themes` 数组支持：`!pattern` 排除、`+path` 精确包含、
 *   `-path` 精确排除；生效顺序是 排除 → 精确包含 → 精确排除（不是「最后一条赢」）。
 * - 精确等于目标路径的规则由本模块生成；用户手写的 glob/其它路径一律不动。
 * - `builtin:<name>`（扩展）用同一套 `+`/`-` 语法。
 *
 * 这里只做「怎么改数组」的纯计算，不读写文件、不解析真实资源来源——
 * 那是 PiResourceConfigService 的职责。
 */

import type { PiBuiltinExtension, PiResourceKind } from "../../shared/types/piResources";
import { builtinSpecifier } from "../../shared/types/piResources";

/** 归一化用于比较；大小写与分隔符差异在 Windows 上不构成不同资源。 */
export function normalizeResourceValue(value: string, platform: NodeJS.Platform = process.platform): string {
	const trimmed = value.trim();
	const unified = trimmed.replace(/\\/g, "/");
	return platform === "win32" ? unified.toLowerCase() : unified;
}

function isExactMatch(entry: string, value: string, platform: NodeJS.Platform): boolean {
	if (entry.startsWith("+") || entry.startsWith("-")) {
		return normalizeResourceValue(entry.slice(1), platform) === normalizeResourceValue(value, platform);
	}
	return normalizeResourceValue(entry, platform) === normalizeResourceValue(value, platform);
}

/** 数组里是否已有「精确等于该值」的条目（不含更宽的 glob）。 */
export function hasExactResourceEntry(entries: readonly string[], value: string, platform: NodeJS.Platform = process.platform): boolean {
	return entries.some((entry) => isExactMatch(entry, value, platform));
}

/**
 * 去掉所有精确指向该值的 `+value`/`-value` 过滤规则。
 * **显式路径条目（plain）一律保留**：它是来源声明而不是过滤规则，删掉资源就从发现集合消失，
 * 「停用再启用」永远回不来（见计划 4.1）。
 */
export function stripExactResourceRules(entries: readonly string[], value: string, platform: NodeJS.Platform = process.platform): string[] {
	return entries.filter((entry) => {
		if (!entry.startsWith("+") && !entry.startsWith("-")) return true;
		return !isExactMatch(entry, value, platform);
	});
}

/**
 * 把一条资源置为启用/停用。
 *
 * - 启用：移除精确负项，再按需补一个精确 `+value`（覆盖用户更宽的 `!glob`）。
 * - 停用：移除精确正项，写精确 `-value`。
 * - 不删除显式路径条目（`plain`）：显式来源被删掉后，`-` 也匹配不到，资源会直接消失；
 *   「停用再启用」必须能回到原状（见计划 4.1）。
 */
export function setResourceRuleEnabled(options: { entries: readonly string[]; value: string; enabled: boolean; platform?: NodeJS.Platform }): string[] {
	const { entries, value, enabled } = options;
	const cleaned = stripExactResourceRules(entries, value, options.platform ?? process.platform);
	// 显式路径（plain）一律保留：删了后就再也匹配不到，停用-启用无法往返。
	return enabled ? [...cleaned, `+${value}`] : [...cleaned, `-${value}`];
}

/** 切换已启用资源时删除仅用于覆盖的 `+` 条目，同时保留用户显式路径。 */
export function restoreResourceRuleEntries(options: { entries: readonly string[]; value: string; before?: readonly string[]; platform?: NodeJS.Platform }): string[] {
	const platform = options.platform ?? process.platform;
	return stripExactResourceRules(options.entries, options.value, platform);
}

/**
 * 从原始条目 + 生效判定计算某条资源的有效状态。
 * `resolved` 是上游（pi 语义模拟）给出的「该值是否被加载」，未知时调用方传 undefined → unavailable。
 */
export function effectiveResourceState(resolved: boolean | undefined): "enabled" | "disabled" | "unavailable" {
	if (resolved === undefined) return "unavailable";
	return resolved ? "enabled" : "disabled";
}

// ── 包整体启停 ──────────────────────────────────────────────

/** 一组包过滤快照：四类资源各自的原始值（字符串 source 时是 undefined = 沿用包声明）。 */
export type PackageFilterSnapshot = Partial<Record<PiResourceKind, string[]>>;

export type PackageEntryShape = {
	source?: string;
	[filter: string]: unknown;
};

/**
 * 生成整包停用后的包条目：只覆盖四类过滤为 `[]`，保留 source 与其它未知字段。
 * （`[]` 表示「不加载该类」，与 pi 的普通包语义一致。）
 */
export function disablePackageFilters<T extends PackageEntryShape>(entry: T): T & PackageFilterSnapshot {
	return { ...entry, extensions: [], skills: [], prompts: [], themes: [] };
}

/** 该条目是否等于「被本模块整包停用」的形状（用于幂等判断）。 */
export function isPackageFullyDisabled(entry: PackageEntryShape): boolean {
	return (["extensions", "skills", "prompts", "themes"] as PiResourceKind[]).every((kind) => Array.isArray(entry[kind]) && (entry[kind] as unknown[]).length === 0);
}

/**
 * 项目层 delta（`autoload:false`）的整包停用/强制启用过滤。
 * - 停用：`["!*", "!.*"]`（排除所有文件，含隐藏文件与隐藏目录下的文件）
 * - 强制启用：`["*", ".*"]`
 * 不能写成四个空数组：delta 里的 `[]` 是「没有覆盖」，不是「全部禁用」。
 */
export const PACKAGE_DELTA_DISABLE_PATTERNS: readonly string[] = ["!*", "!.*"];
export const PACKAGE_DELTA_ENABLE_PATTERNS: readonly string[] = ["*", ".*"];

export function disablePackageDeltaFilters<T extends PackageEntryShape>(entry: T): T & PackageFilterSnapshot {
	return {
		...entry,
		extensions: [...PACKAGE_DELTA_DISABLE_PATTERNS],
		skills: [...PACKAGE_DELTA_DISABLE_PATTERNS],
		prompts: [...PACKAGE_DELTA_DISABLE_PATTERNS],
		themes: [...PACKAGE_DELTA_DISABLE_PATTERNS],
	};
}

export function enablePackageDeltaFilters<T extends PackageEntryShape>(entry: T): T & PackageFilterSnapshot {
	return {
		...entry,
		extensions: [...PACKAGE_DELTA_ENABLE_PATTERNS],
		skills: [...PACKAGE_DELTA_ENABLE_PATTERNS],
		prompts: [...PACKAGE_DELTA_ENABLE_PATTERNS],
		themes: [...PACKAGE_DELTA_ENABLE_PATTERNS],
	};
}

/** 该条目是否等于「被本模块整包停用」的 delta 形状。 */
export function isPackageDeltaFullyDisabled(entry: PackageEntryShape): boolean {
	return (["extensions", "skills", "prompts", "themes"] as PiResourceKind[]).every((kind) => {
		const value = entry[kind];
		return Array.isArray(value) && value.length === PACKAGE_DELTA_DISABLE_PATTERNS.length && PACKAGE_DELTA_DISABLE_PATTERNS.every((pattern, index) => value[index] === pattern);
	});
}

// ── 原生内置扩展 ────────────────────────────────────────────

/**
 * 切换某个原生内置扩展在本层的状态。
 * 与原生的关系：`-builtin:mcp` 停用；启用时删除精确负项并补 `+builtin:mcp`
 * （覆盖用户更宽的 `!builtin:*`）。
 */
export function setBuiltinExtensionEnabled(options: { entries: readonly string[]; name: PiBuiltinExtension; enabled: boolean }): string[] {
	const specifier = builtinSpecifier(options.name);
	const cleaned = stripExactResourceRules(options.entries, specifier);
	return options.enabled ? [...cleaned, `+${specifier}`] : [...cleaned, `-${specifier}`];
}

/**
 * 计算某个内置扩展在当前层（可含继承层）的开关状态。
 * `baseEntries` 是下层原始值（项目层传全局数组）；语义与 pi 一致：
 * 精确 `-builtin:<name>` 生效即停用；`+builtin:<name>` 在任何更宽的排除之后生效。
 */
export function resolveBuiltinExtensionState(options: { baseEntries?: readonly string[]; entries: readonly string[]; name: PiBuiltinExtension; platform?: NodeJS.Platform }): { enabled: boolean; explicitInLayer: boolean; explicitInBase: boolean } {
	const platform = options.platform ?? process.platform;
	const specifier = builtinSpecifier(options.name);
	const inLayer = options.entries.some((entry) => isExactMatch(entry, specifier, platform));
	const inBase = (options.baseEntries ?? []).some((entry) => isExactMatch(entry, specifier, platform));
	// 简化投影：只看本层/下层的精确条目。更宽的 glob 由上游解析层负责（pi 实际加载才是真值）。
	const enabled = options.entries.some((entry) => isExactMatch(entry, specifier, platform) && entry.startsWith("+"))
		? true
		: options.entries.some((entry) => isExactMatch(entry, specifier, platform) && entry.startsWith("-"))
			? false
			: options.baseEntries?.some((entry) => isExactMatch(entry, specifier, platform) && entry.startsWith("-"))
				? false
				: true;
	return { enabled, explicitInLayer: inLayer, explicitInBase: inBase };
}
