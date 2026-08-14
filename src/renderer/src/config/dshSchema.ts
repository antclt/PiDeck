/**
 * DSH settings schema 渲染辅助：把 schemastery Schema JSON（settings.describe
 * 返回的 schema 字段）折叠成可渲染的字段树，供配置管理页表单使用。
 *
 * schema 形状（探针实测）：
 * { uid: <rootRefId>, refs: { <id>: { type, meta, dict?, inner?, list?, value? } } }
 * - object：dict = { 字段名 → refId }（固定字段）
 * - dict：inner = 值 refId（动态键，如 llm-pi-ai.providers）
 * - union：list = refId[]
 * - const：value = 固定值
 * - array：inner = 元素 refId
 * - string/number/boolean：meta 携带 default/min/max/role(secret|credential-ref)
 */

export type DshSchemaRef = {
	type: string;
	meta?: Record<string, unknown>;
	dict?: Record<string, number>;
	inner?: number;
	list?: number[];
	value?: unknown;
};

export type DshSchema = {
	uid: number;
	refs: Record<number, DshSchemaRef>;
};

/** 归一化 schema：兼容 refs 键是 number 或 string。 */
export function normalizeDshSchema(raw: unknown): DshSchema | null {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as { uid?: unknown; refs?: unknown };
	if (typeof value.uid !== "number" || !value.refs || typeof value.refs !== "object") return null;
	const refs: Record<number, DshSchemaRef> = {};
	for (const [key, ref] of Object.entries(value.refs as Record<string, unknown>)) {
		if (!ref || typeof ref !== "object") continue;
		const typed = ref as DshSchemaRef;
		const id = Number(key);
		refs[id] = {
			type: typeof typed.type === "string" ? typed.type : "unknown",
			meta: typed.meta,
			dict: typed.dict,
			inner: typed.inner,
			list: typed.list,
			value: typed.value,
		};
	}
	return { uid: value.uid, refs };
}

export type DshSchemaField = {
	/** 字段名（object.dict 的键 / 动态 dict 的 entry key）。 */
	name: string;
	ref: DshSchemaRef;
	/** 是否是动态 dict 的条目（providers.xxx）。 */
	dictEntry?: boolean;
};

/** object.dict 固定字段列表（保持 schema 声明顺序）。 */
export function objectFields(schema: DshSchema, ref: DshSchemaRef): DshSchemaField[] {
	if (ref.type !== "object" || !ref.dict) return [];
	return Object.entries(ref.dict).map(([name, refId]) => ({
		name,
		ref: schema.refs[refId] ?? { type: "unknown" },
	}));
}

/** union 的可选 const 值列表（供下拉选择；非 const 分支返回空）。 */
export function unionConstOptions(schema: DshSchema, ref: DshSchemaRef): Array<{ value: string; label: string }> {
	if (ref.type !== "union" || !ref.list) return [];
	const options: Array<{ value: string; label: string }> = [];
	for (const refId of ref.list) {
		const branch = schema.refs[refId];
		if (branch?.type === "const" && typeof branch.value === "string") {
			options.push({ value: branch.value, label: branch.value });
		}
	}
	return options;
}

/** 当前值里动态 dict 的条目列表（llm-pi-ai.providers → 各 provider key）。 */
export function dictEntries(value: unknown): Array<{ key: string; value: unknown }> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	return Object.entries(value as Record<string, unknown>).map(([key, item]) => ({
		key,
		value: item,
	}));
}

/** secret 槽位是否已配置（secrets 列表里 path 匹配）。 */
export function isSecretSet(secrets: Array<{ path: string[]; set: boolean }>, path: string[]): boolean {
	return secrets.some((secret) => (
		secret.set &&
		secret.path.length === path.length &&
		secret.path.every((segment, index) => segment === path[index])
	));
}

