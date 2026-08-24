/**
 * pi ↔ DSH 单供应商迁移服务。
 *
 * 读：pi 走 ConfigManager；DSH 只读 $DSH_HOME/settings.yaml + .credentials.yaml，
 * 不启动 host（避免和 dsh-web 抢同一 DSH_HOME）。
 *
 * 写：
 * - 到 pi：合并 models.json / auth.json。
 * - 到 DSH：host 已就绪则走官方 settings.update + credentials.set；
 *   否则磁盘合并 settings.yaml / .credentials.yaml（不为此拉起 host）。
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigManager, PiAuthFile, PiModelsFile, PiProviderConfig } from "./ConfigManager";
import type { DshHost } from "../dsh/DshHost";
import { credentialValueFromDocument, isValidCredentialRef } from "../dsh/dshCredentials";
import {
	credentialRefFor,
	dshToPiSnapshot,
	dumpYamlObject,
	isSafeProviderName,
	loadYamlObject,
	looksLikeOfficialDeepseek,
	mergeCredentialDocument,
	mergeDshProviderIntoSettings,
	mergePiProvider,
	parseDshSettingsDocument,
	piToDshSnapshot,
	resolvePiApiKey,
	type DshProviderProfile,
	type DshProviderSnapshot,
	type MigratableProviderRow,
	type MigrationDirection,
	type PiProviderSnapshot,
} from "./providerMigration";

export type ProviderMigrationPreview = {
	direction: MigrationDirection;
	providers: MigratableProviderRow[];
};

export type ProviderMigrationResult = {
	ok: boolean;
	provider: string;
	direction: MigrationDirection;
	copiedKey: boolean;
	wroteViaHost: boolean;
	error?: string;
};

export type ProviderMigrationDeps = {
	configManager: ConfigManager;
	dshHost: Pick<DshHost, "getHomeDir" | "isHostReady" | "updateSettings" | "setCredential" | "describeSettings" | "readCredentialValue">;
};

function asStringHeaders(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string" && item.length > 0) out[key] = item;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

async function readText(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return "";
	}
}

async function readDshSettings(homeDir: string): Promise<{ rawText: string; parsed: unknown }> {
	const rawText = await readText(join(homeDir, "settings.yaml"));
	return { rawText, parsed: loadYamlObject(rawText) };
}

function listDshRows(
	parsed: ReturnType<typeof parseDshSettingsDocument>,
	piNames: Set<string>,
	hasKey: (namespace: "llm-pi-ai" | "llm-deepseek", name: string, profile: DshProviderProfile) => boolean,
): MigratableProviderRow[] {
	const rows: MigratableProviderRow[] = [];
	if (parsed.deepseek) {
		rows.push({
			name: "deepseek",
			modelCount: parsed.deepseek.models?.length ?? 0,
			hasKey: hasKey("llm-deepseek", "deepseek", parsed.deepseek),
			baseUrl: parsed.deepseek.baseURL,
			namespace: "llm-deepseek",
			targetExists: piNames.has("deepseek"),
		});
	}
	for (const [name, profile] of Object.entries(parsed.piAi)) {
		rows.push({
			name,
			modelCount: profile.models?.length ?? 0,
			hasKey: hasKey("llm-pi-ai", name, profile),
			baseUrl: profile.baseURL,
			namespace: "llm-pi-ai",
			targetExists: piNames.has(name),
		});
	}
	return rows.sort((left, right) => left.name.localeCompare(right.name));
}

export async function previewProviderMigration(
	deps: ProviderMigrationDeps,
	direction: MigrationDirection,
): Promise<ProviderMigrationPreview> {
	const [models, auth, dshDoc] = await Promise.all([
		deps.configManager.getModelsConfig(),
		deps.configManager.getAuthConfig(),
		readDshSettings(deps.dshHost.getHomeDir()),
	]);
	const piProviders = models.parsed.providers ?? {};
	const dshParsed = parseDshSettingsDocument(dshDoc.parsed);
	const dshNames = new Set([
		...Object.keys(dshParsed.piAi),
		...(dshParsed.deepseek ? ["deepseek"] : []),
	]);
	const piNames = new Set(Object.keys(piProviders));

	if (direction === "pi-to-dsh") {
		const providers: MigratableProviderRow[] = Object.entries(piProviders)
			.filter(([name]) => isSafeProviderName(name))
			.map(([name, provider]) => ({
				name,
				modelCount: Array.isArray(provider.models) ? provider.models.length : 0,
				hasKey: Boolean(resolvePiApiKey(provider, auth.parsed[name])),
				baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : undefined,
				targetExists: name === "deepseek" && looksLikeOfficialDeepseek(provider.baseUrl)
					? Boolean(dshParsed.deepseek)
					: dshNames.has(name),
			}))
			.sort((left, right) => left.name.localeCompare(right.name));
		return { direction, providers };
	}

	const credentialText = await readText(join(deps.dshHost.getHomeDir(), ".credentials.yaml"));
	const providers = listDshRows(dshParsed, piNames, (_ns, name, profile) => {
		const ref = credentialRefFor(profile, name);
		// 兼容 dsh-credentials-local v1（version:1 + refs）与旧扁平布局
		const fromFile = Boolean(credentialValueFromDocument(credentialText, ref));
		const fromEnv = typeof process.env[ref] === "string" && (process.env[ref] ?? "").length > 0;
		return fromFile || fromEnv;
	});
	return { direction, providers };
}

async function readPiSnapshot(deps: ProviderMigrationDeps, name: string): Promise<PiProviderSnapshot> {
	const [models, auth] = await Promise.all([
		deps.configManager.getModelsConfig(),
		deps.configManager.getAuthConfig(),
	]);
	const provider = models.parsed.providers[name];
	if (!provider) throw new Error(`pi provider not found: ${name}`);
	return {
		name,
		baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : undefined,
		api: typeof provider.api === "string" ? provider.api : undefined,
		apiKey: resolvePiApiKey(provider, auth.parsed[name]),
		headers: asStringHeaders(provider.headers),
		models: Array.isArray(provider.models) ? provider.models : [],
	};
}

async function readDshSnapshot(deps: ProviderMigrationDeps, name: string): Promise<DshProviderSnapshot> {
	const { parsed } = await readDshSettings(deps.dshHost.getHomeDir());
	const doc = parseDshSettingsDocument(parsed);
	const official = name === "deepseek" && doc.deepseek;
	const profile = official ? doc.deepseek : doc.piAi[name];
	if (!profile) throw new Error(`dsh provider not found: ${name}`);
	const namespace = official ? "llm-deepseek" as const : "llm-pi-ai" as const;
	const ref = credentialRefFor(profile, official ? "deepseek" : name);
	let apiKey: string | undefined;
	try {
		apiKey = await deps.dshHost.readCredentialValue(ref);
	} catch {
		apiKey = undefined;
	}
	return { name: official ? "deepseek" : name, namespace, profile, apiKey };
}

async function writePiSnapshot(deps: ProviderMigrationDeps, snapshot: PiProviderSnapshot): Promise<void> {
	const [models, auth] = await Promise.all([
		deps.configManager.getModelsConfig(),
		deps.configManager.getAuthConfig(),
	]);
	const merged = mergePiProvider(
		{ providers: models.parsed.providers ?? {} },
		auth.parsed,
		snapshot,
	);
	const modelsResult = await deps.configManager.saveModelsConfig(merged.models as PiModelsFile);
	if (!modelsResult.valid) throw new Error(modelsResult.error ?? "failed to save models.json");
	const authResult = await deps.configManager.saveAuthConfig(merged.auth as PiAuthFile);
	if (!authResult.valid) throw new Error(authResult.error ?? "failed to save auth.json");
}

async function writeDshSnapshot(deps: ProviderMigrationDeps, snapshot: DshProviderSnapshot): Promise<boolean> {
	const hostReady = deps.dshHost.isHostReady();
	if (hostReady) {
		const described = await deps.dshHost.describeSettings();
		const view = described.namespaces.find((item) => item.ns === snapshot.namespace);
		if (snapshot.namespace === "llm-deepseek") {
			await deps.dshHost.updateSettings(snapshot.namespace, snapshot.profile as Record<string, unknown>, view?.revision);
		} else {
			const current = view?.value && typeof view.value === "object" && !Array.isArray(view.value)
				? (view.value as { providers?: Record<string, unknown> })
				: {};
			const providers = { ...(current.providers ?? {}) };
			providers[snapshot.name] = snapshot.profile;
			await deps.dshHost.updateSettings(snapshot.namespace, { providers }, view?.revision);
		}
		if (snapshot.apiKey) {
			const ref = credentialRefFor(snapshot.profile, snapshot.namespace === "llm-deepseek" ? "deepseek" : snapshot.name);
			if (!isValidCredentialRef(ref)) throw new Error(`invalid credential ref: ${ref}`);
			await deps.dshHost.setCredential(ref, snapshot.apiKey);
		}
		return true;
	}

	const home = deps.dshHost.getHomeDir();
	const settingsPath = join(home, "settings.yaml");
	const { parsed } = await readDshSettings(home);
	const next = mergeDshProviderIntoSettings(parsed, snapshot);
	await writeFile(settingsPath, dumpYamlObject(next), "utf8");
	if (snapshot.apiKey) {
		const ref = credentialRefFor(snapshot.profile, snapshot.namespace === "llm-deepseek" ? "deepseek" : snapshot.name);
		if (!isValidCredentialRef(ref)) throw new Error(`invalid credential ref: ${ref}`);
		const credPath = join(home, ".credentials.yaml");
		const existing = await readText(credPath);
		await writeFile(credPath, mergeCredentialDocument(existing, ref, snapshot.apiKey), "utf8");
	}
	return false;
}

export async function applyProviderMigration(
	deps: ProviderMigrationDeps,
	direction: MigrationDirection,
	providerName: string,
): Promise<ProviderMigrationResult> {
	if (!isSafeProviderName(providerName)) {
		return { ok: false, provider: String(providerName), direction, copiedKey: false, wroteViaHost: false, error: "invalid provider name" };
	}
	try {
		if (direction === "pi-to-dsh") {
			const source = await readPiSnapshot(deps, providerName);
			const target = piToDshSnapshot(source);
			const wroteViaHost = await writeDshSnapshot(deps, target);
			return { ok: true, provider: providerName, direction, copiedKey: Boolean(target.apiKey), wroteViaHost };
		}
		const source = await readDshSnapshot(deps, providerName);
		const target = dshToPiSnapshot(source);
		await writePiSnapshot(deps, target);
		return { ok: true, provider: providerName, direction, copiedKey: Boolean(target.apiKey), wroteViaHost: false };
	} catch (error) {
		return {
			ok: false,
			provider: providerName,
			direction,
			copiedKey: false,
			wroteViaHost: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** 给测试构造最小 pi provider。 */
export function asPiProvider(partial: Partial<PiProviderConfig> & { models?: PiProviderConfig["models"] }): PiProviderConfig {
	return {
		models: partial.models ?? [],
		...partial,
	};
}
