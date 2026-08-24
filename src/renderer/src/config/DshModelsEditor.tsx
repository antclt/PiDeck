import { useState } from "react";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { Button } from "../components/ui-shadcn/button";
import { Checkbox } from "../components/ui-shadcn/checkbox";
import { ModelsTable, type DshModelRow } from "./DshModelsTable";
import { FetchedModelCombobox } from "./FetchedModelCombobox";
import {
	appendBlankDshModel,
	appendFetchedDshModels,
	removeDshModelAt,
	resolveDshFetchEndpoint,
	seedDshModelsForCustomEdit,
	updateDshModelAt,
} from "./dshModels";
import type { FetchedModel } from "../../../shared/types/fetchedModel";
import type { ModelSpec } from "../../../shared/types/modelSpecs";
import type { ModelItem } from "./configTypes";
import { computeModelSpecPatches } from "../utils/modelSpecAutoFill";

/**
 * DSH 的 reasoningEfforts 需要“规范档位 → 上游 wire 值”映射；pi-ai catalog 的
 * ModelSpec 只知道模型是否推理，不能安全构造这份映射。因此自动补全只写容量和图片输入。
 */
function dshModelSpecPatches(model: ModelItem, spec: ModelSpec | null) {
  return computeModelSpecPatches(model, spec).filter(([field]) => field !== "reasoning");
}

function dshDefaultInputSupportsImages(input: unknown): boolean {
  return Array.isArray(input) && input.includes("image");
}

function setDshDefaultImageInput(input: unknown, enabled: boolean): string[] {
  const current = Array.isArray(input)
    ? input.filter((item): item is string => typeof item === "string" && item.length > 0)
    : ["text"];
  const withoutImage = current.filter((item) => item !== "image");
  if (!enabled) return withoutImage.includes("text") ? withoutImage : ["text", ...withoutImage];
  return withoutImage.includes("text") ? [...withoutImage, "image"] : ["text", ...withoutImage, "image"];
}

/**
 * DSH 自定义模型编辑器：在适配器目录上追加/拉取，而不是从空 draft 起步。
 * 获取列表复用 Pi 配置页的 fetchModels + FetchedModelCombobox。
 */
