import type { FetchedModel } from "../../../shared/types/fetchedModel";
import { buildModelsFromFetchedSelection } from "./modelsUtils";

/** DSH 模型行：自定义覆盖适配器目录时写入 settings.yaml 的条目。 */
export type DshModelLike = {
	id?: unknown;
	name?: unknown;
	contextWindow?: unknown;
	maxTokens?: unknown;
	[key: string]: unknown;
};

function cloneModelRows(rows: unknown): DshModelLike[] {
	if (!Array.isArray(rows)) return [];
	return rows.map((row) =>
		row && typeof row === "object" && !Array.isArray(row)
			? { ...(row as DshModelLike) }
			: { id: "", name: "" },
	);
}

function isNonEmptyModelList(rows: unknown): rows is unknown[] {
	return Array.isArray(rows) && rows.length > 0;
}

/**
 * 开始自定义编辑前解析「当前已有模型」。
 *
 * DSH 语义：provider.models 非空 = 覆盖适配器目录。首次点「添加 / 获取」时
 * draft 往往还没有 models，若只从 draft 起步会写成 [空行] 并在保存时清空目录。
 *
 * 优先级：
 * 1. draft 非空数组——本轮已开始自定义
 * 2. 已保存的自定义列表
 * 3. 适配器目录（继承态下第一次自定义，必须先拷贝再改）
 *
 * draft=[] 与「尚未写入」同等对待：DSH 空 models 就是继承目录，
 * 若当成权威空数组，下一次添加又会只剩一行空记录。
 */
export function seedDshModelsForCustomEdit(input: {
	draftModels?: unknown;
	savedModels?: unknown;
	catalog?: unknown;
}): DshModelLike[] {
	if (isNonEmptyModelList(input.draftModels)) return cloneModelRows(input.draftModels);
	if (isNonEmptyModelList(input.savedModels)) return cloneModelRows(input.savedModels);
	return cloneModelRows(input.catalog);
}

/** 在已有模型末尾追加一行空自定义（不丢目录 / 已保存列表）。 */
export function appendBlankDshModel(input: {
	draftModels?: unknown;
	savedModels?: unknown;
	catalog?: unknown;
}): DshModelLike[] {
	const models = seedDshModelsForCustomEdit(input);
	models.push({ id: "", name: "" });
	return models;
}

/** 改某一行字段前先按同样优先级铺底，避免只写 draft 时把其它行冲掉。 */
export function updateDshModelAt(input: {
	draftModels?: unknown;
	savedModels?: unknown;
	catalog?: unknown;
	index: number;
	field: string;
	value: unknown;
}): DshModelLike[] {
	const models = seedDshModelsForCustomEdit(input);
	const entry = { ...(models[input.index] ?? {}) };
	if (input.value === undefined || input.value === "") {
		delete entry[input.field];
	} else {
		entry[input.field] = input.value;
	}
	models[input.index] = entry;
	return models;
}

/** 删除一行前同样先铺底，避免 inherited / 已保存列表被当成空数组。 */
export function removeDshModelAt(input: {
	draftModels?: unknown;
	savedModels?: unknown;
	catalog?: unknown;
	index: number;
}): DshModelLike[] {
	return seedDshModelsForCustomEdit(input).filter((_, index) => index !== input.index);
}

/** 把勾选的拉取结果追加到已有模型，跳过 id 重复。 */
export function appendFetchedDshModels(input: {
	draftModels?: unknown;
	savedModels?: unknown;
	catalog?: unknown;
	fetched: FetchedModel[];
	selectedIds: string[];
}): DshModelLike[] {
	const existing = seedDshModelsForCustomEdit(input);
	const existingItems = existing.map((row) => ({
		id: typeof row.id === "string" ? row.id : "",
		name: typeof row.name === "string" ? row.name : undefined,
	}));
	const added = buildModelsFromFetchedSelection(input.fetched, input.selectedIds, existingItems);
	return [
		...existing,
		...added.map((model) => {
			const row: DshModelLike = { id: model.id, name: model.name };
			// 与 Pi 配置页同一套：listing / pi-ai 已给出的容量原样写入，缺的留空
			if (model.contextWindow != null) row.contextWindow = model.contextWindow;
			if (model.maxTokens != null) row.maxTokens = model.maxTokens;
			if (Array.isArray(model.input) && model.input.length > 0) row.input = [...model.input];
			return row;
		}),
	];
}

/** DSH 配置页应通过 host 的 llm.discoverModels 取候选，不在 renderer 解析 provider 端点。 */
