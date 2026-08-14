/**
 * DshProviderCards — DSH 模型 tab 的两类 namespace 卡片。
 *
 * - PiAiProvidersCard：llm-pi-ai（动态 providers dict，每个 provider 一张可展开卡）；
 * - DeepseekRouteCard：llm-deepseek（官方 DeepSeek 路由，单 provider 形态）。
 *
 * 两者共享同一套结构（与 Pi 管理 ModelsTab 对齐）：卡片头（名称 + badge +
 * 保存按钮）+ 基础字段表单 + ModelsTable 模型列表；模型数组行式增删编辑，
 * 不再以只读 JSON 展示。
 */
import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Plus, Trash2, X } from "lucide-react";
import { t } from "../i18n";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { DshSchemaField, type DshNamespaceView } from "./DshSchemaForm";
import { dictEntries, normalizeDshSchema, objectFields, pruneEmptyObjects, readPath, setPath } from "./dshSchema";
import { ModelsTable, type DshModelRow } from "./DshModelsTable";

/** 卡片头通用布局：标题 + badge + 保存按钮（错误/保存中/已保存状态）。 */
function ConfigCardHeader(props: {
	title: string;
	badge: ReactNode;
	savedAt: number | null;
	error: string | null;
	saving: boolean;
	dirty: boolean;
	writable: boolean;
	onSave: () => void;
}) {
	return (
		<div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-4 py-2">
			<span className="text-caption font-semibold text-foreground">{props.title}</span>
			{props.badge}
			<div className="ml-auto flex items-center gap-2">
				{props.savedAt && <span className="text-micro text-emerald-600 dark:text-emerald-400">{t("config.dsh.saved")}</span>}
				{props.error && <span className="max-w-64 truncate text-micro text-danger" title={props.error}>{props.error}</span>}
				<Button
					type="button"
					variant="default"
					size="sm"
					className="h-7"
					disabled={!props.writable || props.saving || !props.dirty}
					onClick={props.onSave}
				>
					{props.saving ? t("common.saving") : t("common.save")}
				</Button>
			</div>
		</div>
	);
}

/**
 * llm-pi-ai providers 卡片：与 Pi 管理 ModelsTab 同款操作——
 * 每个 provider 一张可展开卡（字段表单 + 模型列表），支持添加/删除 provider。
 */
