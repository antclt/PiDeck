/**
 * 解析 provider `/models` 响应（与 dsh-web llm-pi-ai/discovery.readListing 对齐）。
 *
 * 容量只在端点真正给出时保留：context_window / context_length（Gemini 的
 * inputTokenLimit 也算 listing 已返回）；max_output_tokens / max_tokens /
 * outputTokenLimit。缺字段不猜默认值——后续由 pi-ai 目录补，再缺就空着。
 */

import type { FetchedModel } from "../../shared/types/fetchedModel";
import { positiveInt } from "../pi/piAiBuiltinCatalog";

function nonEmptyString(...candidates: readonly unknown[]): string | undefined {
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	return undefined;
}

/** 多个候选里取第一个正整数容量（dsh discovery.capacity） */
function capacity(...candidates: readonly unknown[]): number | undefined {
	for (const candidate of candidates) {
		const value = positiveInt(candidate);
		if (value != null) return value;
	}
	return undefined;
}

/**
 * @param body 端点 JSON
 * @param apiType 已规范化的 api（如 google-generative-ai）；用于剥 Gemini `models/` 前缀
 */
export function parseProviderModelsResponse(
	body: unknown,
	apiType?: string,
): FetchedModel[] {
	const record = body && typeof body === "object" && !Array.isArray(body)
		? (body as Record<string, unknown>)
		: null;
	const rawData = Array.isArray(record?.data)
		? record.data
		: Array.isArray(body)
			? body
			: Array.isArray(record?.models)
				? record.models
				: [];

	const models: FetchedModel[] = [];
	for (const raw of rawData) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const model = raw as Record<string, unknown>;
		// id 是字符串就用它（空串跳过，不回落到 name）；无 id 才用 name（Gemini `models/xxx`）
		const rawId =
			typeof model.id === "string"
				? model.id
				: typeof model.name === "string"
					? model.name
					: "";
		if (!rawId) continue;
		const id =
			apiType === "google-generative-ai" ? rawId.replace(/^models\//, "") : rawId;
		if (!id) continue;
		const name = nonEmptyString(
			model.displayName,
			model.display_name,
			typeof model.name === "string" ? model.name.replace(/^models\//, "") : undefined,
		);
		const contextWindow = capacity(
			model.context_window,
			model.context_length,
			model.inputTokenLimit,
			model.contextWindow,
		);
		const maxTokens = capacity(
			model.max_output_tokens,
			model.max_tokens,
			model.outputTokenLimit,
			model.maxTokens,
		);
		models.push({
			id,
			...(name ? { name } : {}),
			...(contextWindow != null ? { contextWindow } : {}),
			...(maxTokens != null ? { maxTokens } : {}),
		});
	}
	return models;
}
