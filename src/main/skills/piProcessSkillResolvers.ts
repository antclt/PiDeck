import type { AppSettings } from "../../shared/types";
import { resolveEnabledSkillPaths } from "./skillWhitelistResolver";

/**
 * 为 PiProcess 构造技能白名单解析器。
 * 返回值可直接展开为 PiProcess 第 4 参 options 的 resolveEnabledSkillPaths。
 *
 * 与 createPiProcessExtensionResolvers 同构：AgentManager（会话运行时 RPC）与
 * PiModelCapabilityCache（模型能力快照）必须走同一套「哪些技能加载」的判定。
 * 注意 PiModelCapabilityCache 固定 piRpcNoSkills: true（模型查询不需要技能），
 * PiProcess 侧 useSkillWhitelist 会因 piRpcNoSkills 关闭白名单，无需在此特判。
 */
export function createPiProcessSkillResolvers(
	cwd: string,
	settings: AppSettings,
): {
	resolveEnabledSkillPaths: (
		processSettings?: Partial<AppSettings>,
		cwd?: string,
		includeProjectResources?: boolean,
	) => string[] | null;
} {
	return {
		resolveEnabledSkillPaths: (processSettings, _processCwd, includeProjectResources = true) =>
			resolveEnabledSkillPaths({
				cwd,
				includeProjectResources,
				disabledNames:
					processSettings?.disabledSkills ?? settings.disabledSkills ?? [],
			}),
	};
}
