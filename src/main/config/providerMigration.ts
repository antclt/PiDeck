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

/** DSH 模型行只保留目录字段；pi 的 cost/compat/thinking 对端没有对应槽。 */
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
		rows.push(row);
	}
	return rows;
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
	if (Array.isArray(rec.models)) {
		const models = dshModelsFromPi(rec.models as PiModelItem[]);
		if (models) profile.models = models;
	}
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

/** 合并 .credentials.yaml 的单个 ref；空文档当空对象。 */
export function mergeCredentialDocument(text: string, ref: string, value: string): string {
	const parsed = loadYamlObject(text);
	const map = parsed && typeof parsed === "object" && !Array.isArray(parsed)
		? { ...(parsed as Record<string, unknown>) }
		: {};
	map[ref] = value;
	return dumpYamlObject(map);
}

export function resolvePiApiKey(
	provider: PiProviderConfig | undefined,
	auth: PiAuthItem | undefined,
): string | undefined {
	const inline = typeof provider?.apiKey === "string" ? provider.apiKey.trim() : "";
	if (inline) return inline;
	const fromAuth = typeof auth?.key === "string" ? auth.key.trim() : "";
	return fromAuth || undefined;
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
		nextAuth[snapshot.name] = {
			...(nextAuth[snapshot.name] ?? {}),
			type: "api_key",
			key: snapshot.apiKey,
		};
		// 密钥进 auth.json，避免再抄一份到 models.json
		delete nextModels.providers[snapshot.name].apiKey;
	}
	return { models: nextModels, auth: nextAuth };
}