export function PiAiProvidersCard(props: {
	namespace: DshNamespaceView;
	writable: boolean;
	onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
	const { namespace, writable } = props;
	const schema = useMemo(() => normalizeDshSchema(namespace.schema), [namespace.schema]);
	const root = schema?.refs[schema.uid];
	const providersField = useMemo(() => {
		if (!schema || !root) return undefined;
		return objectFields(schema, root).find((field) => field.ref.type === "dict");
	}, [schema, root]);

	const [draft, setDraft] = useState<Record<string, unknown>>({});
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [newProviderKey, setNewProviderKey] = useState("");
	const [addingProvider, setAddingProvider] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!schema || !root || !providersField) {
		return <div className="py-6 text-center text-control text-muted-foreground">{t("config.dsh.schemaUnavailable")}</div>;
	}

	const providersValue = (namespace.value as { providers?: unknown } | undefined)?.providers;
	const entries = dictEntries(providersValue);
	const innerRefId = providersField.ref.inner;
	if (innerRefId === undefined) {
		return <div className="py-6 text-center text-control text-muted-foreground">{t("config.dsh.schemaUnavailable")}</div>;
	}
	const inner = schema.refs[innerRefId];

	/** 草稿覆盖读取：draft 优先，否则用现值。 */
	const entryValue = (key: string, path: string[]) => {
		const draftPath = ["providers", key, ...path];
		let current: unknown = draft;
		for (const segment of draftPath) {
			if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
			current = (current as Record<string, unknown>)[segment];
		}
		if (current !== undefined) return current;
		// 回退现值
		let actual: unknown = (namespace.value as { providers?: Record<string, unknown> } | undefined)?.providers?.[key];
		for (const segment of path) {
			if (!actual || typeof actual !== "object" || Array.isArray(actual)) return undefined;
			actual = (actual as Record<string, unknown>)[segment];
		}
		return actual;
	};

	const updateEntry = (key: string, path: string[], next: unknown) => {
		const nextDraft = structuredClone(draft) as Record<string, unknown>;
		const draftPath = ["providers", key, ...path];
		let current: Record<string, unknown> = nextDraft;
		for (let index = 0; index < draftPath.length - 1; index += 1) {
			const segment = draftPath[index];
			const existing = current[segment];
			if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
				current[segment] = {};
			}
			current = current[segment] as Record<string, unknown>;
		}
		const last = draftPath[draftPath.length - 1];
		if (next === undefined || next === "") {
			delete current[last];
		} else {
			current[last] = next;
		}
		setDraft(nextDraft);
	};

	const addProvider = () => {
		const key = newProviderKey.trim();
		if (!key || entries.some((entry) => entry.key === key)) return;
		setDraft((prev) => {
			const next = structuredClone(prev) as Record<string, unknown>;
			const providers = (next.providers ?? {}) as Record<string, unknown>;
			providers[key] = {};
			next.providers = providers;
			return next;
		});
		setExpanded((prev) => ({ ...prev, [key]: true }));
		setNewProviderKey("");
		setAddingProvider(false);
	};

	const removeProvider = (key: string) => {
		setDraft((prev) => {
			const next = structuredClone(prev) as Record<string, unknown>;
			const providers = (next.providers ?? {}) as Record<string, unknown>;
			delete providers[key];
			next.providers = providers;
			return next;
		});
		setExpanded((prev) => {
			const next = { ...prev };
			delete next[key];
			return next;
		});
	};

	/** 模型行增删：models 数组在 provider 条目下（行内编辑由 ModelsTable 触发）。 */
	const addModel = (providerKey: string) => {
		setDraft((prev) => {
			const next = structuredClone(prev) as Record<string, unknown>;
			const providers = (next.providers ?? {}) as Record<string, unknown>;
			const provider = (providers[providerKey] ?? {}) as Record<string, unknown>;
			const models = Array.isArray(provider.models) ? [...provider.models] : [];
			models.push({ id: "", name: "" });
			provider.models = models;
			providers[providerKey] = provider;
			next.providers = providers;
			return next;
		});
	};

	const updateModel = (providerKey: string, index: number, field: string, value: unknown) => {
		setDraft((prev) => {
			const next = structuredClone(prev) as Record<string, unknown>;
			const providers = (next.providers ?? {}) as Record<string, unknown>;
			const provider = (providers[providerKey] ?? {}) as Record<string, unknown>;
			const models = Array.isArray(provider.models) ? [...provider.models] : [];
			const entry = { ...((models[index] as Record<string, unknown>) ?? {}) };
			// 空值 = 删除字段：模型行输入清空后不向 DSH 提交空串配置
			if (value === undefined || value === "") {
				delete entry[field];
			} else {
				entry[field] = value;
			}
			models[index] = entry;
			provider.models = models;
			providers[providerKey] = provider;
			next.providers = providers;
			return next;
		});
	};

	const removeModel = (providerKey: string, index: number) => {
		setDraft((prev) => {
			const next = structuredClone(prev) as Record<string, unknown>;
			const providers = (next.providers ?? {}) as Record<string, unknown>;
			const provider = (providers[providerKey] ?? {}) as Record<string, unknown>;
			provider.models = Array.isArray(provider.models)
				? provider.models.filter((_: unknown, itemIndex: number) => itemIndex !== index)
				: [];
			providers[providerKey] = provider;
			next.providers = providers;
			return next;
		});
	};

	const handleSave = async () => {
		setSaving(true);
		setError(null);
		try {
			await props.onSave(pruneEmptyObjects(draft) as Record<string, unknown>);
			setDraft({});
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	const providerProfileFields = objectFields(schema, inner);

	return (
		<div className="flex min-w-0 flex-col">
			<ConfigCardHeader
				title={namespace.ns}
				badge={
					<span className="rounded-full border border-border-subtle px-2 py-0.5 text-micro text-muted-foreground">
						{t("config.dsh.providersCount", { count: entries.length })}
					</span>
				}
				savedAt={null}
				error={error}
				saving={saving}
				dirty={Object.keys(draft).length > 0}
				writable={writable}
				onSave={() => void handleSave()}
			/>

			<div className="grid gap-3 p-4">
				{/* 添加 provider */}
				<div className="flex items-center gap-2">
					{addingProvider ? (
						<>
							<Input
								className="h-7 w-56 font-mono"
								placeholder={t("config.dsh.providerKeyPlaceholder")}
								value={newProviderKey}
								autoFocus
								disabled={!writable}
								onChange={(event) => setNewProviderKey(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") addProvider();
								}}
							/>
							<Button type="button" variant="default" size="sm" className="h-7" disabled={!newProviderKey.trim()} onClick={addProvider}>
								{t("common.confirm")}
							</Button>
							<Button type="button" variant="ghost" size="icon-sm" className="size-7" onClick={() => setAddingProvider(false)}>
								<X className="size-3.5" aria-hidden="true" />
							</Button>
						</>
					) : (
						<Button
							type="button"
							variant="secondary"
							size="sm"
							className="h-7"
							disabled={!writable}
							onClick={() => setAddingProvider(true)}
						>
							<Plus className="size-3.5" aria-hidden="true" />
							{t("config.dsh.addProvider")}
						</Button>
					)}
				</div>

				{/* provider 卡片 */}
				{entries.map((entry) => {
					const isOpen = expanded[entry.key] ?? false;
					// 模型列表：draft 覆盖优先（新增/删除行即时反映），否则用现值
					const draftModels = entryValue(entry.key, ["models"]);
					const models = Array.isArray(draftModels)
						? draftModels as DshModelRow[]
						: Array.isArray((entry.value as { models?: unknown })?.models)
							? (entry.value as { models: DshModelRow[] }).models
							: [];
					const providerMeta = (entry.value ?? {}) as Record<string, unknown>;
					const baseURL = typeof providerMeta.baseURL === "string" ? providerMeta.baseURL : "";
					const api = typeof providerMeta.api === "string" ? providerMeta.api : "";
					const displayName = typeof providerMeta.displayName === "string" ? providerMeta.displayName : "";
					return (
						<div key={entry.key} className="rounded-md border border-border-subtle bg-bg-panel">
							<div className="flex items-center gap-2 px-3 py-2">
								<button
									type="button"
									className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
									onClick={() => setExpanded((prev) => ({ ...prev, [entry.key]: !prev[entry.key] }))}
								>
									{isOpen ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
									<span className="truncate font-mono text-control font-semibold text-foreground">{entry.key}</span>
									{displayName && displayName !== entry.key && (
										<span className="truncate text-micro text-muted-foreground">{displayName}</span>
									)}
									<span className="shrink-0 rounded-full border border-border-subtle px-1.5 py-px font-mono text-micro text-muted-foreground">
										{t("config.dsh.modelsCount", { count: models.length })}
									</span>
									{api && (
										<span className="shrink-0 rounded-full border border-border-subtle px-1.5 py-px font-mono text-micro text-muted-foreground">{api}</span>
									)}
									{baseURL && <span className="max-w-40 truncate text-micro text-muted-foreground/70">{baseURL}</span>}
								</button>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									className="size-7 shrink-0 text-muted-foreground hover:text-danger"
									title={t("config.dsh.removeProvider")}
									aria-label={t("config.dsh.removeProvider")}
									disabled={!writable}
									onClick={() => removeProvider(entry.key)}
								>
									<Trash2 className="size-3.5" aria-hidden="true" />
								</Button>
							</div>
							{isOpen && (
								<div className="grid gap-3 border-t border-border/40 px-3 py-3">
									{/* provider 基础字段（apiKeyEnv/displayName/api/baseURL…） */}
									<div className="grid max-w-xl gap-2.5">
										{providerProfileFields
											.filter((field) => field.name !== "models")
											.map((field) => (
												<DshSchemaField
													key={field.name}
													schema={schema}
													ref={field.ref}
													path={[]}
													value={entryValue(entry.key, [field.name])}
													secrets={namespace.secrets}
													onChange={(path, next) => updateEntry(entry.key, [field.name, ...path], next)}
													writable={writable}
												/>
											))}
									</div>
									{/* 模型列表：与 Pi 管理 ModelsTab 同款表格（行内编辑 + 增删） */}
									<ModelsTable
										models={models}
										writable={writable}
										onAdd={() => addModel(entry.key)}
										onUpdate={(index, field, value) => updateModel(entry.key, index, field, value)}
										onRemove={(index) => removeModel(entry.key, index)}
									/>
								</div>
							)}
						</div>
					);
				})}
				{entries.length === 0 && <Empty text={t("config.dsh.providersEmpty")} />}
			</div>
		</div>
	);
}

/**
 * llm-deepseek 官方路由卡片：单 provider 形态（无动态 providers dict）。
 * 卡片头 + 基础字段（apiKeyEnv/maxTokens/defaultContextWindow/…）+
 * ModelsTable 模型列表；draft/patch 与 PiAiProvidersCard 同一套覆盖语义。
 */
export function DeepseekRouteCard(props: {
	namespace: DshNamespaceView;
	writable: boolean;
	onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
	const { namespace, writable } = props;
	const schema = useMemo(() => normalizeDshSchema(namespace.schema), [namespace.schema]);
	const root = schema?.refs[schema.uid];

	const [draft, setDraft] = useState<Record<string, unknown>>({});
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [savedAt, setSavedAt] = useState<number | null>(null);

	if (!schema || !root) {
		return <div className="py-6 text-center text-control text-muted-foreground">{t("config.dsh.schemaUnavailable")}</div>;
	}

	/** draft 覆盖读取：draft 优先，否则用现值。 */
	const value = (path: string[]) => {
		const overridden = readPath(draft, path);
		return overridden !== undefined ? overridden : readPath(namespace.value, path);
	};

	const update = (path: string[], next: unknown) => {
		const nextDraft = structuredClone(draft) as Record<string, unknown>;
		// 空值 = 未覆盖（沿用默认/现有值），避免 patch 提交空串
		if (next === undefined || next === "") {
			setPath(nextDraft, path, undefined as never);
		} else {
			setPath(nextDraft, path, next);
		}
		setDraft(nextDraft);
		setSavedAt(null);
	};

	// models 数组的读写（ModelsTable 行内编辑）
	const modelsValue = value(["models"]);
	const models = Array.isArray(modelsValue) ? modelsValue as DshModelRow[] : [];
	const baseFields = objectFields(schema, root).filter((field) => field.name !== "models");

	const addModel = () => {
		setDraft((prev) => {
			const next = structuredClone(prev) as Record<string, unknown>;
			const models = Array.isArray(next.models) ? [...next.models] : [];
			models.push({ id: "", name: "" });
			next.models = models;
			return next;
		});
		setSavedAt(null);
	};

	const updateModel = (index: number, field: string, next: unknown) => {
		setDraft((prev) => {
			const nextDraft = structuredClone(prev) as Record<string, unknown>;
			const models = Array.isArray(nextDraft.models) ? [...nextDraft.models] : [];
			const entry = { ...((models[index] as Record<string, unknown>) ?? {}) };
			if (next === undefined || next === "") {
				delete entry[field];
			} else {
				entry[field] = next;
			}
			models[index] = entry;
			nextDraft.models = models;
			return nextDraft;
		});
		setSavedAt(null);
	};

	const removeModel = (index: number) => {
		setDraft((prev) => {
			const next = structuredClone(prev) as Record<string, unknown>;
			next.models = Array.isArray(next.models)
				? next.models.filter((_: unknown, itemIndex: number) => itemIndex !== index)
				: [];
			return next;
		});
		setSavedAt(null);
	};

	const handleSave = async () => {
		setSaving(true);
		setError(null);
		try {
			await props.onSave(pruneEmptyObjects(draft) as Record<string, unknown>);
			setDraft({});
			setSavedAt(Date.now());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="flex min-w-0 flex-col">
			<ConfigCardHeader
				title={namespace.ns}
				badge={
					<span className="rounded-full border border-border-subtle px-2 py-0.5 text-micro text-muted-foreground">
						{namespace.applies === "live" ? t("config.dsh.appliesLive") : t("config.dsh.appliesRestart")}
					</span>
				}
				savedAt={savedAt}
				error={error}
				saving={saving}
				dirty={Object.keys(draft).length > 0}
				writable={writable}
				onSave={() => void handleSave()}
			/>
			<div className="grid max-w-3xl gap-4 p-4">
				{/* 基础字段：除 models 外的根字段（apiKeyEnv/maxTokens/defaultContextWindow/…） */}
				<div className="grid max-w-xl gap-2.5">
					{baseFields.map((field) => (
						<DshSchemaField
							key={field.name}
							schema={schema}
							ref={field.ref}
							path={[field.name]}
							value={value([field.name])}
							secrets={namespace.secrets}
							onChange={update}
							writable={writable}
						/>
					))}
				</div>
				{/* 模型列表表格 */}
				<ModelsTable
					models={models}
					writable={writable}
					onAdd={addModel}
					onUpdate={updateModel}
					onRemove={removeModel}
				/>
			</div>
		</div>
	);
}

function Empty(props: { text: string }) {
	return (
		<div className="rounded-sm border border-border-subtle bg-bg-panel px-3.5 py-8 text-center text-control text-muted-foreground">
			{props.text}
		</div>
	);
}
