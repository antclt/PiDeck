/**
 * pi ↔ DSH 单供应商配置互迁（纯映射）。
 *
 * 只搬一个 provider：baseUrl/baseURL、api、headers、模型目录、密钥。
 * 不写 workspace.json，不启动 host，不碰其他供应商。
 *
 * DSH 自定义供应商落在 settings.yaml 的 llm-pi-ai.providers；
 * 官方 DeepSeek 是独立命名空间 llm-deepseek，对外仍用名字 deepseek。
 */
import { dump, load } from "js-yaml";
import { credentialRefFor } from "../../shared/dshCredentialRef";
import type { PiAuthItem, PiModelItem, PiProviderConfig } from "./ConfigManager";

export { credentialRefFor } from "../../shared/dshCredentialRef";

export type MigrationDirection = "pi-to-dsh" | "dsh-to-pi";

export type DshProviderNamespace = "llm-pi-ai" | "llm-deepseek";

/** 迁移预览里给 UI 的一行（不含密钥明文）。 */
export type MigratableProviderRow = {
	name: string;
	modelCount: number;
	hasKey: boolean;
	baseUrl?: string;
	namespace?: DshProviderNamespace;
	/** 对端是否已有同名供应商（覆盖前要确认）。 */
	targetExists: boolean;
};

export type DshProviderProfile = {
	displayName?: string;
	baseURL?: string;
	api?: string;
	apiKeyEnv?: string;
	headers?: Record<string, string>;
	models?: Array<{
		id: string;
		name?: string;
		contextWindow?: number;
		maxTokens?: number;
		/** DSH/pi-ai 模型输入模态，例如 ["text", "image"]。 */
		input?: string[];
		/** DSH 的思考档位 → provider wire 值映射；false 表示明确不支持。 */
		reasoningEfforts?: false | Record<string, string | null>;
	}>;
};

export type PiProviderSnapshot = {
	name: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	models: PiModelItem[];
};

export type DshProviderSnapshot = {
	name: string;
	namespace: DshProviderNamespace;
	profile: DshProviderProfile;
	apiKey?: string;
};

const DEEPSEEK_OFFICIAL_HOST = "api.deepseek.com";
const DEEPSEEK_DEFAULT_BASE = "https://api.deepseek.com/v1";

export function isSafeProviderName(name: unknown): name is string {
	return typeof name === "string"
		&& name.trim().length > 0
		&& name.trim().length <= 80
		&& !/[\\/]/.test(name)
		&& !name.includes("..");
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string" && item.length > 0) out[key] = item;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
	return items.length > 0 ? items : undefined;
}

function asReasoningEfforts(value: unknown): Record<string, string | null> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const efforts: Record<string, string | null> = {};
	for (const [level, wireValue] of Object.entries(value)) {
		if (typeof wireValue === "string" || wireValue === null) efforts[level] = wireValue;
	}
	return Object.keys(efforts).length > 0 ? efforts : undefined;
}

/** Pi 模型目录 → DSH 模型条目；保留 DSH 可消费的模态与思考档位映射。 */
export function dshModelsFromPi(models: PiModelItem[] | undefined): DshProviderProfile["models"] {
	if (!Array.isArray(models) || models.length === 0) return undefined;
	const rows: NonNullable<DshProviderProfile["models"]> = [];
	for (const model of models) {
		if (typeof model?.id !== "string" || !model.id.trim()) continue;
		const row: NonNullable<DshProviderProfile["models"]>[number] = { id: model.id.trim() };
		if (typeof model.name === "string" && model.name.trim()) row.name = model.name.trim();
		const contextWindow = asFiniteNumber(model.contextWindow);
		if (contextWindow !== undefined) row.contextWindow = contextWindow;
		const maxTokens = asFiniteNumber(model.maxTokens);
		if (maxTokens !== undefined) row.maxTokens = maxTokens;
		const input = asStringList(model.input);
		if (input) row.input = input;
		// pi 的 thinkingLevelMap 与 DSH 的 reasoningEfforts 都是「规范档位 → wire 值」；
		// 迁移时原样保留，不能只搬模型名后让 DSH 丢掉思考能力。
		const reasoningEfforts = asReasoningEfforts(model.thinkingLevelMap);
		if (model.reasoning === true && reasoningEfforts) row.reasoningEfforts = reasoningEfforts;
		else if (model.reasoning === false) row.reasoningEfforts = false;
		rows.push(row);
	}
	return rows.length > 0 ? rows : undefined;
}

