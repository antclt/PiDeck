/**
 * 模型规格自动补全（与 dsh-web 添加模型语义对齐）。
 *
 * 优先级：listing 已有字段 > 当前 Pi/内置能力目录匹配 > 留空。
 * 只填空字段；手填 / 明确关掉的 reasoning=false 一律不覆盖。
 * 不再写入 128k/8k 猜的默认值。
 */

import type { ThinkingLevelMap } from "../../../shared/types/modelSpecs";
import type { ModelSpec } from "../../../shared/types/modelSpecs";
import type { FetchedModel } from "../../../shared/types/fetchedModel";
import type { ModelItem, ModelsFile, ProviderConfig } from "../config/configTypes";

/** 单模型补全 patch：返回 [字段, 值] 列表，无可补字段时为空数组 */
export function computeModelSpecPatches(
	model: ModelItem,
	spec: ModelSpec | null | undefined,
): Array<[string, unknown]> {
	if (!spec) return [];
	const updates: Array<[string, unknown]> = [];
	if (model.contextWindow == null && spec.contextWindow != null) {
		updates.push(["contextWindow", spec.contextWindow]);
	}
	if (model.maxTokens == null && spec.maxTokens != null) {
		updates.push(["maxTokens", spec.maxTokens]);
	}
	// reasoning / thinkingLevelMap 是一组：目录明确给出时同时填空，用户明确关掉的 false
	// 或手写映射始终优先，避免代理特有 wire 值被目录覆盖。
	if (model.reasoning === undefined && spec.reasoning !== undefined) {
		updates.push(["reasoning", spec.reasoning]);
	}
	if (model.thinkingLevelMap == null && model.reasoning !== false && spec.thinkingLevelMap) {
		updates.push(["thinkingLevelMap", { ...spec.thinkingLevelMap }]);
	}
	if (model.input == null && spec.input && spec.input.length > 0) {
		updates.push(["input", [...spec.input]]);
	} else if (model.input == null && spec.images === true) {
		// 兼容尚未返回完整 input 的旧目录。
		updates.push(["input", ["text", "image"]]);
	}
	return updates;
}

export function applyModelPatches(
	model: ModelItem,
	updates: Array<[string, unknown]>,
): ModelItem {
	if (updates.length === 0) return model;
	const next: ModelItem = { ...model };
	for (const [field, value] of updates) next[field] = value;
	return next;
}

export type ModelSpecLookup = (
	providerName: string,
	modelId: string,
	modelName?: string,
) => Promise<ModelSpec | null>;

/**
 * 批量补全整个 ModelsFile：空字段才填，未命中就跳过。
 * 不修改入参。
 */
export async function collectModelSpecPatches(
	models: ModelsFile,
	lookup: ModelSpecLookup,
): Promise<{ providers: Record<string, ProviderConfig>; filledCount: number }> {
	// 先浅拷贝全部 provider，避免只遍历到「有模型行」的供应商时把空列表冲掉
	const providers: Record<string, ProviderConfig> = {};
	for (const [providerName, provider] of Object.entries(models.providers)) {
		providers[providerName] = { ...provider, models: [...provider.models] };
	}
	let filledCount = 0;
	const entries = Object.entries(models.providers).flatMap(([providerName, provider]) =>
		provider.models.map((model, index) => ({ providerName, provider, model, index })),
	);
	const results = await Promise.all(
		entries.map(({ providerName, model }) =>
			model.id ? lookup(providerName, model.id, model.name).catch(() => null) : Promise.resolve(null),
		),
	);
	for (let i = 0; i < entries.length; i++) {
		const { providerName, model, index } = entries[i];
		if (!model.id) continue;
		const updates = computeModelSpecPatches(model, results[i]);
		if (updates.length === 0) continue;
		filledCount++;
		providers[providerName].models[index] = applyModelPatches(model, updates);
	}
	return { providers, filledCount };
}

// ── 自适应模板（endpoint 实报 + bundled catalog 合并；重置语义） ──────

/**
 * 自适应模板：对单个模型行建议的能力值。
 * endpoint `/models` 实报字段优先，bundled pi-ai catalog 模板补空。
 * 字段缺省 = 不写入、不落盘（让 Pi 按其默认行为处理）。
 */
export type AdaptiveModelTemplate = {
	contextWindow?: number;
	maxTokens?: number;
	input?: string[];
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	/** bundled catalog 匹配到的标准模型 id（未命中则无）。 */
	matchedId?: string;
};

/**
 * 合并 endpoint listing 与 bundled catalog 模板。
 * 优先级：endpoint 实报字段 > catalog 模板 > 空。
 * 用户当前模型行已填的值不参与合并——它属于「当前有效配置」，由 applyAdaptiveTemplateReset 决定取舍。
 */
export function mergeAdaptiveModelTemplate(
	listing: FetchedModel | undefined,
	spec: ModelSpec | null | undefined,
): AdaptiveModelTemplate {
	const template: AdaptiveModelTemplate = {};
	// endpoint 实报优先
	if (listing?.contextWindow != null) template.contextWindow = listing.contextWindow;
	if (listing?.maxTokens != null) template.maxTokens = listing.maxTokens;
	if (listing?.reasoning !== undefined) template.reasoning = listing.reasoning;
	if (listing?.input && listing.input.length > 0) template.input = [...listing.input];
	if (listing?.thinkingLevelMap) template.thinkingLevelMap = { ...listing.thinkingLevelMap };
	// bundled catalog 补空
	if (template.contextWindow === undefined && spec?.contextWindow != null) {
		template.contextWindow = spec.contextWindow;
	}
	if (template.maxTokens === undefined && spec?.maxTokens != null) {
		template.maxTokens = spec.maxTokens;
	}
	if (template.reasoning === undefined && spec?.reasoning !== undefined) {
		template.reasoning = spec.reasoning;
	}
	if (!template.input && spec?.input && spec.input.length > 0) {
		template.input = [...spec.input];
	} else if (!template.input && spec?.images === true) {
		// 兼容尚未返回完整 input 的旧目录。
		template.input = ["text", "image"];
	}
	if (!template.thinkingLevelMap && spec?.thinkingLevelMap) {
		template.thinkingLevelMap = { ...spec.thinkingLevelMap };
	}
	if (spec?.matchedId) template.matchedId = spec.matchedId;
	return template;
}

/**
 * 重置为自适应：先清空五个能力字段，再只写模板有值的字段。
 * 模板未知的字段不写入（落盘就是空），交还 Pi 默认行为。
 * 与 computeModelSpecPatches（只填空字段）不同：重置是用户显式动作，
 * 明确允许模板覆盖用户此前手填的值。
 */
export function applyAdaptiveTemplateReset(
	model: ModelItem,
	template: AdaptiveModelTemplate,
): ModelItem {
	const next: ModelItem = { ...model };
	delete next.contextWindow;
	delete next.maxTokens;
	delete next.input;
	delete next.reasoning;
	delete next.thinkingLevelMap;
	if (template.contextWindow != null) next.contextWindow = template.contextWindow;
	if (template.maxTokens != null) next.maxTokens = template.maxTokens;
	if (template.reasoning !== undefined) next.reasoning = template.reasoning;
	if (template.input && template.input.length > 0) next.input = [...template.input];
	if (template.thinkingLevelMap) next.thinkingLevelMap = { ...template.thinkingLevelMap };
	return next;
}
