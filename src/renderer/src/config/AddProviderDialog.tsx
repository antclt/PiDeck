import { useEffect, useState } from "react";
import { Checkbox } from "../components/ui-shadcn/checkbox";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Label } from "../components/ui-shadcn/label";
import { t } from "../i18n";
import { isValidProviderName } from "../../../shared/providerName";
import { ApiTypeInput, ConfigSelect, SecretInput } from "./ConfigShared";
import { CUSTOM_USER_AGENT_VALUE, getUserAgentOptions } from "./providerHeaders";
import { desktopApi } from "../desktopApi";
import { FetchedModelCombobox } from "./FetchedModelCombobox";
import { buildModelsFromFetchedSelection } from "./modelsUtils";
import { showNotice } from "../utils/notice";
import { ArrowLeft, RefreshCw } from "lucide-react";
import type { FetchedModel } from "../../../shared/types/fetchedModel";
import type { ModelItem, ProviderCompat } from "./configTypes";
import { ModelsTable } from "./ModelsTable";

/**
 * 新增/编辑供应商页（Pi 模型页的「下一页」）：
 * - 新增：点「+ 添加供应商」进入，填名字 + 服务商配置 + 获取模型，一步加入；
 * - 编辑：卡片「修改名称」按钮进入，预填现有配置（名字可改，走 rename 语义），
 *   同时可重新拉取 /models 勾选保存模型。
 * 以整页形式呈现（非弹窗），左上角返回按钮回到模型列表；获取模型与配置在同一页内完成。
 */
export type AddProviderDraft = {
	name: string;
	baseUrl: string;
	api: string;
	apiKey: string;
	userAgent: string;
	compat: {
		supportsDeveloperRole: boolean;
		supportsReasoningEffort: boolean;
	};
	models: ModelItem[];
};

/** 页面模式：add=新增空草稿；edit=预填现有 provider（含改名）。 */
export type ProviderDialogMode = "add" | "edit";

/** 编辑模式预填数据（现有 provider 配置）。 */
export type ProviderDialogInitial = {
	name: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	userAgent?: string;
	compat?: ProviderCompat;
	models?: ModelItem[];
};

