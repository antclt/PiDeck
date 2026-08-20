/**
 * 模型规格自动补全（与 dsh-web 添加模型语义对齐）。
 *
 * 优先级：listing 已有字段 > pi-ai 内置目录精确匹配 > 留空。
 * 只填空字段；手填 / 明确关掉的 reasoning=false 一律不覆盖。
 * 不再写入 128k/8k 猜的默认值。
 */

import type { ModelSpec } from "../../../shared/types/modelSpecs";
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
	// reasoning 只在「未设置」时填 true；用户明确关掉的 false 不覆盖
	if (model.reasoning === undefined && spec.reasoning === true) {
		updates.push(["reasoning", true]);
	}
	if (model.input == null && spec.images === true) {
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

export type ModelSpecLookup = (providerName: string, modelId: string) => Promise<ModelSpec | null>;

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
			model.id ? lookup(providerName, model.id).catch(() => null) : Promise.resolve(null),
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
