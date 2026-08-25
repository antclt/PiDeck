/**
 * DSH 领域渲染层状态（agent 预设目录缓存）。
 *
 * agentPreset.list 是 host 侧 live 目录（用户可在 dsh-web / 配置文件增删），
 * 会话头胶囊与草稿期模式选择器都要解析 id → 显示名，这里做进程内共享缓存：
 * - 首次请求触发一次加载，之后复用；成功返回空名单（部署未装配预设）才缓存 []。
 * - 加载失败（host 首次启动慢 / 未就绪）保持 null 不缓存，下次挂载或点击胶囊可重试。
 * - 目录变化（配置页保存 / 外部编辑）不主动推送，靠组件重新挂载/点击时再拉。
 */
import { atom, getDefaultStore } from "jotai";
import { desktopApi } from "../desktopApi";

/** agentPreset.list 名单行的身份字段（与 DshHost.listAgentPresets 返回子集一致）。 */
export type DshAgentPresetIdentity = {
	id: string;
	trust: "system" | "user";
	isDefault: boolean;
	name?: string;
	description?: string;
	broken?: string;
};

/** 目录缓存：null = 未加载或加载失败（可重试）；[] = 已确认部署未装配预设。 */
export const dshAgentPresetsAtom = atom<DshAgentPresetIdentity[] | null>(null);

/** 加载中标记：避免多组件并发重复 invoke（首拉合并成一次）。 */
export const dshAgentPresetsLoadingAtom = atom(false);

/**
 * 触发一次目录加载（幂等合并）。
 * 已缓存（含确认空名单）直接返回；失败不落缓存（保持 null），调用方可重试。
 */
export async function loadDshAgentPresets(): Promise<DshAgentPresetIdentity[] | null> {
	const store = getDefaultStore();
	const cached = store.get(dshAgentPresetsAtom);
	if (cached) return cached;
	if (store.get(dshAgentPresetsLoadingAtom)) return null;
	store.set(dshAgentPresetsLoadingAtom, true);
	try {
		const list = await desktopApi.sessions.listDshAgentPresets();
		store.set(dshAgentPresetsAtom, list);
		return list;
	} catch {
		// host 首次启动可能数秒、或 DSH 环境未就绪：失败不缓存，保留重试机会
		return null;
	} finally {
		store.set(dshAgentPresetsLoadingAtom, false);
	}
}

/** 目录中标记为部署默认的 preset id（无装配/无标记时 undefined）。 */
export function dshDefaultPresetId(presets: DshAgentPresetIdentity[] | null): string | undefined {
	if (!presets || presets.length === 0) return undefined;
	return presets.find((preset) => preset.isDefault === true)?.id;
}
