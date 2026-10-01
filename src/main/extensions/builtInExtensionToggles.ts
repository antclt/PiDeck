/**
 * pi 原生内置扩展开关（计划 A4/E 篇）：把 `builtin:<name>` 的生效状态从原生
 * settings.json 读出来，供 RPC 启动参数与 UI 共用。
 *
 * 为什么需要：`--no-extensions`（白名单模式/诊断）会连带关掉 pi 自己分发的四个
 * 内置扩展；PiDeck 曾无条件用 `-e builtin:*` 把它们全部带回来，结果是**覆盖了用户
 * 在 `pi config` / settings.json 里做的停用选择**（例如用户明确关了 llama.cpp，
 * 启动后又被打开）。正确做法是先算出「原生配置里哪些内置扩展是启用的」，只带回它们。
 *
 * 语义对齐（pi 0.99.2 `resolveBuiltinExtensionState`，见 piResourceRules）：
 * - 精确 `-builtin:<name>` → 停用；`+builtin:<name>` 覆盖更宽的排除；
 * - 项目层精确条目覆盖全局层；
 * - 更宽的 glob（如 `!builtin:*`）由原生解析层处理，这里保守按「启用」处理并在
 *   注入后再由 pi 自己的过滤交叉验证——PiDeck 不复制 pi 的完整匹配器。
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PI_BUILTIN_EXTENSIONS, type PiBuiltinExtension } from "../../shared/types/piResources";

/** pi settings.json 里针对单个内置扩展的精确状态。 */
export type BuiltinToggleState = "enabled" | "disabled" | "unset";

function readSettingsJson(path: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** 从 extensions 数组里找某个内置扩展的精确条目（`+`/`-` 前缀中最后一个生效）。 */
export function builtinToggleIn(entries: readonly string[], name: PiBuiltinExtension): BuiltinToggleState {
	const specifier = `builtin:${name}`;
	let state: BuiltinToggleState = "unset";
	for (const entry of entries) {
		if (entry === specifier || entry === `+${specifier}` || entry === `-${specifier}`) {
			state = entry.startsWith("-") ? "disabled" : "enabled";
		}
	}
	return state;
}

/**
 * 计算每个内置扩展在当前环境的生效状态。
 * 项目层只在 `includeProjectResources`（已通过信任确认）时参与。
 */
export function resolveBuiltinToggleStates(options: { agentHomeDir: string; cwd?: string; includeProjectResources?: boolean }): Record<PiBuiltinExtension, BuiltinToggleState> {
	const agentDir = join(options.agentHomeDir, ".pi", "agent");
	const globalEntries = Array.isArray(readSettingsJson(join(agentDir, "settings.json")).extensions) ? (readSettingsJson(join(agentDir, "settings.json")).extensions as unknown[]).filter((entry): entry is string => typeof entry === "string") : [];
	const projectSettings = options.includeProjectResources && options.cwd ? readSettingsJson(join(options.cwd, ".pi", "settings.json")) : {};
	const projectEntries = Array.isArray(projectSettings.extensions) ? projectSettings.extensions.filter((entry): entry is string => typeof entry === "string") : [];

	const states = {} as Record<PiBuiltinExtension, BuiltinToggleState>;
	for (const name of PI_BUILTIN_EXTENSIONS) {
		const project = builtinToggleIn(projectEntries, name);
		const global = builtinToggleIn(globalEntries, name);
		states[name] = project !== "unset" ? project : global;
	}
	return states;
}

/**
 * 需要显式带回的内置扩展 specifier 列表。
 *
 * 返回空数组 = 用户没有任何显式停用（此时调用方仍可注入全部四个，行为与今天一致）；
 * 有显式停用时只带回启用的那些，**不覆盖用户的停用选择**。
 */
export function builtinSpecifiersToRestore(options: {
	agentHomeDir: string;
	cwd?: string;
	includeProjectResources?: boolean;
	/** 诊断模式（--no-extensions 总开关）：一个都不带回。 */
	loadNone?: boolean;
}): string[] {
	if (options.loadNone) return [];
	const states = resolveBuiltinToggleStates(options);
	return PI_BUILTIN_EXTENSIONS.filter((name) => states[name] !== "disabled").map((name) => `builtin:${name}`);
}
