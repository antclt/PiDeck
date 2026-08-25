import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { t } from "../i18n";
import { Input } from "../components/ui-shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../components/ui-shadcn/select";
import { cn } from "../lib/utils";
import { deepEqual } from "../utils/deepEqual";
import { dshFieldCopy } from "./dshFieldLabels";
import type { DshSectionApi } from "./dshSchema";
import {
	deletePath,
	dictEntries,
	isSecretSet,
	normalizeDshSchema,
	objectFields,
	pruneEmptyObjects,
	readPath,
	setPath,
	unionConstOptions,
	type DshSchema,
	type DshSchemaRef,
} from "./dshSchema";

export type DshNamespaceView = {
	ns: string;
	applies: string;
	revision: number;
	value: unknown;
	user?: unknown;
	secrets: Array<{ path: string[]; set: boolean }>;
	schema: unknown;
};

export type DshSchemaFormProps = {
	namespace: DshNamespaceView;
	writable: boolean;
	/** 保存 patch（调用方走 settings.update）。 */
	onSave: (patch: Record<string, unknown>) => Promise<void>;
	/** 统一保存/脏状态接口（ConfigModal 顶部保存 + 关闭确认）。 */
	sectionApi?: DshSectionApi;
	/** 稳定脏标记 key（dsh:<nav>:<sub>）；不传退回 useId，但那样侧栏黄点无法归并到导航。 */
	instanceKey?: string;
};

/**
 * Schema 驱动的 DSH 配置表单：把 settings.describe 的 namespace（schema + 脱敏
 * value + secrets）渲染成可编辑表单，改动以 patch 形式提交 settings.update。
 *
 * v1 能力：object/dict/string(secret|credential-ref)/number/boolean/
 * union(const 分支下拉)；array 与复杂嵌套只读展示（JSON 行）。
 *
 * 保存语义与 Pi 管理页一致：表单不自带保存按钮，草稿变化上报脏状态，
 * 由 ConfigModal 顶部统一保存按钮经 sectionApi 触发。
 */
export function DshSchemaForm(props: DshSchemaFormProps) {
	const { namespace, writable, sectionApi } = props;
	// 稳定 key 优先（跨 tab/收起展开保持同一脏标记），useId 仅作兜底。
	const generatedId = useId();
	const instanceId = props.instanceKey ?? generatedId;
	const schema = useMemo(() => normalizeDshSchema(namespace.schema), [namespace.schema]);
	const root = schema?.refs[schema.uid];

	/** 表单草稿：只记录「从默认值改动的字段」，patch 按需展开。 */
	const [draft, setDraft] = useState<Record<string, unknown>>({});
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const dirty = Object.keys(draft).length > 0;

	// 脏状态上报 + 保存函数注册（顶部统一保存）
	useEffect(() => {
		sectionApi?.onDirtyChange(instanceId, dirty);
		// 卸载时清掉本实例的脏来源，避免收起/切换后残留黄点
		return () => sectionApi?.onDirtyChange(instanceId, false);
	}, [sectionApi, instanceId, dirty]);
	const save = useCallback(async (): Promise<boolean> => {
		if (Object.keys(draft).length === 0) return true;
		const patch = pruneEmptyObjects(draft) as Record<string, unknown>;
		setSaving(true);
		setError(null);
		try {
			await props.onSave(patch);
			setDraft({});
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setSaving(false);
		}
	}, [draft, props]);
	useEffect(() => {
		if (!sectionApi) return;
		sectionApi.registerSave(instanceId, save);
		return () => sectionApi.unregisterSave(instanceId);
	}, [sectionApi, instanceId, save]);

	if (!schema || !root) {
		return <div className="py-6 text-center text-control text-muted-foreground">{t("config.dsh.schemaUnavailable")}</div>;
	}

	const value = (path: string[]) => {
		const overridden = readPath(draft, path);
		return overridden !== undefined ? overridden : readPath(namespace.value, path);
	};

	const update = (path: string[], next: unknown) => {
		const nextDraft = { ...draft };
		// 改回原值 / 清空输入（沿用默认）都算「撤销覆盖」：彻底删掉该路径，脏标记随之消失，
		// 而不是 setPath(undefined) 留下空键导致脏状态残留。
		if (next === undefined || next === "" || deepEqual(next, readPath(namespace.value, path))) {
			deletePath(nextDraft, path);
		} else {
			setPath(nextDraft, path, next);
		}
		setDraft(nextDraft);
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
			<div className="p-4">
				{!writable && (
					<div className="mb-3 rounded-sm border border-border-subtle bg-bg-panel px-3.5 py-2.5 text-control text-muted-foreground">
						{t("config.dsh.readOnly")}
					</div>
				)}
				<div className="grid max-w-2xl gap-3">
					<Field
						schema={schema}
						ref={root}
						path={[]}
						value={value([])}
						secrets={namespace.secrets}
						onChange={update}
						writable={writable}
					/>
				</div>
			</div>
		</div>
	);
}

