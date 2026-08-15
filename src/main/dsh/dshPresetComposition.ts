/**
 * DSH agent preset 组合辅助（纯函数，可单测）。
 *
 * 背景：dsh CLI 的 profile-boot 会在引导时把随包发布的 agent-presets 根目录
 * （SHIPPED_PRESET_ROOT，即 <dsh 包>/config/agent-presets）注入组合，并声明
 * `default: standard`。PiDeck 的 hostEntry 是自组组合（base patch + 自身 overlay），
 * 不声明 agent-presets 行时 `agentPreset.list` 返回空名单（配置页「预设设置」空白），
 * 新会话也没有默认预设可用。这里把该行抽成纯函数，hostEntry 装配、单测验证同一来源。
 *
 * 用户级默认值覆盖仍走 settings 文档（$DSH_HOME/settings.yaml 的 agent-presets.default，
 * 配置页「设为默认」写入同一命名空间），与 dsh-web 的 General 设置行一致。
 */
import { join } from "node:path";

/** 随包发布的 agent preset 根目录：<dsh 包目录>/config/agent-presets。 */
export function shippedPresetRoot(dshPackageDir: string): string {
	return join(dshPackageDir, "config", "agent-presets");
}

/**
 * agent-presets 组合行：默认 standard（标准模式）+ 随包 system 根。
 * 用户根（$DSH_HOME/.agent-presets）由插件 `includeUserRoot` 默认自动追加，
 * 与 dsh-web 的部署形态（web-app cordis.patch.yml）一致。
 */
export function agentPresetsRow(dshPackageDir: string): {
	id: string;
	name: string;
	config: { default: string; roots: Array<{ path: string; trust: "system" }> };
} {
	return {
		id: "agent-presets",
		name: "@deepseek-ai/dsh-agent-presets",
		config: {
			default: "standard",
			roots: [{ path: shippedPresetRoot(dshPackageDir), trust: "system" }],
		},
	};
}
