import type {
	ResolveLaunchDefaultsInput,
	ResolvedLaunchDefaults,
} from "../../shared/types";

/**
 * 会话「默认启动偏好」解析器：createDraft 缺省填充与引导页展示共用，保证
 * 「底栏/选择器预选的默认值」与「首次发送时真实套用的默认值」永远一致。
 *
 * 规则（与原 createDraft handler 内联逻辑一致）：
 * - 模型仅对非 DSH 后端解析——pi 模型配置不适用于 DSH（模型路由由 DSH host
 *   自己的 settings 决定）；优先 settings.defaultProvider + defaultModel，
 *   未配齐时回退 models.json 第一个 provider 的第一个模型。
 * - 思考档位对两种后端都填充（值域 off/high/max 兼容），取 settings.defaultThinkingLevel。
 *
 * 输入是磁盘 JSON（pi settings / models.json），字段类型不可信：用 unknown 收窄，
 * 任何字段缺失/类型异常都不抛错，而是逐级降级为 undefined。
 */
export function resolveLaunchDefaultOptions(input: {
	backend?: ResolveLaunchDefaultsInput["backend"];
	settings: unknown;
	models: unknown;
}): ResolvedLaunchDefaults {
	const defaults: ResolvedLaunchDefaults = {};
	if (input.backend !== "dsh") {
		// 仅在解析成功时落键：空结果必须是真 {}，调用方才能用 presence 判断是否预选
		const model = strictModelPair(input.settings) ?? firstModelOfModelsConfig(input.models);
		if (model) defaults.model = model;
	}
	const thinkingLevel = optionalString(input.settings, "defaultThinkingLevel");
	if (thinkingLevel) defaults.thinkingLevel = thinkingLevel;
	return defaults;
}

/** settings.defaultProvider/defaultModel 同时为字符串才算有效配对（避免半配置进入回退歧义）。 */
function strictModelPair(settings: unknown): ResolvedLaunchDefaults["model"] {
	const provider = optionalString(settings, "defaultProvider");
	const modelId = optionalString(settings, "defaultModel");
	return provider && modelId ? { provider, modelId } : undefined;
}

/** models.json 形状 { providers: { [name]: { models: [{ id }] } } }：
 *  顺序扫 provider，跳过损坏/空条目，取第一个含可用模型的 provider 的第一个模型。 */
function firstModelOfModelsConfig(models: unknown): ResolvedLaunchDefaults["model"] {
	if (!isRecord(models)) return undefined;
	const providers = models.providers;
	if (!isRecord(providers)) return undefined;
	for (const providerName of Object.keys(providers)) {
		const provider = providers[providerName];
		if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
		const firstModel = provider.models.find(
			(model) => isRecord(model) && typeof model.id === "string",
		);
		if (firstModel) {
			return { provider: providerName, modelId: firstModel.id };
		}
	}
	return undefined;
}

function optionalString(source: unknown, key: string): string | undefined {
	if (!isRecord(source)) return undefined;
	const value = source[key];
	return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