/** 导出给自定义渲染（模型 provider 卡片等）：按 schema 渲染单字段。 */
export function DshSchemaField(props: {
	schema: DshSchema;
	ref: DshSchemaRef;
	path: string[];
	value: unknown;
	secrets: Array<{ path: string[]; set: boolean }>;
	onChange: (path: string[], next: unknown) => void;
	writable: boolean;
}) {
	return <Field {...props} />;
}

function Field(props: {
	schema: DshSchema;
	ref: DshSchemaRef;
	path: string[];
	value: unknown;
	secrets: Array<{ path: string[]; set: boolean }>;
	onChange: (path: string[], next: unknown) => void;
	writable: boolean;
}) {
	const { schema, ref, path, value, secrets, onChange, writable } = props;
	const meta = ref.meta ?? {};

	if (ref.type === "object") {
		const fields = objectFields(schema, ref);
		return (
			<div className="grid gap-2.5">
				{fields.map((field) => (
					<Field
						key={field.name}
						schema={schema}
						ref={field.ref}
						path={[...path, field.name]}
						value={readPath(value, [field.name])}
						secrets={secrets}
						onChange={onChange}
						writable={writable}
					/>
				))}
			</div>
		);
	}

	if (ref.type === "dict") {
		const entries = dictEntries(value);
		const inner = ref.inner ? schema.refs[ref.inner] : undefined;
		return (
			<div className="grid gap-2">
				{entries.map((entry) => (
					<div key={entry.key} className="rounded-sm border border-border-subtle bg-bg-panel px-3 py-2.5">
						<div className="mb-2 flex items-center gap-2">
							<span className="truncate font-mono text-micro font-semibold text-foreground">{entry.key}</span>
						</div>
						{inner ? (
							<Field
								schema={schema}
								ref={inner}
								path={[...path, entry.key]}
								value={entry.value}
								secrets={secrets}
								onChange={onChange}
								writable={writable}
							/>
						) : (
							<JsonReadonly value={entry.value} />
						)}
					</div>
				))}
				{entries.length === 0 && (
					<div className="rounded-sm border border-dashed border-border-subtle px-3 py-2.5 text-micro text-muted-foreground">
						{t("config.dsh.emptySection")}
					</div>
				)}
			</div>
		);
	}

	if (ref.type === "array") {
		return <JsonReadonly value={value} label={t("config.dsh.arrayReadonly")} />;
	}

	if (ref.type === "union") {
		const options = unionConstOptions(schema, ref);
		if (options.length > 0) {
			const current = typeof value === "string" ? value : "";
			return (
				<Labeled name={path[path.length - 1] ?? ""} meta={meta}>
					<Select
						value={current || undefined}
						disabled={!writable}
						onValueChange={(next) => onChange(path, next)}
					>
						<SelectTrigger size="sm" className="h-8 w-full">
							<SelectValue placeholder={t("config.dsh.selectPlaceholder")} />
						</SelectTrigger>
						<SelectContent>
							{options.map((option) => (
								<SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Labeled>
			);
		}
		return <JsonReadonly value={value} />;
	}

	if (ref.type === "const") {
		return <JsonReadonly value={ref.value} label={t("config.dsh.constReadonly")} />;
	}

	if (ref.type === "string") {
		const isSecret = meta.role === "secret";
		const isCredentialRef = meta.role === "credential-ref";
		const current = typeof value === "string" ? value : "";
		const secretSet = isSecret ? isSecretSet(secrets, path) : false;
		const fieldName = path[path.length - 1] ?? "";
		const copy = dshFieldCopy(fieldName);
		return (
			<Labeled name={fieldName} meta={meta} secretSet={secretSet}>
				<Input
					className="h-8"
					type={isSecret ? "password" : "text"}
					value={current}
					placeholder={isSecret ? (secretSet ? t("config.dsh.secretConfigured") : t("config.dsh.secretEmpty")) : copy.placeholder}
					disabled={!writable || (isSecret && secretSet)}
					onChange={(event) => onChange(path, event.target.value)}
				/>
				{isCredentialRef && (
					<span className="text-micro text-muted-foreground">{t("config.dsh.credentialRefHint", { env: current })}</span>
				)}
			</Labeled>
		);
	}

	if (ref.type === "number") {
		const current = typeof value === "number" ? String(value) : "";
		return (
			<Labeled name={path[path.length - 1] ?? ""} meta={meta}>
				<Input
					className="h-8"
					type="number"
					value={current}
					disabled={!writable}
					onChange={(event) => {
						const next = Number(event.target.value);
						onChange(path, Number.isFinite(next) ? next : undefined);
					}}
				/>
			</Labeled>
		);
	}

	if (ref.type === "boolean") {
		const current = value === true;
		return (
			<Labeled name={path[path.length - 1] ?? ""} meta={meta} inline>
				<input
					type="checkbox"
					checked={current}
					disabled={!writable}
					onChange={(event) => onChange(path, event.target.checked)}
					className="size-4 accent-[var(--color-accent)]"
				/>
			</Labeled>
		);
	}

	return <JsonReadonly value={value} />;
}

function Labeled(props: {
	name: string;
	meta: Record<string, unknown>;
	children: ReactNode;
	inline?: boolean;
	secretSet?: boolean;
}) {
	const copy = dshFieldCopy(props.name);
	// schema 很少带 title；用字段名映射中文/英文，空 path 不再显示无意义根标签
	const title = (typeof props.meta.title === "string" && props.meta.title) || copy.label;
	const description =
		(typeof props.meta.description === "string" && props.meta.description) || copy.hint;
	return (
		<label className={cn("grid gap-1", props.inline && "flex items-center justify-between gap-2")}>
			<span className="grid min-w-0 gap-0.5">
				<span className="flex items-center gap-1.5 text-caption font-medium text-foreground">
					{title ? <span className="truncate">{title}</span> : null}
					{props.secretSet && (
						<span className="rounded-full border border-emerald-300/70 bg-emerald-500/10 px-1.5 py-px text-micro text-emerald-700 dark:border-emerald-700/70 dark:text-emerald-300">
							{t("config.dsh.secretSet")}
						</span>
					)}
				</span>
				{description && <span className="text-micro text-muted-foreground">{description}</span>}
			</span>
			{props.children}
		</label>
	);
}

function JsonReadonly(props: { value: unknown; label?: string }) {
	let text = "";
	try {
		text = props.value === undefined ? "" : JSON.stringify(props.value, null, 2);
	} catch {
		text = String(props.value);
	}
	return (
		<div className="rounded-sm border border-border-subtle bg-bg-panel px-3 py-2">
			{props.label && <div className="mb-1 text-micro text-muted-foreground">{props.label}</div>}
			<pre className="max-h-48 overflow-auto font-mono text-micro text-muted-foreground">{text}</pre>
		</div>
	);
}
