import type { AppSettings } from "../../shared/types";
import { resolveEnabledPromptPaths } from "./promptWhitelistResolver";

/**
 * 为 PiProcess 构造提示词模板白名单解析器。
 * 返回值可直接展开为 PiProcess 第 4 参 options 的 resolveEnabledPromptPaths。
 *
 * 与 createPiProcessSkillResolvers 同构：AgentManager（会话运行时 RPC）与
 * PiModelCapabilityCache（模型能力快照）必须走同一套「哪些模板加载」的判定。
 */
export function createPiProcessPromptResolvers(
	cwd: string,
	settings: AppSettings,
): {
	resolveEnabledPromptPaths: (
		processSettings?: Partial<AppSettings>,
		cwd?: string,
		includeProjectResources?: boolean,
	) => string[] | null;
} {
	return {
		resolveEnabledPromptPaths: (processSettings, _processCwd, includeProjectResources = true) =>
			resolveEnabledPromptPaths({
				cwd,
				includeProjectResources,
				disabledNames:
					processSettings?.disabledPrompts ?? settings.disabledPrompts ?? [],
			}),
	};
}
