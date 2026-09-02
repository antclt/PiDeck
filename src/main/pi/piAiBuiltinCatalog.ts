/**
 * pi-ai 内置模型目录索引（替代 resources/model-specs.db）。
 *
 * 构建期由 scripts/generate-pi-ai-catalog.mjs 从 pi-ai provider JSON 提取 artifact；
 * 运行时只读 resources/pi-ai-catalog*.json，不实例化 Provider、不拉 AWS/OpenAI SDK，
 * 也不依赖 node_modules 中的 pi-ai 版本。匹配规则对齐 dsh-web 的「catalog 有就用」，
 * 并对中转站做跨 provider 的 id 精确匹配（含大小写、路径尾段），
 * 不做 contains 模糊匹配——命不中就空着，避免短前缀误填。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FetchedModel } from "../../shared/types/fetchedModel";
import { parseThinkingLevelMap } from "./modelCapabilityMatch";

/** 目录里一条模型的补全字段（比 FetchedModel 多 provider，供同名歧义消解） */
export type PiAiCatalogEntry = FetchedModel & {
	provider?: string;
	/** pi-ai 内置 provider 的 API 协议（如 "openai-completions"）与默认端点；
	 *  迁移反向（pi→DSH）时用来补全内置 provider 的 profile。仅在 catalog 条目提供时存在。 */
	api?: string;
	baseUrl?: string;
};

export type PiAiCatalogIndex = {
	/** 保留扁平可信条目，供第三方别名匹配和能力卡片候选使用。 */
	entries: readonly PiAiCatalogEntry[];
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
	return { entries: [...entries], byId, byIdLower, byProviderId };
}

export function getPiAiCatalogEntries(index: PiAiCatalogIndex): readonly PiAiCatalogEntry[] {
	return index.entries;
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

export const PI_AI_CATALOG_SCHEMA_VERSION = 1;
export const PI_AI_CATALOG_FILE_NAME = "pi-ai-catalog.json";
export const PI_AI_CATALOG_MANIFEST_FILE_NAME = "pi-ai-catalog.manifest.json";

export type PiAiCatalogArtifactPaths = {
	catalogPath: string;
	manifestPath: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

// 与旧 runtime loader 一致：只规范化模型 ID；provider/name/baseUrl 保留上游原值，
// 避免在 artifact 边界将精确匹配悄然放宽。
function normalizedModelId(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** artifact 中一条原始模型记录 → 主进程可信条目；防御损坏资源或手工编辑。 */
function catalogEntryFromArtifact(model: Record<string, unknown>): PiAiCatalogEntry | undefined {
	const id = normalizedModelId(model.id);
	if (!id) return undefined;
	const name = nonEmptyString(model.name);
	const provider = nonEmptyString(model.provider);
	const contextWindow = positiveInt(model.contextWindow);
	const maxTokens = positiveInt(model.maxTokens);
	const reasoning = typeof model.reasoning === "boolean" ? model.reasoning : undefined;
	const input = Array.isArray(model.input)
		? model.input.filter((item): item is "text" | "image" => item === "text" || item === "image")
		: undefined;
	const thinkingLevelMap = parseThinkingLevelMap(model.thinkingLevelMap);
	const api = nonEmptyString(model.api);
	const baseUrl = nonEmptyString(model.baseUrl);
	return {
		id,
		...(name ? { name } : {}),
		...(provider ? { provider } : {}),
		...(contextWindow != null ? { contextWindow } : {}),
		...(maxTokens != null ? { maxTokens } : {}),
		...(reasoning !== undefined ? { reasoning } : {}),
		...(input && input.length > 0 ? { input } : {}),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		...(api ? { api } : {}),
		...(baseUrl ? { baseUrl } : {}),
	};
}

function catalogSha256(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function isValidCatalogManifest(manifest: unknown, catalogRaw: string, entryCount: number): boolean {
	if (!isRecord(manifest) || manifest.schemaVersion !== PI_AI_CATALOG_SCHEMA_VERSION) return false;
	if (manifest.catalogSha256 !== catalogSha256(catalogRaw) || manifest.entryCount !== entryCount) return false;
	const source = manifest.source;
	if (!isRecord(source)) return false;
	return source.packageName === "@earendil-works/pi-ai"
		&& typeof source.packageVersion === "string"
		&& source.packageVersion.length > 0
		&& typeof source.dataSha256 === "string"
		&& /^[a-f0-9]{64}$/.test(source.dataSha256)
		&& typeof source.fileCount === "number"
		&& Number.isInteger(source.fileCount)
		&& source.fileCount > 0;
}

/**
 * 解析并验证构建期 artifact。manifest 与 catalog 任一不匹配均返回空，避免损坏
 * 资源静默写入错误模型规格；上层会回退 endpoint /models 或用户手填。
 */
export function parsePiAiCatalogArtifact(catalogRaw: string, manifestRaw: string): PiAiCatalogEntry[] {
	try {
		const artifact: unknown = JSON.parse(catalogRaw);
		if (!isRecord(artifact) || artifact.schemaVersion !== PI_AI_CATALOG_SCHEMA_VERSION || !Array.isArray(artifact.entries)) {
			return [];
		}
		const entries = artifact.entries.flatMap((value) => {
			if (!isRecord(value)) return [];
			const entry = catalogEntryFromArtifact(value);
			return entry ? [entry] : [];
		});
		const manifest: unknown = JSON.parse(manifestRaw);
		return isValidCatalogManifest(manifest, catalogRaw, entries.length) ? entries : [];
	} catch {
		return [];
	}
}

function artifactPathsIn(resourceDir: string): PiAiCatalogArtifactPaths | undefined {
	const catalogPath = join(resourceDir, PI_AI_CATALOG_FILE_NAME);
	const manifestPath = join(resourceDir, PI_AI_CATALOG_MANIFEST_FILE_NAME);
	return existsSync(catalogPath) && existsSync(manifestPath) ? { catalogPath, manifestPath } : undefined;
}

/**
 * 打包态直接读 process.resourcesPath；开发态从 out/main 或 cwd 向上定位项目 resources。
 * 不再扫描 node_modules，保证主进程 catalog 与 DSH 的 pi-ai runtime 依赖完全隔离。
 */
export function resolvePiAiCatalogArtifactPaths(): PiAiCatalogArtifactPaths | undefined {
	const packagedResources = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
	if (packagedResources) {
		const direct = artifactPathsIn(packagedResources);
		if (direct) return direct;
	}
	const roots = [typeof __dirname === "string" ? __dirname : "", process.cwd(), packagedResources].filter(Boolean);
	for (const root of roots) {
		let dir = root;
		for (let index = 0; index < 12; index += 1) {
			const found = artifactPathsIn(join(dir, "resources"));
			if (found) return found;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	return undefined;
}

export function loadPiAiCatalogEntries(paths = resolvePiAiCatalogArtifactPaths()): PiAiCatalogEntry[] {
	try {
		if (!paths) {
			console.error("[pi-ai-catalog] generated artifact not found");
			return [];
		}
		const entries = parsePiAiCatalogArtifact(
			readFileSync(paths.catalogPath, "utf8"),
			readFileSync(paths.manifestPath, "utf8"),
		);
		if (entries.length === 0) console.error("[pi-ai-catalog] generated artifact is invalid or empty");
		return entries;
	} catch (error) {
		console.error("[pi-ai-catalog] failed to load generated artifact", error);
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
