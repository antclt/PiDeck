/**
 * DshProviderCards — DSH 模型 tab 的两类 namespace 卡片（对齐 dsh-web 模型页形态）。
 *
 * - PiAiProvidersCard：llm-pi-ai（动态 providers dict，每个 provider 一行）；
 * - DeepseekRouteCard：llm-deepseek（官方 DeepSeek 路由，单行形态）。
 *
 * 行式布局（与 dsh-web 的 ProviderEditor 同款）：
 * 收起时一行 = 名称/displayName + API 密钥状态点 + 模型数 + 展开箭头（+ 删除）；
 * 展开后 = 主字段「API 密钥」输入框（credentials.set 只写）+「自定义设置」折叠区
 * （其余 schema 字段）+ 自定义模型编辑器（先铺底再改，避免清空目录）。密钥状态点：
 * 绿 = 已配置、红 = 缺失（仅当名单能提供该 ref 的状态信息时显示），无引用不显示。
 */
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Copy, Eye, EyeOff, LoaderCircle, Plus, Trash2, X } from "lucide-react";
import { t } from "../i18n";
import { desktopApi } from "../desktopApi";
import { showNotice } from "../utils/notice";
import { writeClipboard } from "../utils/clipboard";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { isDshCustomSettingsHiddenField } from "./dshFieldLabels";
import { DshSchemaField, type DshNamespaceView } from "./DshSchemaForm";
import {
	DSH_DEFAULT_RETRY_MAX,
	dictEntries,
	normalizeDshSchema,
	objectFields,
	patchDshRetryMaxRetries,
	pruneEmptyObjects,
	readDshRetryPolicy,
	readPath,
	setPath,
	type DshSectionApi,
} from "./dshSchema";
import { credentialRefFor } from "./dshCredentialRef";
import { DshModelsEditor } from "./DshModelsEditor";
import type { DshModelRow } from "./DshModelsTable";
import { ProviderMigrationButton } from "./ProviderMigrationButton";
import { isValidProviderName } from "../../../shared/providerName";

export type DshCredentialState = {
	configured: boolean;
	source?: string;
	writable: boolean;
};

/** 密钥操作回调（由配置页注入：credentials.set/unset + 状态刷新）。 */
export type DshCredentialOps = {
	credentials: Record<string, DshCredentialState>;
	setKey: (ref: string, value: string) => Promise<void>;
	unsetKey: (ref: string) => Promise<void>;
};