/** 从 schema 收集所有 credential-ref 字段的 env 名（认证 tab 用）。 */
export function collectCredentialRefs(schema: DshSchema, ref: DshSchemaRef, out: Set<string>): void {
	const meta = ref.meta ?? {};
	if (meta.role === "credential-ref" && typeof meta.default === "string") {
		out.add(meta.default);
		return;
	}
	if (ref.type === "object" && ref.dict) {
		for (const refId of Object.values(ref.dict)) {
			const child = schema.refs[refId];
			if (child) collectCredentialRefs(schema, child, out);
		}
		return;
	}
	if ((ref.type === "dict" || ref.type === "array") && ref.inner) {
		const child = schema.refs[ref.inner];
		if (child) collectCredentialRefs(schema, child, out);
		return;
	}
	if (ref.type === "union" && ref.list) {
		for (const refId of ref.list) {
			const child = schema.refs[refId];
			if (child) collectCredentialRefs(schema, child, out);
		}
	}
}

/**
 * 收集 credential-ref 槽位的 env 名（认证 tab 用），覆盖两类来源：
 * - schema 静态 default：如 llm-deepseek.apiKeyEnv（default="DEEPSEEK_API_KEY"）；
 * - 用户配置的动态值：如 llm-pi-ai.providers[*].apiKeyEnv 的 schema 只有 role 标注、
 *   没有 default，env 名存在 value 里——不读 value 会漏掉用户已配置的凭证。
 */
export function collectCredentialRefsWithValue(
	schema: DshSchema,
	ref: DshSchemaRef,
	value: unknown,
	out: Set<string>,
): void {
	const meta = ref.meta ?? {};
	if (meta.role === "credential-ref") {
		if (typeof meta.default === "string" && meta.default) out.add(meta.default);
		if (typeof value === "string" && value.trim()) out.add(value.trim());
		return;
	}
	if (ref.type === "object" && ref.dict) {
		for (const [name, refId] of Object.entries(ref.dict)) {
			const child = schema.refs[refId];
			if (child) collectCredentialRefsWithValue(schema, child, readPath(value, [name]), out);
		}
		return;
	}
	if ((ref.type === "dict" || ref.type === "array") && ref.inner) {
		const child = schema.refs[ref.inner];
		if (!child) return;
		// dict 的 value 是 { key → 条目 }，array 的 value 是条目数组，遍历条目继续下钻
		if (Array.isArray(value)) {
			for (const item of value) collectCredentialRefsWithValue(schema, child, item, out);
		} else if (value && typeof value === "object") {
			for (const item of Object.values(value as Record<string, unknown>)) {
				collectCredentialRefsWithValue(schema, child, item, out);
			}
		}
		return;
	}
	if (ref.type === "union" && ref.list) {
		for (const refId of ref.list) {
			const child = schema.refs[refId];
			if (child) collectCredentialRefsWithValue(schema, child, value, out);
		}
	}
}

/** 读取 path 下的当前值（未设置返回 undefined）。 */
export function readPath(value: unknown, path: string[]): unknown {
	let current: unknown = value;
	for (const segment of path) {
		if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

/** 写入 path 下的值（创建中间对象；用于 patch 构造）。 */
export function setPath(root: Record<string, unknown>, path: string[], value: unknown): void {
	let current = root;
	for (let index = 0; index < path.length - 1; index += 1) {
		const segment = path[index];
		const existing = current[segment];
		if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
			current[segment] = {};
		}
		current = current[segment] as Record<string, unknown>;
	}
	current[path[path.length - 1]] = value;
}

/** 从嵌套值里移除空对象（patch 提交前清理）。 */
export function pruneEmptyObjects(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(pruneEmptyObjects);
	if (!value || typeof value !== "object") return value;
	const next: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		const cleaned = pruneEmptyObjects(item);
		if (cleaned !== undefined && !(typeof cleaned === "object" && cleaned !== null && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0)) {
			next[key] = cleaned;
		}
	}
	return next;
}
