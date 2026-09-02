import type {
	ResolveLaunchDefaultsInput,
	ResolvedLaunchDefaults,
} from "../../shared/types";

/**
 * 会话「默认启动偏好」解析器：createDraft 缺省填充与引导页展示共用，保证
 * 「底栏/选择器预选的默认值」与「首次发送时真实套用的默认值」永远一致。
 *
 * 规则（与原 createDraft handler 内联逻辑一致，2026-09 增加 lastUsed 语义）：
 * - 模型仅对非 DSH 后端解析——pi 模型配置不适用于 DSH（模型路由由 DSH host
 *   自己的 settings 决定）。解析优先级：
 *     1. 用户最后一次实际使用的模型（desktop settings.lastUsedModel，发送时自动记录）；
 *     2. settings.defaultProvider + defaultModel（用户显式配置）；
 *     3. models.json 第一个 provider 的第一个模型。
 *   **每个来源都会校验目标模型确实仍存在于 models.json**：供应商/模型被删除后，
 *   失效来源自动跳过，保证新会话（底栏预选与真实套用）不再默认已删除的模型。
 * - 思考档位对两种后端都填充（值域 off/high/max 兼容），取 settings.defaultThinkingLevel。
 *
 * 输入是磁盘 JSON（pi settings / models.json / desktop settings），字段类型不可信：
 * 用 unknown 收窄，任何字段缺失/类型异常都不抛错，而是逐级降级为 undefined。
 */
export function resolveLaunchDefaultOptions(input: {
	backend?: ResolveLaunchDefaultsInput["backend"];
	settings: unknown;
	models: unknown;
	/** 桌面端记录的「用户最后一次使用的模型」（userData/settings.json 的 lastUsedModel）。 */
	lastUsedModel?: unknown;
}): ResolvedLaunchDefaults {
	const defaults: ResolvedLaunchDefaults = {};
	if (input.backend !== "dsh") {
		// 仅在解析成功时落键：空结果必须是真 {}，调用方才能用 presence 判断是否预选
		const model =
			lastUsedModelOfModelsConfig(input.lastUsedModel, input.models) ??
			strictModelPair(input.settings, input.models) ??
			firstModelOfModelsConfig(input.models);
		if (model) defaults.model = model;
	}
	const thinkingLevel = optionalString(input.settings, "defaultThinkingLevel");
	if (thinkingLevel) defaults.thinkingLevel = thinkingLevel;
	return defaults;
}

/**
 * settings.defaultProvider/defaultModel 同时为字符串、且两者确实存在于 models.json
 * 才算有效配对（避免半配置进入回退歧义；避免默认指向已删除的供应商/模型）。
 */
function strictModelPair(settings: unknown, models: unknown): ResolvedLaunchDefaults["model"] {
	const provider = optionalString(settings, "defaultProvider");
	const modelId = optionalString(settings, "defaultModel");
	if (!provider || !modelId) return undefined;
	return modelExistsInModelsConfig(models, provider, modelId)
		? { provider, modelId }
		: undefined;
}

/** 显式传入的 model（如欢迎页偏好）是否存在：不存在视为无效，调用方应回退解析默认。 */
export function isModelInModelsConfig(
	models: unknown,
	model: { provider: string; modelId: string },
): boolean {
	return modelExistsInModelsConfig(models, model.provider, model.modelId);
}

/** lastUsedModel（桌面端记录）同样必须仍存在于 models.json，删除后自动失效回退。 */
function lastUsedModelOfModelsConfig(
	lastUsed: unknown,
	models: unknown,
): ResolvedLaunchDefaults["model"] {
	if (!isRecord(lastUsed)) return undefined;
	const provider = lastUsed.provider;
	const modelId = lastUsed.modelId;
	if (typeof provider !== "string" || typeof modelId !== "string") return undefined;
	if (!provider || !modelId) return undefined;
	return modelExistsInModelsConfig(models, provider, modelId)
		? { provider, modelId }
		: undefined;
}

/** 模型是否存在于 models.json（provider 键 + models 数组 id 精确匹配）。 */
function modelExistsInModelsConfig(models: unknown, provider: string, modelId: string): boolean {
	if (!isRecord(models)) return false;
	const providers = models.providers;
	if (!isRecord(providers)) return false;
	const providerEntry = providers[provider];
	if (!isRecord(providerEntry) || !Array.isArray(providerEntry.models)) return false;
	return providerEntry.models.some(
		(model) => isRecord(model) && model.id === modelId,
	);
}

/** models.json 形状 { providers: { [name]: { models: [{ id }] } } }：
 *  顺序扫 provider，跳过损坏/空条目与不可用模型，取第一个含可用模型的 provider 的第一个模型。 */
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