export function piModelsFromDsh(models: DshProviderProfile["models"]): PiModelItem[] {
	if (!Array.isArray(models) || models.length === 0) return [];
	const rows: PiModelItem[] = [];
	for (const model of models) {
		if (typeof model?.id !== "string" || !model.id.trim()) continue;
		const row: PiModelItem = { id: model.id.trim() };
		if (typeof model.name === "string" && model.name.trim()) row.name = model.name.trim();
		const contextWindow = asFiniteNumber(model.contextWindow);
		if (contextWindow !== undefined) row.contextWindow = contextWindow;
		const maxTokens = asFiniteNumber(model.maxTokens);
		if (maxTokens !== undefined) row.maxTokens = maxTokens;
		const input = asStringList(model.input);
		if (input) row.input = input;
		if (model.reasoningEfforts === false) row.reasoning = false;
		else {
			const thinkingLevelMap = asReasoningEfforts(model.reasoningEfforts);
			if (thinkingLevelMap) {
				row.reasoning = true;
				row.thinkingLevelMap = thinkingLevelMap;
			}
		}
		rows.push(row);
	}
	return rows;
}

/**
 * pi-ai catalog 里一个 provider 的模型条目视图（迁移反向用，防跨层强依赖）。
 * 只取迁移构造 snapshot 需要的字段。
 */
export type PiBuiltinCatalogView = {
	byProviderId: Map<string, Map<string, {
		id: string;
		name?: string;
		contextWindow?: number;
		maxTokens?: number;
		reasoning?: boolean;
		input?: string[];
		api?: string;
		baseUrl?: string;
	}>>;
};

/**
 * 从 pi-ai catalog 构造某个内置 provider 的 snapshot（auth.json 里只有 key、
 * models.json 无条目时的反向迁移源）。取该 provider 的 catalog 模型清单，
 * 端点/api 取首个条目的值（catalog 内同 provider 模型条目通常一致）。
 * catalog 无该 provider / 无可用模型时返回 undefined。
 */
export function piBuiltinSnapshotFromCatalog(
	name: string,
	apiKey: string | undefined,
	catalog: PiBuiltinCatalogView,
): PiProviderSnapshot | undefined {
	const inner = catalog.byProviderId.get(name);
	if (!inner || inner.size === 0) return undefined;
	const entries = [...inner.values()];
	const first = entries[0];
	if (!first) return undefined;
	const models: PiModelItem[] = [];
	for (const entry of entries) {
		const row: PiModelItem = { id: entry.id.trim() };
		if (typeof entry.name === "string" && entry.name.trim()) row.name = entry.name.trim();
		if (entry.contextWindow != null) row.contextWindow = entry.contextWindow;
		if (entry.maxTokens != null) row.maxTokens = entry.maxTokens;
		if (entry.reasoning === true) row.reasoning = true;
		if (entry.input && entry.input.length > 0) row.input = entry.input;
		models.push(row);
	}
	return {
		name: name.trim(),
		baseUrl: typeof first.baseUrl === "string" ? first.baseUrl.trim() : undefined,
		api: typeof first.api === "string" ? first.api.trim() : "openai-completions",
		apiKey: apiKey?.trim() || undefined,
		models,
	};
}

export function looksLikeOfficialDeepseek(baseUrl: string | undefined): boolean {
	if (!baseUrl?.trim()) return true;
	try {
		return new URL(baseUrl).hostname.replace(/^www\./, "") === DEEPSEEK_OFFICIAL_HOST;
	} catch {
		return baseUrl.includes(DEEPSEEK_OFFICIAL_HOST);
	}
}

/** pi 供应商 → DSH 档案。官方 DeepSeek 走独立 namespace，其余进 llm-pi-ai。 */
export function piToDshSnapshot(source: PiProviderSnapshot): DshProviderSnapshot {
	const name = source.name.trim();
	const officialDeepseek = name === "deepseek" && looksLikeOfficialDeepseek(source.baseUrl);
	const profile: DshProviderProfile = {};
	if (source.baseUrl?.trim() && !officialDeepseek) profile.baseURL = source.baseUrl.trim();
	if (source.api?.trim()) profile.api = source.api.trim();
	if (source.headers) profile.headers = source.headers;
	const models = dshModelsFromPi(source.models);
	if (models) profile.models = models;
	if (officialDeepseek) {
		profile.apiKeyEnv = "DEEPSEEK_API_KEY";
	} else {
		profile.displayName = name;
		profile.apiKeyEnv = credentialRefFor(undefined, name);
	}
	return {
		name: officialDeepseek ? "deepseek" : name,
		namespace: officialDeepseek ? "llm-deepseek" : "llm-pi-ai",
		profile,
		apiKey: source.apiKey?.trim() || undefined,
	};
}

