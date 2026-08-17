import { useState } from "react";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { Button } from "../components/ui-shadcn/button";
import { ModelsTable, type DshModelRow } from "./DshModelsTable";
import { FetchedModelCombobox } from "./FetchedModelCombobox";
import {
	appendBlankDshModel,
	appendFetchedDshModels,
	removeDshModelAt,
	resolveDshFetchEndpoint,
	updateDshModelAt,
} from "./dshModels";

type FetchedModel = { id: string; name?: string };

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

	const saveSelected = () => {
		if (!fetched || selectedIds.length === 0) return;
		props.onChange(appendFetchedDshModels({
			...seedInput,
			fetched,
			selectedIds,
		}));
		setSelectedIds([]);
	};

	return (
		<div className="grid gap-2">
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
							onClick={saveSelected}
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
			/>
		</div>
	);
}
