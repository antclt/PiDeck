/**
 * 设置 → 生图。
 * 独立供应商，不属于 pi/dsh 任一后端，不读写 pi models.json。接口一律 OpenAI 兼容；
 * 用户勾选该供应商支持的官方字段（size / output_format / watermark），
 * composer 才展示对应控件。保存走 ConfigModal 顶部统一按钮。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from "react";
import { useSetAtom } from "jotai";
import { imageGenConfigAtom } from "../../atoms";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui-shadcn/collapsible";
import {
	DEFAULT_IMAGE_GEN_EXTRA_PARAMS,
	EMPTY_IMAGE_GEN_CONFIG,
	type ImageGenConfigFile,
	type ImageGenExtraParam,
	type ImageGenProviderConfig,
} from "../../../../shared/imageGenConfig";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Label } from "../ui-shadcn/label";
import { Switch } from "../ui-shadcn/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";
import { t } from "../../i18n";
import { desktopApi } from "../../desktopApi";
import { showNotice } from "../../utils/notice";
import { FetchedModelCombobox } from "../../config/FetchedModelCombobox";
import type { FetchedModel } from "../../../../shared/types/fetchedModel";

export type ImageGenSectionHandle = {
	save: () => Promise<boolean>;
};

type ImageGenSectionProps = {
	onDirtyChange?: (dirty: boolean) => void;
};

const EXTRA_PARAM_KEYS: Array<{ key: ImageGenExtraParam; labelKey: "config.imagegen.paramSize" | "config.imagegen.paramOutputFormat" | "config.imagegen.paramWatermark"; hintKey: "config.imagegen.paramSizeHint" | "config.imagegen.paramOutputFormatHint" | "config.imagegen.paramWatermarkHint" }> = [
	{ key: "size", labelKey: "config.imagegen.paramSize", hintKey: "config.imagegen.paramSizeHint" },
	{ key: "output_format", labelKey: "config.imagegen.paramOutputFormat", hintKey: "config.imagegen.paramOutputFormatHint" },
	{ key: "watermark", labelKey: "config.imagegen.paramWatermark", hintKey: "config.imagegen.paramWatermarkHint" },
];

function newProviderId(): string {
	return `ig-${crypto.randomUUID().slice(0, 8)}`;
}

function createProvider(): ImageGenProviderConfig {
	return {
		id: newProviderId(),
		name: "",
		baseUrl: "",
		apiKey: "",
		models: [],
		extraParams: { ...DEFAULT_IMAGE_GEN_EXTRA_PARAMS },
	};
}

export const ImageGenSection = forwardRef<ImageGenSectionHandle, ImageGenSectionProps>(
	function ImageGenSection({ onDirtyChange }, ref) {
		const setImageGenConfig = useSetAtom(imageGenConfigAtom);
		const [draft, setDraft] = useState<ImageGenConfigFile>(EMPTY_IMAGE_GEN_CONFIG);
		const [loading, setLoading] = useState(true);
		const [saving, setSaving] = useState(false);
		const [dirty, setDirty] = useState(false);
		const [error, setError] = useState<string | null>(null);
		const [fetchingId, setFetchingId] = useState<string | null>(null);
		const [fetchedByProvider, setFetchedByProvider] = useState<Record<string, FetchedModel[]>>({});
		const [selectedIdsByProvider, setSelectedIdsByProvider] = useState<Record<string, string[]>>({});
		const [fetchErrorByProvider, setFetchErrorByProvider] = useState<Record<string, string | undefined>>({});
		// 供应商折叠态（仅 UI 状态，不进配置文件）：默认只展开第一个，其余收起，避免多供应商平铺撑爆页面
		const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set());

		const toggleCollapsed = useCallback((id: string) => {
			setCollapsedIds((current) => {
				const next = new Set(current);
				if (next.has(id)) {
					next.delete(id);
				} else {
					next.add(id);
				}
				return next;
			});
		}, []);

		// 全部展开：清空折叠集合（新供应商默认展开，无需补登记）
		const expandAll = useCallback(() => {
			setCollapsedIds(new Set());
		}, []);

		// 全部收起：将当前所有供应商登记为折叠
		const collapseAll = useCallback(() => {
			setCollapsedIds(new Set(draft.providers.map((provider) => provider.id)));
		}, [draft.providers]);

		useEffect(() => {
			let cancelled = false;
			void desktopApi.imagegen
				.getConfig()
				.then((loaded) => {
					if (cancelled) return;
					setDraft(loaded);
					// 按“列表”形态初始化：仅保留第一个展开，其余先收起
					setCollapsedIds(new Set(loaded.providers.slice(1).map((provider) => provider.id)));
				})
				.catch((e: unknown) => {
					if (!cancelled) setError(e instanceof Error ? e.message : String(e));
				})
				.finally(() => {
					if (!cancelled) setLoading(false);
				});
			return () => {
				cancelled = true;
			};
		}, []);

		useEffect(() => {
			onDirtyChange?.(dirty);
		}, [dirty, onDirtyChange]);

		useEffect(() => {
			return () => onDirtyChange?.(false);
		}, [onDirtyChange]);

		const patchDraft = useCallback((updater: (current: ImageGenConfigFile) => ImageGenConfigFile) => {
			setDraft(updater);
			setDirty(true);
		}, []);

		const updateProvider = useCallback((id: string, patch: Partial<ImageGenProviderConfig>) => {
			patchDraft((current) => ({
				...current,
				providers: current.providers.map((provider) =>
					provider.id === id ? { ...provider, ...patch } : provider,
				),
			}));
		}, [patchDraft]);

		const handleSave = useCallback(async (): Promise<boolean> => {
			if (saving) return false;
			setSaving(true);
			setError(null);
			try {
				const result = await desktopApi.imagegen.saveConfig(draft);
				if (!result.ok) {
					setError(result.error ?? t("config.imagegen.saveFailed"));
					return false;
				}
				setDraft(result.config);
				setDirty(false);
				setImageGenConfig(result.config);
				showNotice(t("config.imagegen.saved"), 2500);
				return true;
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
				return false;
			} finally {
				setSaving(false);
			}
		}, [draft, saving, setImageGenConfig]);

		useImperativeHandle(ref, () => ({ save: () => handleSave() }), [handleSave]);

		const fetchModels = async (provider: ImageGenProviderConfig) => {
			if (!provider.baseUrl.trim() || !provider.apiKey.trim()) {
				setFetchErrorByProvider((current) => ({
					...current,
					[provider.id]: t("config.imagegen.fetchNeedKey"),
				}));
				return;
			}
			setFetchingId(provider.id);
			setFetchErrorByProvider((current) => ({ ...current, [provider.id]: undefined }));
			try {
				const result = await desktopApi.config.fetchModels(
					provider.baseUrl,
					provider.apiKey,
					"openai-completions",
				);
				if (result.success && result.models) {
					setFetchedByProvider((current) => ({ ...current, [provider.id]: result.models ?? [] }));
					setSelectedIdsByProvider((current) => ({ ...current, [provider.id]: [] }));
					showNotice(t("config.fetchedModels", { count: result.models.length }), 3000);
				} else {
					setFetchErrorByProvider((current) => ({
						...current,
						[provider.id]: result.error ?? t("config.fetchModelsFailed"),
					}));
				}
			} catch (e) {
				setFetchErrorByProvider((current) => ({
					...current,
					[provider.id]: e instanceof Error ? e.message : String(e),
				}));
			} finally {
				setFetchingId(null);
			}
		};

		if (loading) {
			return <div className="py-12 text-center text-control text-muted-foreground">{t("common.loading")}</div>;
		}

		return (
			<div className="grid max-w-3xl gap-4">
				<div className="flex items-start justify-between gap-2">
					<div className="grid gap-1">
						<h2 className="text-sm font-semibold">{t("config.imagegen.section")}</h2>
						<p className="text-control text-muted-foreground">{t("config.imagegen.sectionDesc")}</p>
					</div>
					{/* 全部展开/收起：多供应商时快速切换列表形态 */}
					{draft.providers.length > 0 ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-7 shrink-0"
							onClick={draft.providers.every((provider) => collapsedIds.has(provider.id))
								? expandAll
								: collapseAll}
						>
							{draft.providers.every((provider) => collapsedIds.has(provider.id))
								? t("config.imagegen.expandAll")
								: t("config.imagegen.collapseAll")}
						</Button>
					) : null}
				</div>
				{error ? (
					<div className="rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger">
						{error}
					</div>
				) : null}
				{draft.providers.length === 0 ? (
					<p className="text-control text-muted-foreground">{t("config.imagegen.empty")}</p>
				) : null}
				{draft.providers.map((provider) => {
					const fetched = fetchedByProvider[provider.id] ?? [];
					const collapsed = collapsedIds.has(provider.id);
					return (
						<div key={provider.id} className="overflow-hidden rounded-md border border-border-subtle bg-bg-subtle">
							<Collapsible open={!collapsed} onOpenChange={() => toggleCollapsed(provider.id)}>
								{/* 供应商标题行：折叠时仅显示名称/接口摘要；删除按钮常驻。
								    删除按钮不能嵌进 trigger 内部（嵌套 button 非法），故与 trigger 平级 */}
								<div className="flex items-center gap-2 px-3">
									<CollapsibleTrigger asChild className="min-w-0 flex-1">
										<button
											type="button"
											className="flex min-w-0 flex-1 items-center gap-2 py-2.5 text-left"
											title={collapsed ? t("common.expand") : t("common.collapse")}
										>
											<ChevronDown
												size={14}
												aria-hidden="true"
												className={cn("shrink-0 text-muted-foreground transition-transform", collapsed && "-rotate-90")}
											/>
											<span className="truncate text-sm font-medium">
												{provider.name.trim() || t("config.imagegen.unnamedProvider")}
											</span>
											{/* 折叠态摘要：接口地址 + 模型数，收起后仍可一眼辨认供应商 */}
											{collapsed ? (
												<span className="min-w-0 flex-1 truncate pl-1 text-micro text-muted-foreground">
													{provider.baseUrl.trim()
														? `${provider.baseUrl.trim()} · ${t("config.imagegen.modelsCount", { count: provider.models.filter(Boolean).length })}`
														: t("config.imagegen.modelsCount", { count: provider.models.filter(Boolean).length })}
												</span>
											) : null}
										</button>
									</CollapsibleTrigger>
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										className="shrink-0"
										title={t("config.imagegen.removeProvider")}
										aria-label={t("config.imagegen.removeProvider")}
										onClick={() => patchDraft((current) => ({
											...current,
											providers: current.providers.filter((item) => item.id !== provider.id),
										}))}
									>
										<Trash2 size={14} aria-hidden="true" />
									</Button>
								</div>
								<CollapsibleContent>
									<div className="grid gap-3 border-t border-border-subtle px-3 pb-3 pt-3">
										<div className="grid gap-1">
											<Label htmlFor={`ig-name-${provider.id}`}>{t("config.imagegen.providerName")}</Label>
											<Input
												id={`ig-name-${provider.id}`}
												value={provider.name}
												placeholder={t("config.imagegen.providerNamePlaceholder")}
												onChange={(event) => updateProvider(provider.id, { name: event.target.value })}
											/>
										</div>
										<div className="grid gap-2 sm:grid-cols-2">
											<div className="grid gap-1">
												<Label htmlFor={`ig-url-${provider.id}`}>{t("config.imagegen.baseUrl")}</Label>
												<Input
													id={`ig-url-${provider.id}`}
													value={provider.baseUrl}
													placeholder="https://api.openai.com/v1"
													onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value })}
												/>
											</div>
											<div className="grid gap-1">
												<Label htmlFor={`ig-key-${provider.id}`}>{t("config.imagegen.apiKey")}</Label>
												<Input
													id={`ig-key-${provider.id}`}
													type="password"
													autoComplete="off"
													value={provider.apiKey}
													onChange={(event) => updateProvider(provider.id, { apiKey: event.target.value })}
												/>
											</div>
										</div>
										<div className="grid gap-1.5">
											<Label>{t("config.imagegen.extraParams")}</Label>
											<p className="text-micro text-muted-foreground">{t("config.imagegen.extraParamsHint")}</p>
											<div className="grid gap-1.5">
												{EXTRA_PARAM_KEYS.map((item) => (
													<label
														key={item.key}
														className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-muted/40"
														title={t(item.hintKey)}
													>
														<Switch
															size="sm"
															className="mt-0.5"
															checked={provider.extraParams[item.key] === true}
															onCheckedChange={(checked) => updateProvider(provider.id, {
																extraParams: { ...provider.extraParams, [item.key]: checked },
															})}
															aria-label={t(item.labelKey)}
														/>
														<span className="grid min-w-0 gap-0.5">
															<span className="text-control font-medium">{t(item.labelKey)}</span>
															<span className="text-micro text-muted-foreground">{t(item.hintKey)}</span>
														</span>
													</label>
												))}
											</div>
										</div>
										{/* 参考图模式：声明供应商是否接受图片输入；composer 据此放行/拦截附件 */}
										<div className="grid gap-1.5">
											<Label>{t("config.imagegen.referenceMode")}</Label>
											<p className="text-micro text-muted-foreground">{t("config.imagegen.referenceModeHint")}</p>
											<Select
												value={provider.referenceMode ?? "none"}
												onValueChange={(value) => updateProvider(provider.id, {
													// 枚举收窄：未知值回退为不支持，避免脏配置进存储
													referenceMode: value === "edits" || value === "image-field" ? value : undefined,
												})}
											>
												<SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
												<SelectContent>
												<SelectItem value="none">{t("config.imagegen.referenceNone")}</SelectItem>
												<SelectItem value="edits">{t("config.imagegen.referenceEdits")}</SelectItem>
												<SelectItem value="image-field">{t("config.imagegen.referenceImageField")}</SelectItem>
												</SelectContent>
											</Select>
										</div>
										{/* 接口方言：字段名/响应结构与 OpenAI 兼容不一致的供应商（如 SiliconFlow）在此声明；
										   由配置驱动，不按 URL 猜测。 */}
										<div className="grid gap-1.5">
											<Label>{t("config.imagegen.apiStyle")}</Label>
											<p className="text-micro text-muted-foreground">{t("config.imagegen.apiStyleHint")}</p>
											<Select
												value={provider.apiStyle ?? "openai"}
												onValueChange={(value) => updateProvider(provider.id, {
													// 枚举收窄：未知值回退 openai（旧配置无字段同理）
													apiStyle: value === "openai" || value === "siliconflow" ? value : undefined,
												})}
											>
												<SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
												<SelectContent>
													<SelectItem value="openai">{t("config.imagegen.apiStyleOpenai")}</SelectItem>
													<SelectItem value="siliconflow">{t("config.imagegen.apiStyleSiliconflow")}</SelectItem>
												</SelectContent>
											</Select>
										</div>
										<div className="grid gap-2">
											<div className="flex flex-wrap items-center justify-between gap-2">
												<Label>{t("config.imagegen.models")}</Label>
												<div className="flex gap-1.5">
													<Button
														type="button"
														variant="outline"
														size="sm"
														className="h-7"
														disabled={fetchingId === provider.id}
														onClick={() => void fetchModels(provider)}
													>
														{fetchingId === provider.id ? t("config.fetchingModels") : t("config.fetchModels")}
													</Button>
													<Button
														type="button"
														variant="outline"
														size="sm"
														className="h-7"
														onClick={() => updateProvider(provider.id, { models: [...provider.models, ""] })}
													>
														{t("config.imagegen.addModel")}
													</Button>
												</div>
											</div>
											{fetchErrorByProvider[provider.id] ? (
												<div className="rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">
													{fetchErrorByProvider[provider.id]}
												</div>
											) : null}
											{fetched.length > 0 ? (
												<div className="flex flex-col gap-2 rounded-md border border-border-subtle bg-background p-2.5">
													<FetchedModelCombobox
														models={fetched}
														value={selectedIdsByProvider[provider.id] ?? []}
														existingModelIds={provider.models.filter(Boolean)}
														onChange={(ids) => setSelectedIdsByProvider((current) => ({ ...current, [provider.id]: ids }))}
													/>
													<div className="flex justify-end border-t border-border-subtle pt-2">
														<Button
															type="button"
															variant="default"
															size="sm"
															disabled={(selectedIdsByProvider[provider.id] ?? []).length === 0}
															onClick={() => {
																const selected = selectedIdsByProvider[provider.id] ?? [];
																updateProvider(provider.id, {
																	models: [...provider.models.filter(Boolean), ...selected.filter((id) => !provider.models.includes(id))],
																});
																setSelectedIdsByProvider((current) => ({ ...current, [provider.id]: [] }));
															}}
														>
															{t("config.saveSelectedModels")}
														</Button>
													</div>
												</div>
											) : null}
											{provider.models.map((modelId, index) => (
												<div key={`${provider.id}-model-${index}`} className="flex items-center gap-1.5">
													<Input
														value={modelId}
														placeholder={t("config.imagegen.modelId")}
														onChange={(event) => {
															const models = [...provider.models];
															models[index] = event.target.value;
															updateProvider(provider.id, { models });
														}}
													/>
													<Button
														type="button"
														variant="ghost"
														size="icon-sm"
														aria-label={t("config.imagegen.removeModel")}
														onClick={() => updateProvider(provider.id, {
															models: provider.models.filter((_, itemIndex) => itemIndex !== index),
														})}
													>
														<Trash2 size={14} aria-hidden="true" />
													</Button>
												</div>
											))}
										</div>
									</div>
								</CollapsibleContent>
							</Collapsible>
						</div>
					);
				})}
				<div>
					<Button type="button" variant="outline" size="sm" onClick={() => {
						// 新增供应商默认展开，便于立即填写配置；折叠态仅存于本地 UI state，不落盘
						const provider = createProvider();
						patchDraft((current) => ({ ...current, providers: [...current.providers, provider] }));
						setCollapsedIds((current) => {
							const next = new Set(current);
							next.delete(provider.id);
							return next;
						});
					}}>
						<Plus size={14} aria-hidden="true" />
						{t("config.imagegen.addProvider")}
					</Button>
				</div>
			</div>
		);
	},
);