export function AddProviderDialog(props: {
	mode: ProviderDialogMode;
	/** edit 模式预填值（add 模式忽略）。 */
	initial?: ProviderDialogInitial;
	/** 已存在的供应商名（防重名；edit 模式已排除自身）。 */
	existingNames: string[];
	/** 返回模型列表（页面左上角返回按钮）。 */
	onBack: () => void;
	onConfirm: (draft: AddProviderDraft) => void;
}) {
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [api, setApi] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [userAgent, setUserAgent] = useState("");
	const [compat, setCompat] = useState({
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
	});
	/** 页内维护的模型草稿：新增=空，编辑=现有模型；获取模型勾选后追加。 */
	const [models, setModels] = useState<ModelItem[]>([]);
	// ── 获取模型（/models）──
	const [fetching, setFetching] = useState(false);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [fetchedModels, setFetchedModels] = useState<FetchedModel[] | null>(null);
	const [selectedFetchedIds, setSelectedFetchedIds] = useState<string[]>([]);

	// 每次进入页面重置草稿：add=空表单；edit=预填现有配置（含模型列表）
	useEffect(() => {
		const initial = props.initial;
		setName(initial?.name ?? "");
		setBaseUrl(initial?.baseUrl ?? "");
		setApi(initial?.api ?? "");
		setApiKey(initial?.apiKey ?? "");
		setUserAgent(initial?.userAgent ?? "");
		setCompat({
			supportsDeveloperRole: initial?.compat?.supportsDeveloperRole ?? false,
			supportsReasoningEffort: initial?.compat?.supportsReasoningEffort ?? false,
		});
		setModels(initial?.models ? initial.models.map((model) => ({ ...model })) : []);
		setFetchedModels(null);
		setSelectedFetchedIds([]);
		setFetchError(null);
	}, [props.initial, props.mode]);

	const trimmedName = name.trim();
	const nameValid = isValidProviderName(trimmedName);
	const duplicate = trimmedName !== "" && props.existingNames.includes(trimmedName);
	const canConfirm = nameValid && !duplicate;

	/** 获取模型用当前草稿的 baseUrl/apiKey/api（不依赖已保存的 provider）。 */
	const handleFetchModels = async () => {
		if (!baseUrl.trim() || !apiKey.trim()) {
			setFetchError(t("config.missingBaseUrlApiKey"));
			return;
		}
		setFetching(true);
		setFetchError(null);
		try {
			const result = await desktopApi.config.fetchModels(
				baseUrl.trim(),
				apiKey.trim(),
				api || undefined,
				userAgent.trim() ? { "User-Agent": userAgent.trim() } : undefined,
			);
			if (result.success && result.models) {
				setFetchedModels(result.models);
				setSelectedFetchedIds([]);
			} else {
				setFetchError(result.error ?? t("config.fetchModelsFailed"));
			}
		} catch (error) {
			setFetchError(error instanceof Error ? error.message : String(error));
		} finally {
			setFetching(false);
		}
	};

	/** 把勾选的获取结果追加进模型草稿（跳过已存在的 id）。 */
	const saveSelectedFetched = () => {
		if (!fetchedModels || selectedFetchedIds.length === 0) return;
		const next = buildModelsFromFetchedSelection(fetchedModels, selectedFetchedIds, models);
		if (next.length === 0) {
			showNotice(t("config.modelsAlreadyConfigured"));
			return;
		}
		setModels((prev) => [...prev, ...next]);
		setSelectedFetchedIds([]);
		showNotice(t("config.modelsSavedFromFetch", { count: next.length }));
	};

	const submit = () => {
		if (!canConfirm) return;
		props.onConfirm({
			name: trimmedName,
			baseUrl: baseUrl.trim(),
			api,
			apiKey: apiKey.trim(),
			userAgent: userAgent.trim(),
			compat,
			models,
		});
	};

	const userAgentOptions = getUserAgentOptions();
	const userAgentSelectValue = userAgentOptions.some(
		(option) => option.value === userAgent,
	)
		? userAgent
		: CUSTOM_USER_AGENT_VALUE;

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* 页面头部：返回按钮 + 标题（对齐设置界面头部形态） */}
			<div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-2.5">
				<Button type="button" variant="ghost" size="icon-sm" className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
					onClick={props.onBack}
					title={t("common.back")}
					aria-label={t("common.back")}
				>
					<ArrowLeft size={16} />
				</Button>
				<span className="text-control font-semibold text-foreground">
					{props.mode === "edit" ? t("config.editProviderDialogTitle") : t("config.addProviderDialogTitle")}
				</span>
			</div>

			{/* 内容区：配置字段 + 获取模型 + 模型列表（可滚动） */}
			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				<div className="config-provider-form grid gap-2.5">
					<div className="grid grid-cols-[90px_1fr] items-start gap-2.5">
						<Label className="pl-0.5 pt-1.5 text-left text-xs font-medium text-text-secondary">
							{t("config.addProviderName")}
						</Label>
						<div className="flex min-w-0 flex-col gap-1">
							<Input
								value={name}
								className="h-8 min-w-0 rounded-sm border border-border-subtle bg-bg-panel px-3 font-mono text-control text-text-primary outline-none transition-[border-color,box-shadow,background-color] duration-150 focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
								placeholder={t("config.providerNamePlaceholder")}
								autoFocus
								onChange={(e) => setName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") submit();
								}}
							/>
							{trimmedName !== "" && !nameValid && (
								<span className="text-[11px] leading-relaxed text-destructive">{t("config.providerNameRule")}</span>
							)}
							{duplicate && (
								<span className="text-[11px] leading-relaxed text-destructive">{t("config.providerNameDuplicate")}</span>
							)}
						</div>
					</div>
					<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
						<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.baseUrl")}</Label>
						<div className="config-base-url-field">
							<Input
								value={baseUrl}
								className="h-8 min-w-0 rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none transition-[border-color,box-shadow,background-color] duration-150 focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
								onChange={(e) => setBaseUrl(e.target.value)}
								placeholder="https://api.openai.com/v1"
							/>
							<span className="mt-1 block text-[11px] leading-relaxed text-text-tertiary">{t("config.baseUrlHint")}</span>
						</div>
					</div>
					<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
						<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.apiType")}</Label>
						<ApiTypeInput value={api} onChange={setApi} />
					</div>
					<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
						<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.apiKey")}</Label>
						<SecretInput value={apiKey} onChange={setApiKey} />
					</div>
					<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
						<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.userAgent")}</Label>
						<div className="config-header-field">
							<ConfigSelect
								value={userAgentSelectValue}
								options={[
									...userAgentOptions,
									{ value: CUSTOM_USER_AGENT_VALUE, label: t("config.custom") },
								]}
								onChange={(value) => {
									if (value === CUSTOM_USER_AGENT_VALUE) return;
									setUserAgent(value);
								}}
							/>
							<Input
								value={userAgent}
								onChange={(e) => setUserAgent(e.target.value)}
								placeholder={t("common.notConfigured")}
							/>
							<span>{t("config.headerEmptyHint")}</span>
						</div>
					</div>
					<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
						<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.compatibility")}</Label>
						<div className="config-compat-group">
							<div className="config-compat-item">
								<Label className="config-checkbox-label">
									<Checkbox
										checked={compat.supportsDeveloperRole}
										onCheckedChange={(checked) =>
											setCompat((prev) => ({ ...prev, supportsDeveloperRole: checked === true }))
										}
									/>
									<span>{t("config.developerRole")}</span>
								</Label>
								<small className="config-compat-item-desc">{t("config.developerRoleDesc")}</small>
							</div>
							<div className="config-compat-item">
								<Label className="config-checkbox-label">
									<Checkbox
										checked={compat.supportsReasoningEffort}
										onCheckedChange={(checked) =>
											setCompat((prev) => ({ ...prev, supportsReasoningEffort: checked === true }))
										}
									/>
									<span>{t("config.reasoningEffort")}</span>
								</Label>
								<small className="config-compat-item-desc">{t("config.reasoningEffortDesc")}</small>
							</div>
						</div>
					</div>
				</div>

				{/* ── 模型配置区：获取 /models + 勾选保存 + 已配置列表（新增/编辑共用） ── */}
				<div className="mt-4 border-t border-border-subtle pt-3">
					<div className="mb-2 flex items-center justify-between gap-2">
						<span className="text-xs font-semibold text-text-primary">{t("config.modelList")}</span>
						<Button type="button" variant="outline" size="sm" className="h-7" onClick={() => void handleFetchModels()} disabled={fetching || !baseUrl.trim() || !apiKey.trim()}>
							<RefreshCw size={13} className={fetching ? "animate-pideck-spin" : ""} aria-hidden="true" />
							{fetching ? t("config.fetchingModels") : t("config.fetchModels")}
						</Button>
					</div>
					{/* 获取结果勾选（拉取成功才显示） */}
					{fetchedModels && fetchedModels.length > 0 && (
						<div className="mb-2 flex flex-col gap-2 rounded-md border border-border-subtle bg-bg-subtle p-2.5">
							<FetchedModelCombobox
								models={fetchedModels}
								value={selectedFetchedIds}
								existingModelIds={models.map((model) => model.id)}
								onChange={setSelectedFetchedIds}
							/>
							<div className="flex justify-end border-t border-border-subtle pt-2">
								<Button type="button" variant="default" size="sm" disabled={selectedFetchedIds.length === 0} onClick={saveSelectedFetched}>
									{t("config.saveSelectedModels")}
								</Button>
							</div>
						</div>
					)}
					{fetchError && (
						<div className="mb-2 rounded-sm border border-danger/20 bg-danger-soft px-3 py-2 text-[11px] leading-relaxed text-danger whitespace-pre-line">{fetchError}</div>
					)}
					{/* 已配置模型列表：与展开卡片同款模型表格（页内草稿管理，确认时随 provider 一起提交） */}
					<ModelsTable
						models={models}
						onUpdateModel={(index, field, value) =>
							setModels((prev) => prev.map((m, j) => (j === index ? { ...m, [field]: value } : m)))
						}
						onUpdateModelThinkingLevel={(index, key, value) => {
							// 思考级别写入模型草稿 thinkingLevelMap/reasoning，并同步 compat.supportsReasoningEffort
							// （与 ConfigModal 的 handleUpdateModelThinkingLevel 语义一致）
							setModels((prev) =>
								prev.map((m, j) => {
									if (j !== index) return m;
									const nextMap = { ...(m.thinkingLevelMap ?? {}) };
									if (value) nextMap[key] = value;
									else delete nextMap[key];
									const next = { ...m, reasoning: value ? true : m.reasoning };
									if (Object.keys(nextMap).length > 0) next.thinkingLevelMap = nextMap;
									else delete next.thinkingLevelMap;
									return next;
								}),
							);
							if (value) {
								setCompat((prev) => ({ ...prev, supportsReasoningEffort: true }));
							}
						}}
						onDeleteModel={(index) => setModels((prev) => prev.filter((_, j) => j !== index))}
					/>
					<p className="mt-1.5 text-[11px] leading-relaxed text-text-tertiary">{t("config.providerDialogModelsHint")}</p>
				</div>
			</div>

			{/* 底部操作：返回（取消）+ 添加/保存 */}
			<div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
				<Button type="button" variant="outline" size="sm" onClick={props.onBack}>
					{t("common.cancel")}
				</Button>
				<Button type="button" variant="default" size="sm" disabled={!canConfirm} onClick={submit}>
					{props.mode === "edit" ? t("common.save") : t("config.addProviderConfirm")}
				</Button>
			</div>
		</div>
	);
}
