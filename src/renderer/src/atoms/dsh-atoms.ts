/**
 * DSH 领域渲染层状态（agent 预设目录缓存）。
 *
 * agentPreset.list 是 host 侧 live 目录（用户可在 dsh-web / 配置文件增删），
 * 会话头胶囊与草稿期模式选择器都要解析 id → 显示名，这里做进程内共享缓存。
 *
 * 注意：本文件保持纯状态（atoms + 纯函数），不 import desktopApi——
 * atoms/index.ts 会被 Node 测试（runtimeAtoms 等）整体加载，而 desktopApi
 * 顶层访问 window（浏览器/Electron 才有），顶层依赖会把整个 atoms 面炸掉。
 * 目录加载逻辑（loadDshAgentPresets）放在消费组件 DshAgentPresetControl 内。
 */
import { atom } from "jotai";

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

/** 目录中标记为部署默认的 preset id（无装配/无标记时 undefined）。 */
export function dshDefaultPresetId(presets: DshAgentPresetIdentity[] | null): string | undefined {
	if (!presets || presets.length === 0) return undefined;
	return presets.find((preset) => preset.isDefault === true)?.id;
}