export function dshToPiSnapshot(source: DshProviderSnapshot): PiProviderSnapshot {
	const profile = source.profile;
	const baseUrl = source.namespace === "llm-deepseek"
		? (profile.baseURL?.trim() || DEEPSEEK_DEFAULT_BASE)
		: profile.baseURL?.trim();
	return {
		name: source.name.trim(),
		baseUrl,
		api: profile.api?.trim() || "openai-completions",
		apiKey: source.apiKey?.trim() || undefined,
		headers: profile.headers,
		models: piModelsFromDsh(profile.models),
	};
}

export function parseDshSettingsDocument(raw: unknown): {
	piAi: Record<string, DshProviderProfile>;
	deepseek?: DshProviderProfile;
} {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { piAi: {} };
	}
	const root = raw as Record<string, unknown>;
	const piAiRoot = root["llm-pi-ai"];
	const providers = piAiRoot && typeof piAiRoot === "object" && !Array.isArray(piAiRoot)
		? (piAiRoot as { providers?: unknown }).providers
		: undefined;
	const piAi: Record<string, DshProviderProfile> = {};
	if (providers && typeof providers === "object" && !Array.isArray(providers)) {
		for (const [name, value] of Object.entries(providers)) {
			if (!isSafeProviderName(name)) continue;
			piAi[name] = normalizeDshProfile(value);
		}
	}
	const deepseekRaw = root["llm-deepseek"];
	return {
		piAi,
		deepseek: deepseekRaw && typeof deepseekRaw === "object" && !Array.isArray(deepseekRaw)
			? normalizeDshProfile(deepseekRaw)
			: undefined,
	};
}

function normalizeDshModels(value: unknown): DshProviderProfile["models"] {
	if (!Array.isArray(value)) return undefined;
	const models: NonNullable<DshProviderProfile["models"]> = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const rec = item as Record<string, unknown>;
		const id = typeof rec.id === "string" ? rec.id.trim() : "";
		if (!id) continue;
		const model: NonNullable<DshProviderProfile["models"]>[number] = { id };
		if (typeof rec.name === "string" && rec.name.trim()) model.name = rec.name.trim();
		const contextWindow = asFiniteNumber(rec.contextWindow);
		if (contextWindow !== undefined) model.contextWindow = contextWindow;
		const maxTokens = asFiniteNumber(rec.maxTokens);
		if (maxTokens !== undefined) model.maxTokens = maxTokens;
		const input = asStringList(rec.input);
		if (input) model.input = input;
		if (rec.reasoningEfforts === false) model.reasoningEfforts = false;
		else {
			const reasoningEfforts = asReasoningEfforts(rec.reasoningEfforts);
			if (reasoningEfforts) model.reasoningEfforts = reasoningEfforts;
		}
		models.push(model);
	}
	return models.length > 0 ? models : undefined;
}

function normalizeDshProfile(value: unknown): DshProviderProfile {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const rec = value as Record<string, unknown>;
	const profile: DshProviderProfile = {};
	if (typeof rec.displayName === "string" && rec.displayName.trim()) profile.displayName = rec.displayName.trim();
	if (typeof rec.baseURL === "string" && rec.baseURL.trim()) profile.baseURL = rec.baseURL.trim();
	if (typeof rec.api === "string" && rec.api.trim()) profile.api = rec.api.trim();
	if (typeof rec.apiKeyEnv === "string" && rec.apiKeyEnv.trim()) profile.apiKeyEnv = rec.apiKeyEnv.trim();
	const headers = asStringRecord(rec.headers);
	if (headers) profile.headers = headers;
	const models = normalizeDshModels(rec.models);
	if (models) profile.models = models;
	return profile;
}

/**
 * 把单个 DSH provider 写回 settings 文档对象（只改这一个 key / 官方 DeepSeek 段）。
 * 返回新对象，不原地改入参。
 */
