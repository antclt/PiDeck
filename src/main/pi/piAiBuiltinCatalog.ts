/**
 * pi-ai 内置模型目录索引（替代 resources/model-specs.db）。
 *
 * 只读 `@earendil-works/pi-ai` 生成的 JSON catalog，不实例化 Provider /
 * 不拉 AWS/OpenAI SDK。匹配规则对齐 dsh-web 的「catalog 有就用」，
 * 并对中转站做跨 provider 的 id 精确匹配（含大小写、路径尾段），
 * 不做 contains 模糊匹配——命不中就空着，避免短前缀误填。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelSpec } from "../../shared/types/modelSpecs";
import type { FetchedModel } from "../../shared/types/fetchedModel";

/** 目录里一条模型的补全字段（比 FetchedModel 多 provider，供同名歧义消解） */
export type PiAiCatalogEntry = FetchedModel & {
	provider?: string;
	/** pi-ai 内置 provider 的 API 协议（如 "openai-completions"）与默认端点；
	 *  迁移反向（pi→DSH）时用来补全内置 provider 的 profile。仅在 catalog 条目提供时存在。 */
	api?: string;
	baseUrl?: string;
};

export type PiAiCatalogIndex = {
	/** 精确 id → 同 id 的全部条目（网关会复用官方 id） */
	byId: Map<string, PiAiCatalogEntry[]>;
	/** 小写 id → 同上 */
	byIdLower: Map<string, PiAiCatalogEntry[]>;
	/** provider → id → 条目（dsh catalogModels(provider) 的精确路径） */
	byProviderId: Map<string, Map<string, PiAiCatalogEntry>>;
};

/** 正整数容量；listing / catalog 里 0、小数、非数字一律视为未提供 */
export function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

function pushIndex(map: Map<string, PiAiCatalogEntry[]>, key: string, entry: PiAiCatalogEntry): void {
	const list = map.get(key);
	if (list) list.push(entry);
	else map.set(key, [entry]);
}

/**
 * 从扁平条目构建内存索引。条目通常来自 pi-ai `dist/providers/data/*.json`。
 */
export function buildPiAiCatalogIndex(entries: readonly PiAiCatalogEntry[]): PiAiCatalogIndex {
	const byId = new Map<string, PiAiCatalogEntry[]>();
	const byIdLower = new Map<string, PiAiCatalogEntry[]>();
	const byProviderId = new Map<string, Map<string, PiAiCatalogEntry>>();
	for (const entry of entries) {
		const id = entry.id.trim();
		if (!id) continue;
		pushIndex(byId, id, entry);
		pushIndex(byIdLower, id.toLowerCase(), entry);
		const provider = entry.provider?.trim();
		if (!provider) continue;
		let inner = byProviderId.get(provider);
		if (!inner) {
			inner = new Map();
			byProviderId.set(provider, inner);
		}
		// 同一 provider 重复 id 保留第一条（生成 catalog 按 id 唯一）
		if (!inner.has(id)) inner.set(id, entry);
	}
	return { byId, byIdLower, byProviderId };
}

/** OpenAI 兼容网关常把官方 id 写成 `openai/gpt-4o`；取最后一段做二次精确匹配 */
export function modelIdTail(modelId: string): string {
	const trimmed = modelId.trim();
	const slash = trimmed.lastIndexOf("/");
	if (slash >= 0 && slash < trimmed.length - 1) return trimmed.slice(slash + 1);
	return trimmed;
}

/**
 * 同 id 多条时优先本 provider，其次带 contextWindow 的条目。
 * 网关（opencode / copilot）会复用官方 id，容量通常一致。
 */
function pickEntry(
	candidates: readonly PiAiCatalogEntry[] | undefined,
	providerName: string,
): PiAiCatalogEntry | undefined {
	if (!candidates || candidates.length === 0) return undefined;
	if (candidates.length === 1) return candidates[0];
	const named = candidates.find((entry) => entry.provider === providerName);
	if (named) return named;
	return candidates.find((entry) => entry.contextWindow != null) ?? candidates[0];
}

function lookupExact(index: PiAiCatalogIndex, providerName: string, modelId: string): PiAiCatalogEntry | undefined {
	const named = index.byProviderId.get(providerName)?.get(modelId);
	if (named) return named;
	const exact = pickEntry(index.byId.get(modelId), providerName);
	if (exact) return exact;
	return pickEntry(index.byIdLower.get(modelId.toLowerCase()), providerName);
}

/**
 * 按模型 id 查 pi-ai 目录。顺序：本 provider 精确 → 全局精确 → 大小写 → 路径尾段。
 * 不做子串/前缀模糊匹配。
 */
export function lookupPiAiCatalogEntry(
	index: PiAiCatalogIndex,
	providerName: string,
	modelId: string,
): PiAiCatalogEntry | undefined {
	const id = modelId.trim();
	if (!id) return undefined;
	const direct = lookupExact(index, providerName, id);
	if (direct) return direct;
	const tail = modelIdTail(id);
	if (tail !== id) return lookupExact(index, providerName, tail);
	return undefined;
}

export function catalogEntryToSpec(entry: PiAiCatalogEntry): ModelSpec {
	const spec: ModelSpec = {
		source: "pi-ai",
		matchedId: entry.id,
	};
	if (entry.contextWindow != null) spec.contextWindow = entry.contextWindow;
	if (entry.maxTokens != null) spec.maxTokens = entry.maxTokens;
	if (entry.reasoning === true) spec.reasoning = true;
	if (entry.input?.includes("image")) spec.images = true;
	return spec;
}