export function DshModelsEditor(props: {
	models: DshModelRow[];
	savedModels?: DshModelRow[];
	catalog?: DshModelRow[];
	writable: boolean;
	providerKey?: string;
	baseURL?: string;
	api?: string;
	/** 密钥草稿优先；空则按 credentialRef 读已存凭证。 */
	apiKeyDraft?: string;
	credentialRef?: string;
	/** 未单独声明 input 的自定义模型使用的 provider 级模态兜底。 */
	defaultInput?: unknown;
	onDefaultInputChange?: (input: string[]) => void;
	onChange: (models: DshModelRow[]) => void;
}) {
	const { models, savedModels, catalog, writable } = props;
	const [fetching, setFetching] = useState(false);
	const [fetched, setFetched] = useState<FetchedModel[] | null>(null);
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [fetchError, setFetchError] = useState<string | undefined>(undefined);

	const seedInput = {
		draftModels: models,
		savedModels,
		catalog,
	};

	// 继承目录时 models 为空，勾选器仍要把目录 id 标成已配置，避免重复拉回
	const existingIds = (models.length > 0 ? models : (catalog ?? []))
		.map((model) => (typeof model.id === "string" ? model.id : ""))
		.filter(Boolean);

	const resolveApiKey = async (): Promise<string> => {
		const draft = props.apiKeyDraft?.trim();
		if (draft) return draft;
		if (!props.credentialRef) return "";
		return (await desktopApi.sessions.readDshCredential(props.credentialRef).catch(() => undefined))?.trim() ?? "";
	};

	const fetchModels = async () => {
		const endpoint = resolveDshFetchEndpoint({
			providerKey: props.providerKey,
			baseURL: props.baseURL,
			api: props.api,
		});
		const apiKey = await resolveApiKey();
		if (!endpoint || !apiKey) {
			setFetchError(t("config.missingBaseUrlApiKey"));
			return;
		}
		setFetching(true);
		setFetchError(undefined);
		try {
			const result = await desktopApi.config.fetchModels(endpoint.baseUrl, apiKey, endpoint.apiType);
			if (result.success && result.models) {
				setFetched(result.models);
				setSelectedIds([]);
				showNotice(t("config.fetchedModels", { count: result.models.length }), 3000);
			} else {
				setFetchError(result.error ?? t("config.fetchModelsFailed"));
			}
		} catch (error) {
			setFetchError(error instanceof Error ? error.message : String(error));
		} finally {
			setFetching(false);
		}
	};

	const saveSelected = async () => {
		if (!fetched || selectedIds.length === 0) return;
		const existing = seedDshModelsForCustomEdit(seedInput);
		let nextRows = appendFetchedDshModels({
			...seedInput,
			fetched,
			selectedIds,
		});
		// `/models` 通常没有模态数据；已知模型再由本地 pi-ai catalog 补图片输入。
		// reasoning 只有布尔事实时不能构造 DSH 的 wire 映射，故由迁移或用户配置提供。
		const appended = nextRows.slice(existing.length);
		const specs = await Promise.all(appended.map((row) =>
			desktopApi.projects.getModelSpec(
				props.providerKey ?? "",
				typeof row.id === "string" ? row.id : "",
			).catch(() => null),
		));
		for (let offset = 0; offset < appended.length; offset += 1) {
			const row = nextRows[existing.length + offset];
			if (!row || typeof row.id !== "string") continue;
			const model: ModelItem = {
				id: row.id,
				name: typeof row.name === "string" ? row.name : undefined,
				contextWindow: typeof row.contextWindow === "number" ? row.contextWindow : undefined,
				maxTokens: typeof row.maxTokens === "number" ? row.maxTokens : undefined,
				input: Array.isArray(row.input)
					? row.input.filter((item): item is string => typeof item === "string")
					: undefined,
			};
			for (const [field, value] of dshModelSpecPatches(model, specs[offset])) {
				nextRows = updateDshModelAt({
					draftModels: nextRows,
					savedModels,
					catalog,
					index: existing.length + offset,
					field,
					value,
				});
			}
		}
		props.onChange(nextRows);
		setSelectedIds([]);
	};

	/** 手动输入 id 失焦：listing 没给的容量按 pi-ai 目录补，仍缺留空 */
	const fillFromCatalogOnIdBlur = async (index: number, modelId: string) => {
		const trimmed = modelId.trim();
		if (!trimmed || !writable) return;
		const spec = await desktopApi.projects.getModelSpec(props.providerKey ?? "", trimmed).catch(() => null);
		const current = seedDshModelsForCustomEdit(seedInput);
		const row = current[index];
		if (!row) return;
		const model: ModelItem = {
			id: typeof row.id === "string" ? row.id : trimmed,
			name: typeof row.name === "string" ? row.name : undefined,
			contextWindow: typeof row.contextWindow === "number" ? row.contextWindow : undefined,
			maxTokens: typeof row.maxTokens === "number" ? row.maxTokens : undefined,
		};
		const updates = dshModelSpecPatches(model, spec);
		if (updates.length === 0) return;
		let nextRows = current;
		for (const [field, value] of updates) {
			nextRows = updateDshModelAt({
				draftModels: nextRows,
				savedModels,
				catalog,
				index,
				field,
				value,
			});
		}
		props.onChange(nextRows);
		showNotice(
			t("config.modelSpecAutoFilled", { model: spec?.matchedId ?? trimmed }),
			3000,
		);
	};

	return (
		<div className="grid gap-2">
			{props.onDefaultInputChange && (
				<label className="flex items-center gap-2 text-micro text-muted-foreground">
					<Checkbox
						checked={dshDefaultInputSupportsImages(props.defaultInput)}
						disabled={!writable}
						onCheckedChange={(checked) => props.onDefaultInputChange?.(setDshDefaultImageInput(props.defaultInput, checked === true))}
					/>
					{t("config.dsh.defaultImageInput")}
				</label>
			)}
			<div className="flex flex-wrap items-center justify-end gap-1.5">
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-7"
					disabled={!writable || fetching}
					onClick={() => void fetchModels()}
				>
					{fetching ? t("config.fetchingModels") : t("config.fetchModels")}
				</Button>
			</div>
			{fetchError && (
				<div className="rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">
					{fetchError}
				</div>
			)}
			{fetched && fetched.length > 0 && (
				<div className="flex flex-col gap-2 rounded-md border border-border-subtle bg-bg-subtle p-2.5">
					<FetchedModelCombobox
						models={fetched}
						value={selectedIds}
						existingModelIds={existingIds}
						onChange={setSelectedIds}
					/>
					<div className="flex justify-end border-t border-border-subtle pt-2">
						<Button
							type="button"
							variant="default"
							size="sm"
							disabled={selectedIds.length === 0}
							onClick={() => void saveSelected()}
						>
							{t("config.saveSelectedModels")}
						</Button>
					</div>
				</div>
			)}
			<ModelsTable
				models={models}
				catalog={catalog}
				writable={writable}
				onAdd={() => props.onChange(appendBlankDshModel(seedInput))}
				onUpdate={(index, field, value) => props.onChange(updateDshModelAt({ ...seedInput, index, field, value }))}
				onRemove={(index) => props.onChange(removeDshModelAt({ ...seedInput, index }))}
				onIdBlur={(index, modelId) => void fillFromCatalogOnIdBlur(index, modelId)}
			/>
		</div>
	);
}