export function mergeDshProviderIntoSettings(
	raw: unknown,
	snapshot: DshProviderSnapshot,
): Record<string, unknown> {
	const root = raw && typeof raw === "object" && !Array.isArray(raw)
		? { ...(raw as Record<string, unknown>) }
		: {};
	if (snapshot.namespace === "llm-deepseek") {
		const current = root["llm-deepseek"] && typeof root["llm-deepseek"] === "object" && !Array.isArray(root["llm-deepseek"])
			? { ...(root["llm-deepseek"] as Record<string, unknown>) }
			: {};
		root["llm-deepseek"] = { ...current, ...snapshot.profile };
		return root;
	}
	const ns = root["llm-pi-ai"] && typeof root["llm-pi-ai"] === "object" && !Array.isArray(root["llm-pi-ai"])
		? { ...(root["llm-pi-ai"] as Record<string, unknown>) }
		: {};
	const providers = ns.providers && typeof ns.providers === "object" && !Array.isArray(ns.providers)
		? { ...(ns.providers as Record<string, unknown>) }
		: {};
	providers[snapshot.name] = { ...snapshot.profile };
	ns.providers = providers;
	root["llm-pi-ai"] = ns;
	return root;
}

export function loadYamlObject(text: string): unknown {
	if (!text.trim()) return {};
	try {
		const parsed = load(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export function dumpYamlObject(value: unknown): string {
	return dump(value ?? {}, {
		lineWidth: -1,
		noRefs: true,
		quotingType: "\"",
		sortKeys: false,
	});
}

/**
 * 合并 .credentials.yaml 的单个 ref；输出始终是 dsh-credentials-local 的
 * v1 官方格式（`{ version: 1, refs: {...} }`）——扁平旧布局已被官方拒绝，
 * 直接写扁平会让 host 启动后读不到（"pre-release flat layout" 报错）。
 * 输入兼容 v1 与扁平两种布局：v1 改 refs 层，扁平则整体迁入 refs。
 */
export function mergeCredentialDocument(text: string, ref: string, value: string): string {
	const parsed = loadYamlObject(text);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		// 空/畸形文档：直接建 v1 文档
		return dumpYamlObject({ version: 1, refs: { [ref]: value } });
	}
	const root = parsed as Record<string, unknown>;
	if (root["version"] === 1 && root["refs"] && typeof root["refs"] === "object" && !Array.isArray(root["refs"])) {
		const refs = { ...(root["refs"] as Record<string, unknown>) };
		refs[ref] = value;
		return dumpYamlObject({
			version: 1,
			refs,
			...(root["records"] && typeof root["records"] === "object" ? { records: root["records"] } : {}),
		});
	}
	// 扁平旧布局：全部 key 视为 ref，整体迁入 refs 层
	const flat = { ...root };
	flat[ref] = value;
	return dumpYamlObject({ version: 1, refs: flat });
}

export function resolvePiApiKey(
	provider: PiProviderConfig | undefined,
	auth: PiAuthItem | undefined,
): string | undefined {
	const inline = typeof provider?.apiKey === "string" ? provider.apiKey.trim() : "";
	if (inline) return inline;
	const fromAuth = typeof auth?.key === "string" ? auth.key.trim() : "";
	if (fromAuth) return fromAuth;
	// OAuth 凭据（type:"oauth"，Codex/xAI/Copilot 等消费者订阅）：access token 就是 pi
	// 会话里实际使用的凭据，用量/余额端点接受同一 Bearer token。放在最后兜底，避免
	// 覆盖有显式 key 的 provider；凭据不完整（无 access）时返回 undefined，由上层快速失败。
	if (auth && typeof auth === "object" && auth.type === "oauth") {
		const access = typeof auth.access === "string" ? auth.access.trim() : "";
		if (access) return access;
	}
	return undefined;
}

export function mergePiProvider(
	models: { providers: Record<string, PiProviderConfig> },
	auth: Record<string, PiAuthItem>,
	snapshot: PiProviderSnapshot,
): {
	models: { providers: Record<string, PiProviderConfig> };
	auth: Record<string, PiAuthItem>;
} {
	const nextModels = {
		providers: {
			...models.providers,
			[snapshot.name]: {
				...(models.providers[snapshot.name] ?? { models: [] }),
				baseUrl: snapshot.baseUrl,
				api: snapshot.api,
				models: snapshot.models,
				...(snapshot.headers ? { headers: snapshot.headers } : {}),
			},
		},
	};
	const nextAuth = { ...auth };
	if (snapshot.apiKey) {
		// 密钥内联写进 models.json，与 PiDeck 配置弹窗 ModelsTab 保持一致
		// （该编辑器只读/写 provider.apiKey，不读 auth.json）。
		// 此前迁移把 key 搬进 auth.json 并从 models.json 删除，导致迁移后
		// Models 页 key 显示为空、字段看似丢失，且编辑器再保存会把空键写回。
		nextModels.providers[snapshot.name] = {
			...nextModels.providers[snapshot.name],
			apiKey: snapshot.apiKey,
		};
	}
	return { models: nextModels, auth: nextAuth };
}
