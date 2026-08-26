import type { AvailableModel, DshDiscoveredModel, FetchedModel } from "../../shared/types";

/**
 * DSH host 模型目录 → PiDeck AvailableModel 列表（纯函数，可单测）。
 *
 * 输入是 host wire 的 ModelProviderGroup[]（llm.models / session.models 同构），
 * 输出透传每个模型声明支持的思考档位（reasoning.efforts）——选择器按模型过滤档位，
 * 否则 DSH deepseek 适配器只接受 off/high/max、llm-pi-ai 按模型声明，选不支持的档位
 * 会在下次 LLM 请求抛 UNSUPPORTED_REASONING_EFFORT（回合失败）。
 *
 * 结构性收窄（非 as 断言）：wire 类型（ModelProviderGroup/ModelCatalogModel/ModelReasoning）
 * 与本结构逐字段兼容，仅声明本项目消费的字段，避免主进程模块与 proxy 包类型耦合过深。
 */
export type DshModelGroupInput = {
	id: string;
	models?: Array<{
		id: string;
		name?: string;
		reasoning?: {
			efforts?: Array<{ id: string; name?: string; description?: string }>;
			defaultEffort?: string;
		};
	}>;
};


/** DSH host 模型目录 → PiDeck AvailableModel 列表（纯函数，可单测）。 */
export function toDshAvailableModels(groups: DshModelGroupInput[]): AvailableModel[] {
	const result: AvailableModel[] = [];
	for (const group of groups) {
		for (const model of group.models ?? []) {
			const efforts = Array.isArray(model.reasoning?.efforts)
				? model.reasoning!.efforts
					.map((effort) => {
						const id = typeof effort.id === "string" ? effort.id : "";
						if (!id) return undefined;
						return {
							id,
							...(typeof effort.name === "string" ? { name: effort.name } : {}),
							...(typeof effort.description === "string" ? { description: effort.description } : {}),
						};
					})
					.filter((effort): effort is { id: string; name?: string; description?: string } => effort !== undefined)
				: undefined;
			result.push({
				id: model.id,
				name: model.name,
				provider: group.id,
				...(efforts && efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
				...(typeof model.reasoning?.defaultEffort === "string" && model.reasoning.defaultEffort
					? { defaultEffort: model.reasoning.defaultEffort }
					: {}),
			});
		}
	}
	return result;
}

/** DSH discovery candidates → the shared config-page fetched-model shape. */
export function toDshFetchedModels(models: DshDiscoveredModel[]): FetchedModel[] {
	const result: FetchedModel[] = [];
	for (const model of models) {
		const id = model.id.trim();
		if (!id) continue;
		result.push({
			id,
			...(typeof model.name === "string" && model.name ? { name: model.name } : {}),
			...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
			...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
		});
	}
	return result;
}