/** 收起行头通用布局：chevron + 标题 + badge + 状态点 + 模型数 + 右侧操作。 */
function ProviderRowHead(props: {
	title: string;
	subtitle?: string;
	keyRef?: string;
	keyDot?: ReactNode;
	badges?: ReactNode[];
	isOpen: boolean;
	onToggle: () => void;
	onRemove?: () => void;
	removeDisabled?: boolean;
	removeTitle?: string;
	extraActions?: ReactNode;
}) {
	return (
		<div className="flex items-center gap-2 px-3 py-2">
			<button
				type="button"
				className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
				onClick={props.onToggle}
			>
				{props.isOpen ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
				<span className="truncate font-mono text-control font-semibold text-foreground">{props.title}</span>
				{props.subtitle && <span className="truncate text-micro text-muted-foreground">{props.subtitle}</span>}
				{props.badges?.map((badge, index) => (
					<span key={index} className="shrink-0 rounded-full border border-border-subtle px-1.5 py-px font-mono text-micro text-muted-foreground">
						{badge}
					</span>
				))}
			</button>
			{props.keyRef && (
				<span className="shrink-0 rounded-full border border-border-subtle px-1.5 py-px font-mono text-micro text-muted-foreground" title={t("config.dsh.keyEnvRef")}>
					{props.keyRef}
				</span>
			)}
			{props.keyDot}
			{props.extraActions}
			{props.onRemove && (
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="size-7 shrink-0 text-muted-foreground hover:text-danger"
					title={props.removeTitle}
					aria-label={props.removeTitle}
					disabled={props.removeDisabled}
					onClick={props.onRemove}
				>
					<Trash2 className="size-3.5" aria-hidden="true" />
				</Button>
			)}
		</div>
	);
}

/** API 密钥状态点：绿=已配置、红=缺失（有名单信息时）、灰=未知/无引用。 */
function KeyStatusDot(props: { state: DshCredentialState | undefined }) {
	const { state } = props;
	if (!state) {
		return (
			<span className="size-2 shrink-0 rounded-full bg-muted-foreground/30" title={t("config.dsh.keyUnknown")} aria-label={t("config.dsh.keyUnknown")} />
		);
	}
	if (state.configured) {
		return (
			<span className="size-2 shrink-0 rounded-full bg-emerald-500" title={t("config.dsh.keyConfigured")} aria-label={t("config.dsh.keyConfigured")} />
		);
	}
	return (
		<span className="size-2 shrink-0 rounded-full bg-red-500" title={t("config.dsh.keyMissing")} aria-label={t("config.dsh.keyMissing")} />
	);
}

/**
 * API 密钥主字段（对齐 dsh-web）：密钥输入不单独保存——草稿上抛到卡片，
 * 由卡片头部的统一保存提交（先 credentials.set 再 settings.update）。
 * 已配置时输入框默认留空；点「眼睛」按 ref 取回明文展示（主进程读凭证文件），
 * 再次点击隐藏并清空；「复制」把明文写入剪贴板。
 */
function ApiKeyField(props: {
	ref: string;
	/** 当前密钥草稿（父级持有；空串 = 未改动）。 */
	value: string;
	onChange: (value: string) => void;
	ops: DshCredentialOps;
}) {
	const { ref, value, onChange, ops } = props;
	const [revealed, setRevealed] = useState(false);
	const [busy, setBusy] = useState(false);
	const state = ops.credentials[ref];
	const configured = state?.configured === true;
	const writable = state?.writable !== false;

	/** 取回明文（眼睛显示 / 复制共用）：输入框有草稿用草稿，否则读存储值。 */
	const readPlain = async (): Promise<string | undefined> => {
		if (value) return value;
		if (!configured) return undefined;
		return desktopApi.sessions.readDshCredential(ref).catch(() => undefined);
	};

	/** 眼睛切换：显示时取回明文，隐藏时清空输入（明文不常驻渲染层）。 */
	const toggleReveal = async () => {
		if (revealed) {
			setRevealed(false);
			onChange("");
			return;
		}
		if (!value) {
			setBusy(true);
			try {
				const stored = await readPlain();
				if (stored !== undefined) onChange(stored);
			} finally {
				setBusy(false);
			}
		}
		setRevealed(true);
	};

	/** 复制明文到剪贴板（草稿优先，否则读存储值）。 */
	const copyValue = async () => {
		setBusy(true);
		try {
			const plain = await readPlain();
			if (plain !== undefined) {
				await writeClipboard(plain);
				showNotice(t("config.dsh.keyCopied"), 2000);
			}
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="grid gap-1.5">
			<span className="flex items-center gap-1.5 text-caption font-medium text-foreground">
				{t("config.dsh.apiKey")}
				<span className="truncate font-mono text-micro text-muted-foreground">{ref}</span>
				{configured && (
					<span className="rounded-full border border-emerald-300/70 bg-emerald-500/10 px-1.5 py-px text-micro text-emerald-700 dark:border-emerald-700/70 dark:text-emerald-300">
						{t("config.dsh.keyConfigured")}
					</span>
				)}
			</span>
			<div className="flex items-center gap-2">
				<div className="relative max-w-sm flex-1">
					<Input
						className="h-8 w-full pr-16 font-mono"
						type={revealed ? "text" : "password"}
						placeholder={configured ? t("config.dsh.keyStored") : t("config.dsh.keyPlaceholder")}
						value={value}
						disabled={!writable || busy}
						onChange={(event) => onChange(event.target.value)}
					/>
					<div className="absolute inset-y-0 right-0.5 my-auto flex items-center gap-0.5">
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className="size-7 text-muted-foreground"
							title={t("config.dsh.keyCopy")}
							aria-label={t("config.dsh.keyCopy")}
							disabled={!configured || busy}
							onClick={() => void copyValue()}
						>
							<Copy className="size-3.5" aria-hidden="true" />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className="size-7 text-muted-foreground"
							title={revealed ? t("config.dsh.keyHide") : t("config.dsh.keyReveal")}
							aria-label={revealed ? t("config.dsh.keyHide") : t("config.dsh.keyReveal")}
							disabled={!configured || busy}
							onClick={() => void toggleReveal()}
						>
							{revealed ? <EyeOff className="size-3.5" aria-hidden="true" /> : <Eye className="size-3.5" aria-hidden="true" />}
						</Button>
					</div>
				</div>
				{configured && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-8 shrink-0 text-muted-foreground hover:text-danger"
						disabled={!writable || busy}
						onClick={() => void ops.unsetKey(ref)}
					>
						{t("config.dsh.keyUnset")}
					</Button>
				)}
			</div>
			{!state && <p className="text-micro text-muted-foreground">{t("config.dsh.keyRefHint", { ref })}</p>}
			{state && !state.writable && <p className="text-micro text-muted-foreground">{t("config.dsh.keyEnvLocked")}</p>}
		</div>
	);
}

/**
 * 供应商级最大重试次数。DSH 没有全局 retry：策略在每个 provider 的 retryPolicy。
 * 省略显示默认 5；清空输入 = 恢复默认；always 模式填次数会改成有限 normal。
 */
function RetryMaxRetriesField(props: {
	policy: unknown;
	onChange: (next: unknown) => void;
	writable: boolean;
}) {
	const view = readDshRetryPolicy(props.policy);
	const unboundedAlways = view.mode === "always" && view.maxRetries === undefined;
	const committed = unboundedAlways ? "" : String(view.maxRetries ?? DSH_DEFAULT_RETRY_MAX);
	// 数字框用本地草稿：清空瞬间若立刻写回默认 5，用户没法从空框再输入。
	const [draft, setDraft] = useState(committed);
	useEffect(() => {
		setDraft(committed);
	}, [committed]);
	const commit = (raw: string) => {
		const trimmed = raw.trim();
		if (trimmed === "") {
			props.onChange(patchDshRetryMaxRetries(props.policy, undefined));
			return;
		}
		const next = Number(trimmed);
		if (!Number.isFinite(next)) return;
		props.onChange(patchDshRetryMaxRetries(props.policy, Math.max(0, Math.min(50, Math.trunc(next)))));
	};
	return (
		<label className="grid gap-1">
			<span className="grid min-w-0 gap-0.5">
				<span className="text-caption font-medium text-foreground">{t("config.dsh.field.maxRetries")}</span>
				<span className="text-micro text-muted-foreground">{t("config.dsh.field.maxRetriesHint")}</span>
				{unboundedAlways ? (
					<span className="text-micro text-amber-600 dark:text-amber-400">{t("config.dsh.field.maxRetriesAlways")}</span>
				) : null}
			</span>
			<Input
				className="h-8"
				type="number"
				min={0}
				max={50}
				value={draft}
				placeholder={String(DSH_DEFAULT_RETRY_MAX)}
				disabled={!props.writable}
				onChange={(event) => {
					const raw = event.target.value;
					setDraft(raw);
					if (raw.trim() === "") return;
					commit(raw);
				}}
				onBlur={() => commit(draft)}
			/>
		</label>
	);
}

/** 「自定义设置」折叠区：收容主字段（密钥）与模型列表之外的其余 schema 字段。 */
function CustomSettings(props: {
	label: ReactNode;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className="rounded-sm border border-border-subtle">
			<button
				type="button"
				className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-caption font-medium text-foreground"
				onClick={() => setOpen((prev) => !prev)}
			>
				{open ? <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden="true" />}
				{props.label}
			</button>
			{open && <div className="grid gap-2.5 border-t border-border/40 px-3 py-2.5">{props.children}</div>}
		</div>
	);
}

/**
 * llm-pi-ai providers 卡片：每个 provider 一行（可展开），支持添加/删除 provider。
 * 保存语义与 Pi 管理页一致：不自带保存按钮，草稿变化上报脏状态，
 * 由顶部统一保存（先按行 credentials.set 再 settings.update）。
 */
export function PiAiProvidersCard(props: {
	namespace: DshNamespaceView;
	writable: boolean;
	ops: DshCredentialOps;
	/** 适配器内置模型目录（llm.models 按 provider id 分组）；行头模型数与展开区继承模型用它。 */
	catalog?: Record<string, Array<{ id: string; name?: string }>>;
	/** 可配置提供方目录（llm.providers）：添加提供方时从 declared 未激活行选择。 */
	directory?: Array<{ provider: string; displayName: string; active: boolean; declared?: boolean }>;
	onSave: (patch: Record<string, unknown>) => Promise<void>;
	/** 统一保存/脏状态接口（ConfigModal 顶部保存 + 关闭确认）。 */
	sectionApi?: DshSectionApi;
	/** 稳定脏标记 key（dsh:<nav>:<sub>）。 */
	instanceKey?: string;
	/** 把供应商迁到 pi 后刷新本页。 */
	onMigrated?: () => void;
}) {
	const { namespace, writable, ops, sectionApi } = props;
	const generatedId = useId();
	const instanceId = props.instanceKey ?? generatedId;
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
	/** 密钥草稿：providerKey → 输入的新密钥（保存时统一 credentials.set）。 */
	const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	/** 脏状态：settings 草稿或任一密钥草稿非空。 */
	const dirty = Object.keys(draft).length > 0 || Object.values(keyDrafts).some((value) => value.trim());
	useEffect(() => {
		sectionApi?.onDirtyChange(instanceId, dirty);
		// 卸载时清掉本实例的脏来源，避免收起/切换后残留黄点
		return () => sectionApi?.onDirtyChange(instanceId, false);
	}, [sectionApi, instanceId, dirty]);

	/** 统一保存：先写全部密钥草稿，再提交 settings patch；全部成功返回 true。 */
	const save = useCallback(async (): Promise<boolean> => {
		if (!dirty) return true;
		setSaving(true);
		setError(null);
		try {
			for (const [key, keyValue] of Object.entries(keyDrafts)) {
				const trimmed = keyValue.trim();
				if (!trimmed) continue;
				const draftProfile = (draft.providers as Record<string, unknown> | undefined)?.[key];
				const currentProfile = (namespace.value as { providers?: Record<string, unknown> } | undefined)?.providers?.[key];
				const meta = (draftProfile ?? currentProfile) as Record<string, unknown> | undefined;
				const ref = credentialRefFor(meta, key);
				await ops.setKey(ref, trimmed);
			}
			await props.onSave(pruneEmptyObjects(draft) as Record<string, unknown>);
			setDraft({});
			setKeyDrafts({});
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setSaving(false);
		}
	}, [dirty, keyDrafts, draft, namespace.value, ops, props]);
	useEffect(() => {
		if (!sectionApi) return;
		sectionApi.registerSave(instanceId, save);
		return () => sectionApi.unregisterSave(instanceId);
	}, [sectionApi, instanceId, save]);

	if (!schema || !root || !providersField) {
		return <div className="py-6 text-center text-control text-muted-foreground">{t("config.dsh.schemaUnavailable")}</div>;
	}

	const providersValue = (namespace.value as { providers?: unknown } | undefined)?.providers;
	// 按 key 深合并：draft 往往只带 models，浅合并会盖掉已保存的 displayName/baseURL
	const mergedProvidersValue = mergeProviderMaps(
		(providersValue ?? {}) as Record<string, unknown>,
		(draft.providers ?? {}) as Record<string, unknown>,
	);
	const entries = dictEntries(mergedProvidersValue);
	const innerRefId = providersField.ref.inner;
	if (innerRefId === undefined) {
		return <div className="py-6 text-center text-control text-muted-foreground">{t("config.dsh.schemaUnavailable")}</div>;
	}
	const inner = schema.refs[innerRefId];

	/** 内置目录候选：未激活（尚未配置）且不在当前列表中的行；已配置的 provider 不重复推荐。
	 *  注意 dsh-llm-pi-ai 的 declared 语义：内置 catalog 行 declared=false，
	 *  用户自定义行 declared=true——候选不看 declared，只看 active。 */
	const directoryCandidates = useMemo(() => {
		const configured = new Set(entries.map((entry) => entry.key));
		return (props.directory ?? [])
			.filter((entry) => !entry.active && !configured.has(entry.provider))
			.sort((left, right) => left.displayName.localeCompare(right.displayName));
	}, [props.directory, entries]);

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

	/** 添加 provider：优先从内置目录（llm.providers declared 行）带出 displayName/apiKeyEnv。 */
	const addProvider = (directoryEntry?: { provider: string; displayName: string }) => {
		const key = directoryEntry?.provider ?? newProviderKey.trim();
		// DSH 兼容性：provider name 经 credentialRefFor 转成 <NAME>_API_KEY 环境变量名，
		// 含特殊字符/空格/点号会生成非法环境变量名 → host 进程读不到密钥。
		// 目录候选已预置合规名，仅校验自定义输入；非法时提示规则、不写入。
		if (!key) return;
		if (entries.some((entry) => entry.key === key)) return;
		if (!isValidProviderName(key)) {
			showNotice(t("config.providerNameRule"));
			return;
		}
		setDraft((prev) => {
			const next = structuredClone(prev) as Record<string, unknown>;
			const providers = (next.providers ?? {}) as Record<string, unknown>;
			const profile: Record<string, unknown> = {};
			if (directoryEntry && directoryEntry.displayName && directoryEntry.displayName !== key) {
				profile.displayName = directoryEntry.displayName;
			}
			// 内置目录带出派生密钥引用（dsh-web 同规则：profile 未声明 apiKeyEnv 时派生 <ROUTE>_API_KEY）
			profile.apiKeyEnv = credentialRefFor(undefined, key);
			providers[key] = profile;
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
		setKeyDrafts((prev) => {
			const next = { ...prev };
			delete next[key];
			return next;
		});
	};

	/** 整表写入自定义 models：编辑器已按目录/已保存列表铺底，这里不再从空 draft 起步。 */
	const setProviderModels = (providerKey: string, models: DshModelRow[]) => {
		setDraft((prev) => {
			const next = structuredClone(prev) as Record<string, unknown>;
			const providers = (next.providers ?? {}) as Record<string, unknown>;
			const provider = (providers[providerKey] ?? {}) as Record<string, unknown>;
			provider.models = models;
			providers[providerKey] = provider;
			next.providers = providers;
			return next;
		});
	};

	// 密钥/凭证槽位已在卡片上方单独编辑，自定义设置只留 baseURL、协议、显示名等
	const providerProfileFields = objectFields(schema, inner).filter(
		(field) => !isDshCustomSettingsHiddenField(field.name, field.ref.meta),
	);

	return (
		<div className="flex min-w-0 flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-4 py-2">
				<span className="text-caption font-semibold text-foreground">{namespace.ns}</span>
				<span className="rounded-full border border-border-subtle px-2 py-0.5 text-micro text-muted-foreground">
					{t("config.dsh.providersCount", { count: entries.length })}
				</span>
				{error && <span className="max-w-64 truncate text-micro text-danger" title={error}>{error}</span>}
				{dirty && <span className="ml-auto text-micro text-amber-500" title={t("config.dirtyTooltip")}>●</span>}
				{saving && <span className="ml-auto text-micro text-muted-foreground">{t("common.saving")}</span>}
			</div>

			<div className="grid gap-2 p-4">
				{/* 添加 provider（对齐 dsh-web 的休眠目录选择 + 自定义输入）：目录行点击即带出 displayName/密钥引用 */}
				<div className="flex flex-wrap items-center gap-2">
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
							<Button type="button" variant="default" size="sm" className="h-7" disabled={!isValidProviderName(newProviderKey)} onClick={() => addProvider()}>
								{t("common.confirm")}
							</Button>
							<Button type="button" variant="ghost" size="icon-sm" className="size-7" onClick={() => setAddingProvider(false)}>
								<X className="size-3.5" aria-hidden="true" />
							</Button>
							{newProviderKey.trim() && !isValidProviderName(newProviderKey) ? (
								<p className="text-micro text-destructive">{t("config.providerNameRule")}</p>
							) : null}
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
					{/* 内置目录候选（declared 未激活行；与 dsh-web 的休眠目录同一数据源） */}
					{directoryCandidates.length > 0 && (
						<div className="flex flex-wrap items-center gap-1.5">
							<span className="text-micro text-muted-foreground">{t("config.dsh.directoryLabel")}</span>
							{directoryCandidates.map((entry) => (
								<Button
									key={entry.provider}
									type="button"
									variant="outline"
									size="sm"
									className="h-7 gap-1 font-mono"
									disabled={!writable}
									onClick={() => addProvider(entry)}
								>
									<Plus className="size-3" aria-hidden="true" />
									{entry.displayName !== entry.provider ? `${entry.displayName} (${entry.provider})` : entry.provider}
								</Button>
							))}
						</div>
					)}
				</div>

				{/* provider 行列表 */}
				{entries.map((entry) => {
					const isOpen = expanded[entry.key] ?? false;
					// 模型列表：draft 覆盖优先（新增/删除行即时反映），否则用现值
					const draftModels = entryValue(entry.key, ["models"]);
					// 已保存列表必须读 namespace，不能读 entry.value：后者可能是未合并的 draft 碎片
					const persisted = (namespace.value as { providers?: Record<string, { models?: unknown }> } | undefined)?.providers?.[entry.key]?.models;
					const savedModels = Array.isArray(persisted) ? persisted as DshModelRow[] : [];
					const models = Array.isArray(draftModels) ? draftModels as DshModelRow[] : savedModels;
					const providerMeta = (entry.value ?? {}) as Record<string, unknown>;
					const baseURLValue = entryValue(entry.key, ["baseURL"]);
					const apiValue = entryValue(entry.key, ["api"]);
					const baseURL = typeof baseURLValue === "string" ? baseURLValue : "";
					const api = typeof apiValue === "string" ? apiValue : "";
					const displayName = typeof providerMeta.displayName === "string" ? providerMeta.displayName : "";
					const keyRef = credentialRefFor(providerMeta, entry.key);
					const providerCatalog = props.catalog?.[entry.key];
					// 生效模型数：自定义 models 非空取自定义数，否则取内置目录数（dsh-web 同语义）
					const modelCount = models.length > 0 ? models.length : (providerCatalog?.length ?? 0);
					return (
						<div key={entry.key} className="rounded-md border border-border-subtle bg-bg-panel">
							<ProviderRowHead
								title={entry.key}
								subtitle={displayName && displayName !== entry.key ? displayName : undefined}
								badges={[
									t("config.dsh.modelsCount", { count: modelCount }),
									...(api ? [api] : []),
									...(baseURL ? [baseURL] : []),
								]}
								keyRef={keyRef}
								keyDot={<KeyStatusDot state={ops.credentials[keyRef]} />}
								extraActions={
									<ProviderMigrationButton
										direction="dsh-to-pi"
										provider={entry.key}
										onMigrated={props.onMigrated}
									/>
								}
								isOpen={isOpen}
								onToggle={() => setExpanded((prev) => ({ ...prev, [entry.key]: !prev[entry.key] }))}
								onRemove={() => removeProvider(entry.key)}
								removeDisabled={!writable}
								removeTitle={t("config.dsh.removeProvider")}
							/>
							{isOpen && (
								<div className="grid gap-3 border-t border-border/40 px-3 py-3">
									<ApiKeyField
										ref={keyRef}
										value={keyDrafts[entry.key] ?? ""}
										onChange={(next) => setKeyDrafts((prev) => ({ ...prev, [entry.key]: next }))}
										ops={ops}
									/>
									<CustomSettings label={t("config.dsh.customSettings")}>
										<p className="text-micro text-muted-foreground">{t("config.dsh.customSettingsHint")}</p>
										<RetryMaxRetriesField
											policy={entryValue(entry.key, ["retryPolicy"])}
											onChange={(next) => updateEntry(entry.key, ["retryPolicy"], next)}
											writable={writable}
										/>
										{providerProfileFields.map((field) => (
											<DshSchemaField
												key={field.name}
												schema={schema}
												ref={field.ref}
												path={[field.name]}
												value={entryValue(entry.key, [field.name])}
												secrets={namespace.secrets}
												onChange={(path, next) => updateEntry(entry.key, path, next)}
												writable={writable}
											/>
										))}
									</CustomSettings>
									<DshModelsEditor
										models={models}
										savedModels={savedModels}
										catalog={providerCatalog}
										writable={writable}
										providerKey={entry.key}
										baseURL={baseURL}
										api={api}
										apiKeyDraft={keyDrafts[entry.key]}
										credentialRef={keyRef}
										onChange={(nextModels) => setProviderModels(entry.key, nextModels)}
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
 * llm-deepseek 官方路由卡片：单行形态（无动态 providers dict）。
 * 收起一行 = 路由名 + 密钥状态点 + 模型数；展开 = 密钥主字段 + 自定义设置 + 模型列表。
 */
export function DeepseekRouteCard(props: {
	namespace: DshNamespaceView;
	writable: boolean;
	ops: DshCredentialOps;
	/** 适配器内置模型目录（llm.models 中 provider=deepseek-official 的分组）。 */
	catalog?: Array<{ id: string; name?: string }>;
	onSave: (patch: Record<string, unknown>) => Promise<void>;
	/** 统一保存/脏状态接口（ConfigModal 顶部保存 + 关闭确认）。 */
	sectionApi?: DshSectionApi;
	/** 稳定脏标记 key（dsh:<nav>:<sub>）。 */
	instanceKey?: string;
	/** 把官方 DeepSeek 迁到 pi 后刷新本页。 */
	onMigrated?: () => void;
}) {
	const { namespace, writable, ops, sectionApi } = props;
	const generatedId = useId();
	const instanceId = props.instanceKey ?? generatedId;
	const schema = useMemo(() => normalizeDshSchema(namespace.schema), [namespace.schema]);
	const root = schema?.refs[schema.uid];

	const [draft, setDraft] = useState<Record<string, unknown>>({});
	const [open, setOpen] = useState(false);
	/** 密钥草稿：保存时先 credentials.set 再 settings.update（与 pi-ai 卡同一收敛语义）。 */
	const [keyDraft, setKeyDraft] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	/** draft 覆盖读取：draft 优先，否则用现值。 */
	const value = (path: string[]) => {
		const overridden = readPath(draft, path);
		return overridden !== undefined ? overridden : readPath(namespace.value, path);
	};

	// 密钥 ref 需在保存回调之前计算（save useCallback 依赖它）
	const apiKeyEnv = typeof value(["apiKeyEnv"]) === "string" ? value(["apiKeyEnv"]) as string : "";
	const keyRef = credentialRefFor({ apiKeyEnv }, "deepseek");

	/** 脏状态：settings 草稿或密钥草稿非空。 */
	const dirty = Object.keys(draft).length > 0 || keyDraft.trim().length > 0;
	useEffect(() => {
		sectionApi?.onDirtyChange(instanceId, dirty);
		// 卸载时清掉本实例的脏来源，避免收起/切换后残留黄点
		return () => sectionApi?.onDirtyChange(instanceId, false);
	}, [sectionApi, instanceId, dirty]);

	/** 统一保存：先写密钥草稿（credentials.set），再提交 settings patch；成功返回 true。 */
	const save = useCallback(async (): Promise<boolean> => {
		if (!dirty) return true;
		setSaving(true);
		setError(null);
		try {
			const trimmed = keyDraft.trim();
			if (trimmed) {
				await ops.setKey(keyRef, trimmed);
			}
			await props.onSave(pruneEmptyObjects(draft) as Record<string, unknown>);
			setDraft({});
			setKeyDraft("");
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setSaving(false);
		}
	}, [dirty, keyDraft, keyRef, ops, props]);
	useEffect(() => {
		if (!sectionApi) return;
		sectionApi.registerSave(instanceId, save);
		return () => sectionApi.unregisterSave(instanceId);
	}, [sectionApi, instanceId, save]);

	if (!schema || !root) {
		return <div className="py-6 text-center text-control text-muted-foreground">{t("config.dsh.schemaUnavailable")}</div>;
	}

	const update = (path: string[], next: unknown) => {
		const nextDraft = structuredClone(draft) as Record<string, unknown>;
		// 空值 = 未覆盖（沿用默认/现有值），避免 patch 提交空串
		if (next === undefined || next === "") {
			setPath(nextDraft, path, undefined as never);
		} else {
			setPath(nextDraft, path, next);
		}
		setDraft(nextDraft);
	};

	// models：draft 覆盖优先；保存列表单独传给编辑器做铺底，避免首次自定义清空目录
	const savedModels = Array.isArray((namespace.value as { models?: unknown } | undefined)?.models)
		? (namespace.value as { models: DshModelRow[] }).models
		: [];
	const draftModels = readPath(draft, ["models"]);
	const models = Array.isArray(draftModels) ? draftModels as DshModelRow[] : savedModels;
	const baseURLValue = value(["baseURL"]);
	const apiValue = value(["api"]);
	const baseURL = typeof baseURLValue === "string" ? baseURLValue : "";
	const api = typeof apiValue === "string" ? apiValue : "";
	const baseFields = objectFields(schema, root).filter(
		(field) => !isDshCustomSettingsHiddenField(field.name, field.ref.meta),
	);

	const setModels = (nextModels: DshModelRow[]) => {
		setDraft((prev) => {
			const next = structuredClone(prev) as Record<string, unknown>;
			next.models = nextModels;
			return next;
		});
	};

	return (
		<div className="flex min-w-0 flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-4 py-2">
				<span className="text-caption font-semibold text-foreground">{namespace.ns}</span>
				<span className="rounded-full border border-border-subtle px-2 py-0.5 text-micro text-muted-foreground">
					{namespace.applies === "live" ? t("config.dsh.appliesLive") : t("config.dsh.appliesRestart")}
				</span>
				{error && <span className="max-w-64 truncate text-micro text-danger" title={error}>{error}</span>}
				{dirty && <span className="ml-auto text-micro text-amber-500" title={t("config.dirtyTooltip")}>●</span>}
				{saving && <span className="ml-auto text-micro text-muted-foreground">{t("common.saving")}</span>}
			</div>
			<div className="grid gap-2 p-4">
				<div className="rounded-md border border-border-subtle bg-bg-panel">
					<ProviderRowHead
						title={namespace.ns === "llm-deepseek" ? t("config.dsh.deepseekOfficial") : namespace.ns}
						badges={[t("config.dsh.modelsCount", { count: models.length > 0 ? models.length : (props.catalog?.length ?? 0) })]}
						keyRef={keyRef}
						keyDot={<KeyStatusDot state={ops.credentials[keyRef]} />}
						extraActions={
							<ProviderMigrationButton
								direction="dsh-to-pi"
								provider="deepseek"
								onMigrated={props.onMigrated}
							/>
						}
						isOpen={open}
						onToggle={() => setOpen((prev) => !prev)}
					/>
					{open && (
						<div className="grid gap-3 border-t border-border/40 px-3 py-3">
							<ApiKeyField ref={keyRef} value={keyDraft} onChange={setKeyDraft} ops={ops} />
							<CustomSettings label={t("config.dsh.customSettings")}>
								<p className="text-micro text-muted-foreground">{t("config.dsh.customSettingsHint")}</p>
								<RetryMaxRetriesField
									policy={value(["retryPolicy"])}
									onChange={(next) => update(["retryPolicy"], next)}
									writable={writable}
								/>
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
							</CustomSettings>
							<DshModelsEditor
								models={models}
								savedModels={savedModels}
								catalog={props.catalog}
								writable={writable}
								providerKey="deepseek-official"
								baseURL={baseURL}
								api={api}
								apiKeyDraft={keyDraft}
								credentialRef={keyRef}
								onChange={setModels}
							/>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

/** 现值与草稿按 provider key 合并；同一 key 下对象字段再浅合并一层。 */
function mergeProviderMaps(
	saved: Record<string, unknown>,
	draft: Record<string, unknown>,
): Record<string, unknown> {
	const next: Record<string, unknown> = { ...saved };
	for (const [key, draftEntry] of Object.entries(draft)) {
		const savedEntry = saved[key];
		if (
			savedEntry && typeof savedEntry === "object" && !Array.isArray(savedEntry)
			&& draftEntry && typeof draftEntry === "object" && !Array.isArray(draftEntry)
		) {
			next[key] = { ...(savedEntry as Record<string, unknown>), ...(draftEntry as Record<string, unknown>) };
		} else {
			next[key] = draftEntry;
		}
	}
	return next;
}

function Empty(props: { text: string }) {
	return (
		<div className="rounded-sm border border-border-subtle bg-bg-panel px-3.5 py-8 text-center text-control text-muted-foreground">
			{props.text}
		</div>
	);
}