export function lookupPiAiModelSpec(
	index: PiAiCatalogIndex,
	providerName: string,
	modelId: string,
): ModelSpec | undefined {
	const entry = lookupPiAiCatalogEntry(index, providerName, modelId);
	return entry ? catalogEntryToSpec(entry) : undefined;
}

type CatalogJsonModel = {
	id?: unknown;
	name?: unknown;
	provider?: unknown;
	contextWindow?: unknown;
	maxTokens?: unknown;
	reasoning?: unknown;
	input?: unknown;
	/** 模型级 API 协议与默认端点（某些 provider 的模型条目内联提供）。 */
	api?: unknown;
	baseUrl?: unknown;
};

/**
 * 定位 pi-ai 生成目录 JSON。
 * 主进程是 CJS，而 `@earendil-works/pi-ai` 的 exports 只有 `import` 条件，
 * `require.resolve("@earendil-works/pi-ai/providers/all")` 会 ERR_PACKAGE_PATH_NOT_EXPORTED。
 * 从 __dirname / cwd 向上找 node_modules 物理路径，不实例化 SDK。
 */
export function resolvePiAiCatalogDataDir(): string | undefined {
	const roots = [
		typeof __dirname === "string" ? __dirname : "",
		process.cwd(),
		// 打包后主进程在 app.asar/out/main；asar 内 node_modules 与 resources 旁路都试一次
		typeof process.resourcesPath === "string" ? process.resourcesPath : "",
	].filter(Boolean);
	for (const root of roots) {
		let dir = root;
		for (let i = 0; i < 12; i++) {
			const nested = join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data");
			if (existsSync(nested)) return nested;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return undefined;
}

export function loadPiAiCatalogEntries(): PiAiCatalogEntry[] {
	try {
		const dataDir = resolvePiAiCatalogDataDir();
		if (!dataDir) {
			console.error("[pi-ai-catalog] builtin data dir not found");
			return [];
		}
		const files = readdirSync(dataDir).filter(
			(name) => name.endsWith(".json") && !name.startsWith("."),
		);
		const entries: PiAiCatalogEntry[] = [];
		for (const file of files) {
			const raw = JSON.parse(readFileSync(join(dataDir, file), "utf8")) as Record<
				string,
				Record<string, CatalogJsonModel>
			>;
			for (const group of Object.values(raw)) {
				if (!group || typeof group !== "object") continue;
				for (const model of Object.values(group)) {
					const id = typeof model.id === "string" ? model.id.trim() : "";
					if (!id) continue;
					const name = typeof model.name === "string" && model.name.length > 0 ? model.name : undefined;
					const provider =
						typeof model.provider === "string" && model.provider.length > 0
							? model.provider
							: undefined;
					const contextWindow = positiveInt(model.contextWindow);
					const maxTokens = positiveInt(model.maxTokens);
					const reasoning = model.reasoning === true ? true : undefined;
					const input = Array.isArray(model.input)
						? model.input.filter((item): item is string => typeof item === "string")
						: undefined;
					const api =
						typeof model.api === "string" && model.api.length > 0 ? model.api : undefined;
					const baseUrl =
						typeof model.baseUrl === "string" && model.baseUrl.length > 0 ? model.baseUrl : undefined;
					entries.push({
						id,
						...(name ? { name } : {}),
						...(provider ? { provider } : {}),
						...(contextWindow != null ? { contextWindow } : {}),
						...(maxTokens != null ? { maxTokens } : {}),
						...(reasoning ? { reasoning } : {}),
						...(input && input.length > 0 ? { input } : {}),
						...(api ? { api } : {}),
						...(baseUrl ? { baseUrl } : {}),
					});
				}
			}
		}
		return entries;
	} catch (error) {
		console.error("[pi-ai-catalog] failed to load builtin models", error);
		return [];
	}
}

let cachedIndex: PiAiCatalogIndex | undefined;

/** 进程内单例索引；测试可 resetPiAiCatalogIndexForTests() */
export function getPiAiCatalogIndex(): PiAiCatalogIndex {
	cachedIndex ??= buildPiAiCatalogIndex(loadPiAiCatalogEntries());
	return cachedIndex;
}

/** 仅单测：注入索引或清缓存 */
export function resetPiAiCatalogIndexForTests(index?: PiAiCatalogIndex): void {
	cachedIndex = index;
}

/** 用 catalog 填 listing 没给的空字段；已有 listing 值不覆盖 */
export function enrichFetchedModelFromCatalog(
	model: FetchedModel,
	index: PiAiCatalogIndex,
	providerName = "",
): FetchedModel {
	const entry = lookupPiAiCatalogEntry(index, providerName, model.id);
	if (!entry) return model;
	const next: FetchedModel = { ...model };
	if (next.contextWindow == null && entry.contextWindow != null) {
		next.contextWindow = entry.contextWindow;
	}
	if (next.maxTokens == null && entry.maxTokens != null) {
		next.maxTokens = entry.maxTokens;
	}
	if (next.reasoning == null && entry.reasoning === true) {
		next.reasoning = true;
	}
	if (next.input == null && entry.input && entry.input.length > 0) {
		next.input = entry.input;
	}
	if ((next.name == null || next.name === next.id) && entry.name && entry.name !== entry.id) {
		next.name = entry.name;
	}
	return next;
}

