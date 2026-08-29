/**
 * DSH 官方 DeepSeek 路由的 provider 名归一化（跨进程纯契约函数）。
 *
 * 为什么需要：DSH 配置面用规范名 "deepseek"（settings.yaml 的 llm-deepseek 命名空间、
 * 用量探针配置 key、配置页卡片行头/弹窗），但 host 级 llm.models / session.models 的
 * 组 id 是 "deepseek-official"（dsh-web 适配器目录名）——模型选择器分组行和 runtime
 * state 的 provider 都直接取组 id。若把组 id 当 provider 名查用量，
 * loadDshUsageProviderProfile 只特判 "deepseek"，deepseek-official 会掉进 pi/catalog
 * 兜底 → 解析不到 → 判「暂不支持」——这就是「DSH 配置页能显示、模型选择器/圆球显示
 * 不出来」的根因。
 *
 * 已知别名：
 * - deepseek-official：llm.models 组 id（e2e 实测，data-picker-value 为
 *   deepseek-official/deepseek-v4-pro、runtime state.provider 同值）；
 * - llm-deepseek：命名空间名（防御性收编，防止未来目录直接暴露命名空间）。
 */

const DSH_DEEPSEEK_ALIASES = new Set(["deepseek-official", "llm-deepseek"]);

/**
 * DSH backend 的 provider 名归一化：官方 DeepSeek 别名 → "deepseek"，其余原样返回
 * （已 trim）。pi backend 不应调用本函数（pi 侧 provider 名以 models.json 为准）。
 */
export function normalizeDshDeepseekProvider(name: string): string {
	const trimmed = name.trim();
	return DSH_DEEPSEEK_ALIASES.has(trimmed) ? "deepseek" : trimmed;
}
