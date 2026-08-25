import { readFile, writeFile, mkdir } from "node:fs/promises";
import { normalize, join, dirname } from "node:path";
import { dirname as posixDirname, normalize as posixNormalize } from "node:path/posix";
import { homedir } from "node:os";
import { net } from "electron";
import type { ConfigFileDiagnostic, ConfigFileReadResult } from "../../shared/types";
import type { McpConfigFile, McpConfigSnapshot, McpProbeResult, McpServerDefinition } from "../../shared/types/mcp";
import {
	loadMcpConfigSnapshot,
	mcpDocsUrl,
	probeMcpServer,
	validateMcpConfigFile,
} from "./mcpConfig";
import {
	ensureOpenAiVersionPath,
	needsSessionBaseUrlVersionHint,
	suggestNormalizedBaseUrl,
} from "./baseUrlPath";
import type { WslEnvironment } from "../wsl/WslPaths";
import {
	mainProcessT,
	type MainProcessTranslationKey,
} from "../../shared/i18n/mainProcessCopy";
import type { FetchedModel } from "../../shared/types/fetchedModel";
import type { ProviderUsageResult } from "../../shared/types/providerUsage";
import { parseProviderModelsResponse } from "./parseProviderModels";
import { isSafeProviderName } from "./providerMigration";
import {
	buildProbeHeaders,
	candidateApplies,
	parseUsageResponseBody,
	USAGE_PROBE_CANDIDATES,
	usageProbeUrls,
} from "./providerUsageProbe";
import { loadUserUsageProbes } from "./userUsageProbes";
import {
	enrichFetchedModelFromCatalog,
	getPiAiCatalogIndex,
} from "../pi/piAiBuiltinCatalog";

/** pi 全局配置目录：~/.pi/agent/ */
const PI_AGENT_DIR = join(homedir(), ".pi", "agent");

// ── models.json 结构 ──────────────────────────────────
// { providers: { [providerName]: { baseUrl, api, apiKey, models: [...] } } }

// Provider 用量/连接探测面对的是第三方网关，首包可能慢于普通模型；放宽超时避免误判。
const PROVIDER_TEST_TIMEOUT_MS = 45_000;

// 模型 id 长度上限：过长 id 往往是误填，且可能撑爆某些网关/日志。
const MODEL_ID_MAX_LENGTH = 256;

/** 判断字符串是否含控制字符（换行/tab 等），防止配置被注入换行破坏 JSON 语义。 */
function hasControlChar(value: string): boolean {
	// eslint-disable-next-line no-control-regex
	return /[\x00-\x1f\x7f]/.test(value);
}

export type PiModelItem = {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	[key: string]: unknown;
};

export type PiProviderConfig = {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	models: PiModelItem[];
	[key: string]: unknown;
};

export type PiModelsFile = {
	providers: Record<string, PiProviderConfig>;
};

// ── auth.json 结构 ────────────────────────────────────
// { [providerName]: { type: "api_key", key: "..." } }

export type PiAuthItem = {
	type?: string;
	key?: string;
	[key: string]: unknown;
};

export type PiAuthFile = Record<string, PiAuthItem>;

// ── settings.json ─────────────────────────────────────

export type PiSettings = Record<string, unknown>;

export type ConfigValidationResult = {
	valid: boolean;
	error?: string;
	debugDetails?: string;
};

type ConfigCopy = (
	key: MainProcessTranslationKey,
	params?: Record<string, string | number>,
) => string;

type TestRequest = {
	url: string;
	headers: Record<string, string>;
	body?: string;
	method?: "GET" | "POST";
};

/**
 * 管理 pi 全局配置文件（~/.pi/agent/ 下的 models.json、auth.json、settings.json、mcp.json）。
 * 按照 pi 实际文件格式解析：models.json 是嵌套 providers 结构，auth.json 是对象映射。
 */
export class ConfigManager {
	private configDir: string;

	constructor(
		configDir?: string,
		private readonly translate: ConfigCopy = (key, params) => mainProcessT("zh-CN", key, params),
	) {
		this.configDir = configDir ?? PI_AGENT_DIR;
	}

	/** 将配置目录切换到统一解析出的 WSL HOME；null 恢复 Windows home。 */
	configureWsl(environment: WslEnvironment | null) {
		this.configDir = environment
			? join(environment.windowsHome, ".pi", "agent")
			: PI_AGENT_DIR;
	}

	/** 当前 pi 全局配置目录（WSL 环境为 windowsHome 映射），供渲染层展示源文件实际编辑位置。 */
	getConfigDir(): string {
		return this.configDir;
	}

	// ── 读取 ──────────────────────────────────────────────

	async getModelsConfig(): Promise<ConfigFileReadResult<PiModelsFile>> {
		return this.readJsonFile<PiModelsFile>("models.json", { providers: {} });
	}

	async getAuthConfig(): Promise<ConfigFileReadResult<PiAuthFile>> {
		return this.readJsonFile<PiAuthFile>("auth.json", {});
	}

	async getSettingsConfig(): Promise<ConfigFileReadResult<PiSettings>> {
		return this.readJsonFile<PiSettings>("settings.json", {});
	}

	async getTrustConfig(): Promise<ConfigFileReadResult<Record<string, boolean>>> {
		return this.readJsonFile<Record<string, boolean>>("trust.json", {});
	}

	/**
	 * 合并 pi-mcp-adapter 各层 mcp.json；可写层固定为当前 configDir/mcp.json。
	 * projectPath 有值时额外合并项目 `.mcp.json` / `.pi/mcp.json`（只读）。
	 */
	async getMcpConfig(projectPath?: string): Promise<McpConfigSnapshot> {
		return loadMcpConfigSnapshot(this.configDir, projectPath);
	}

	async saveMcpConfig(file: McpConfigFile): Promise<ConfigValidationResult> {
		const error = validateMcpConfigFile(file);
		if (error) return { valid: false, error };
		await this.writeJsonFile("mcp.json", file);
		return { valid: true };
	}

	async probeMcpServer(definition: McpServerDefinition): Promise<McpProbeResult> {
		return probeMcpServer(definition);
	}

	async ensureTrustedDirectory(directoryPath: string): Promise<void> {
		const normalizedPath = this.normalizeTrustPath(directoryPath);
		const trustConfig = await this.getTrustConfig();
		if (trustConfig.diagnostic) return;

		const existingEntry = Object.entries(trustConfig.parsed).find(
			([path]) => this.normalizeTrustPathKey(path) === this.normalizeTrustPathKey(normalizedPath),
		);
		if (existingEntry) return;

		// 若用户已用不同大小写/分隔符写过同一路径，或显式设为 false，则不覆盖，尊重用户的 trust.json 决策。
		await this.writeJsonFile("trust.json", {
			...trustConfig.parsed,
			[normalizedPath]: true,
		});
	}

	/**
	 * 查询某项目目录的信任决策，沿父目录链查找最近记录（复刻 pi 的 findNearestTrustEntry 语义）。
	 * pi 的信任语义是父目录决策继承到子目录，例如 trust.json 记录 "C:\\Users": true，
	 * 则 C:\\Users\\14012\\project 同样视为已信任。返回 true/false；未记录返回 null。
	 */
	async getProjectTrustDecision(cwd: string): Promise<boolean | null> {
		const trustConfig = await this.getTrustConfig();
		if (trustConfig.diagnostic) return null;
		return this.findNearestTrustEntry(trustConfig.parsed, cwd);
	}

	/**
	 * 写入某项目目录的信任决策（覆盖该路径既有值）。
	 * 用户在信任弹窗选择“信任并记住”或“不信任”后调用，持久化决策避免重复打扰。
	 */
	async setProjectTrustDecision(cwd: string, decision: boolean): Promise<void> {
		const trustConfig = await this.getTrustConfig();
		if (trustConfig.diagnostic) return;
		const key = this.normalizeTrustPath(cwd);
		await this.writeJsonFile("trust.json", {
			...trustConfig.parsed,
			[key]: decision,
		});
	}

	/**
	 * 沿父目录链查找最近的信任记录。key 比较统一走 normalizeTrustPathKey，
	 * 与 ensureTrustedDirectory 的去重逻辑保持一致，避免大小写/分隔符差异导致漏查。
	 */
	private findNearestTrustEntry(data: Record<string, boolean>, cwd: string): boolean | null {
		const normalized = new Map<string, boolean>();
		for (const [key, value] of Object.entries(data)) {
			normalized.set(this.normalizeTrustPathKey(key), value);
		}
		let current = this.normalizeTrustPathKey(cwd);
		while (true) {
			const value = normalized.get(current);
			if (value === true || value === false) return value;
			const parent = current.startsWith("/") ? posixDirname(current) : dirname(current);
			if (parent === current) return null;
			current = parent;
		}
	}

	private normalizeTrustPathKey(path: string) {
		const normalized = this.normalizeTrustPath(path).replace(/[\\/]+$/, "");
		return process.platform === "win32" && !normalized.startsWith("/")
			? normalized.toLowerCase()
			: normalized;
	}

	private normalizeTrustPath(path: string) {
		if (!path.startsWith("/")) return normalize(path);
		const normalized = posixNormalize(path);
		return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
	}

	// ── 保存（可视化表单） ────────────────────────────────

	async saveModelsConfig(data: PiModelsFile): Promise<ConfigValidationResult> {
		const validation = this.validateModels(data);
		if (!validation.valid) return validation;
		// 保存前统一迁移历史别名，确保写入 models.json 的 api 名称能被 pi 官方 registry 识别。
		await this.writeJsonFile("models.json", this.normalizeModelsForPi(data));
		return { valid: true };
	}

	async saveAuthConfig(data: PiAuthFile): Promise<ConfigValidationResult> {
		await this.writeJsonFile("auth.json", data);
		return { valid: true };
	}

	async saveSettingsConfig(
		settings: PiSettings,
	): Promise<ConfigValidationResult> {
		await this.writeJsonFile("settings.json", settings);
		return { valid: true };
	}

	// ── 保存（源文件编辑） ────────────────────────────────

	async saveRawConfig(
		fileName: string,
		rawJson: string,
	): Promise<ConfigValidationResult> {
		try {
			JSON.parse(rawJson);
		} catch (e) {
			const debugDetails = e instanceof Error ? e.message : String(e);
			console.error("[ConfigManager] Invalid JSON input", e);
			return {
				valid: false,
				error: this.translate("mainConfig.invalidJson"),
				debugDetails,
			};
		}

		const allowed = ["models.json", "auth.json", "settings.json", "trust.json", "mcp.json"];
		if (fileName === "mcp.json") {
			const parsed = JSON.parse(rawJson) as McpConfigFile;
			const mcpError = validateMcpConfigFile(parsed);
			if (mcpError) return { valid: false, error: mcpError };
		}
		if (!allowed.includes(fileName)) {
			return {
				valid: false,
				error: this.translate("mainConfig.fileNotEditable", { fileName }),
			};
		}

		await this.writeJsonFile(fileName, rawJson);
		return { valid: true };
	}

	// ── 校验 ──────────────────────────────────────────────

	private validateModels(data: PiModelsFile): ConfigValidationResult {
		if (!data.providers || typeof data.providers !== "object") {
			return { valid: false, error: this.translate("mainConfig.modelsProvidersRequired") };
		}
		for (const [providerName, config] of Object.entries(data.providers)) {
			// provider 名做宽松安全校验（防路径穿越/控制字符/超长）；严格白名单
			// （字母开头、无空格特殊字符）只用于前端新增/重命名入口，避免卡历史数据。
			if (!isSafeProviderName(providerName) || hasControlChar(providerName)) {
				return {
					valid: false,
					error: this.translate("mainConfig.providerNameInvalid", { provider: providerName }),
				};
			}
			if (!config.models || !Array.isArray(config.models)) {
				return {
					valid: false,
					error: this.translate("mainConfig.providerModelsRequired", { provider: providerName }),
				};
			}
			// baseUrl 若填写则禁止控制字符（换行等），防止配置被篡改破坏 JSON 语义。
			if (typeof config.baseUrl === "string" && hasControlChar(config.baseUrl)) {
				return {
					valid: false,
					error: this.translate("mainConfig.baseUrlInvalid", { provider: providerName }),
				};
			}
			for (let i = 0; i < config.models.length; i++) {
				const m = config.models[i];
				if (!m.id || typeof m.id !== "string") {
					return {
						valid: false,
						error: this.translate("mainConfig.modelIdRequired", { provider: providerName, index: i + 1 }),
					};
				}
				// 模型 id 允许 / . - _ 等（如 deepseek-ai/DeepSeek-V3.2），仅拒绝控制字符与超长。
				if (hasControlChar(m.id) || m.id.length > MODEL_ID_MAX_LENGTH) {
					return {
						valid: false,
						error: this.translate("mainConfig.modelIdInvalid", { provider: providerName, index: i + 1 }),
					};
				}
			}
		}
		return { valid: true };
	}

	// ── 文件 IO ───────────────────────────────────────────

	private async readJsonFile<T>(
		fileName: string,
		fallback: T,
	): Promise<ConfigFileReadResult<T>> {
		const filePath = join(this.configDir, fileName);
		try {
			const raw = await readFile(filePath, "utf8");
			try {
				const parsed = JSON.parse(raw) as T;
				return { raw, parsed };
			} catch (error) {
				// 配置 JSON 写错时，配置弹窗仍要能打开 Raw 页让用户修复；同时返回精确诊断用于 UI 提示。
				return {
					raw,
					parsed: fallback,
					diagnostic: this.createJsonDiagnostic(fileName, raw, error),
				};
			}
		} catch {
			return { raw: JSON.stringify(fallback, null, 2), parsed: fallback };
		}
	}

	private createJsonDiagnostic(
		fileName: string,
		raw: string,
		error: unknown,
	): ConfigFileDiagnostic {
		const message = error instanceof Error ? error.message : String(error);
		const positionMatch = message.match(/position\s+(\d+)/i);
		const position = positionMatch ? Number(positionMatch[1]) : undefined;
		let line: number | undefined;
		let column: number | undefined;
		let snippet: string | undefined;
		if (Number.isFinite(position)) {
			const before = raw.slice(0, position);
			const lines = before.split(/\r?\n/);
			line = lines.length;
			column = lines[lines.length - 1].length + 1;
			const rawLines = raw.split(/\r?\n/);
			const start = Math.max(0, line - 2);
			const end = Math.min(rawLines.length, line + 1);
			snippet = rawLines
				.slice(start, end)
				.map((text, index) => `${start + index + 1}: ${text}`)
				.join("\n");
		}
		return {
			fileName,
			message,
			line,
			column,
			snippet,
			docsUrl: this.docsUrlForFile(fileName),
		};
	}

	private docsUrlForFile(fileName: string) {
		if (fileName === "models.json") return "https://pi.dev/docs/latest/models";
		if (fileName === "settings.json") return "https://pi.dev/docs/latest/settings";
		if (fileName === "mcp.json") return mcpDocsUrl();
		return "https://pi.dev/docs/latest/providers";
	}

	private async writeJsonFile(
		fileName: string,
		content: unknown,
	): Promise<void> {
		await mkdir(this.configDir, { recursive: true });
		const filePath = join(this.configDir, fileName);
		const json =
			typeof content === "string" ? content : JSON.stringify(content, null, 2);
		await writeFile(filePath, json, "utf8");
	}

	// ── 远程拉取模型列表 ─────────────────────────────────

	/**
	 * 向 provider 拉取可用模型列表。
	 * 对优先路径尝试失败后自动回退到备选路径，提升对各厂商端点格式差异的容错。
	 */
	async fetchProviderModels(
		baseUrl: string,
		apiKey: string,
		apiType?: string,
		headers?: Record<string, string>,
	): Promise<{
		success: boolean;
		models?: FetchedModel[];
		error?: string;
		debugDetails?: string;
		/** 实际成功/最后一次请求的 URL（脱敏），用于 UI 对比会话侧路径 */
		requestUrl?: string;
		/** 检测侧补了版本路径，而配置 baseUrl 仍是根路径 → 会话可能 404 */
		sessionBaseUrlNeedsVersion?: boolean;
		/** 建议写入配置的 baseUrl（含 /v1 等）；UI 可自动改写 */
		suggestedBaseUrl?: string;
	}> {
		const requests = this.buildModelsRequest(baseUrl, apiKey, apiType, headers);
		let lastError: string | undefined;
		let lastDebugDetails: string | undefined;
		let lastRequestUrl: string | undefined;

		for (const request of requests) {
			lastRequestUrl = this.redactSecret(request.url, apiKey);
			try {
				const controller = new AbortController();
				// 10 秒超时，避免网络不通时长时间卡住
				const timeout = setTimeout(() => controller.abort(), 10_000);

				try {
					// 桌面端配置检测属于 Electron 主进程自身请求；使用 net.fetch 才能走 defaultSession 的代理配置。
					const res = await net.fetch(request.url, {
						method: request.method ?? "GET",
						headers: request.headers,
						signal: controller.signal,
					});

					if (!res.ok) {
						lastDebugDetails = `HTTP ${res.status}: ${res.statusText}`;
						console.warn("[ConfigManager] Provider model list request failed", {
							status: res.status,
							requestUrl: lastRequestUrl,
						});
						lastError = this.translate("mainConfig.fetchModelsFailed");
						continue;
					}

					const body = (await res.json()) as Record<string, unknown>;
					// listing 有容量就用；缺的再按 pi-ai 内置目录精确匹配，仍缺则空着
					const models = this.parseModelsResponse(body, apiType);

					if (models.length === 0) {
						lastError = this.translate("mainConfig.emptyModelList");
						continue;
					}

					// 成功路径若依赖检测侧自动补 /v1，而用户配置仍是根路径，
					// 会话侧会原样用 baseUrl → 返回建议 baseUrl 供 UI 自动改写。
					const sessionBaseUrlNeedsVersion = needsSessionBaseUrlVersionHint(
						baseUrl,
						request.url,
					);
					const suggestedBaseUrl =
						suggestNormalizedBaseUrl(baseUrl, request.url, apiType) ?? undefined;
					return {
						success: true,
						models,
						requestUrl: lastRequestUrl,
						sessionBaseUrlNeedsVersion,
						suggestedBaseUrl,
					};
				} finally {
					clearTimeout(timeout);
				}
			} catch (e) {
				if (e instanceof Error && e.name === "AbortError") {
					lastError = this.translate("mainConfig.fetchTimeout");
				} else {
					console.error("[ConfigManager] Provider model list request failed", e);
					lastError = this.translate("mainConfig.fetchModelsFailed");
				}
			}
		}

		return {
			success: false,
			error: lastError ?? this.translate("mainConfig.fetchModelsFailed"),
			...(lastDebugDetails ? { debugDetails: lastDebugDetails } : {}),
			requestUrl: lastRequestUrl,
			sessionBaseUrlNeedsVersion: needsSessionBaseUrlVersionHint(
				baseUrl,
				lastRequestUrl,
			),
		};
	}


	// ── 快速测试连接 ─────────────────────────────────────

	/**
	 * 向 provider 发送一条最小聊天请求验证 baseUrl、apiKey 和模型是否正常。
	 * 返回测试结果，包含模型名、响应摘要、token 用量和延迟。
	 */
	/**
	 * 根据 API 类型构造获取模型列表的 URL 列表（含优先路径和回退路径）。
	 * fetchProviderModels 会逐条尝试直到成功或全部失败。
	 *
	 * 各厂商获取模型列表的支持情况：
	 *
	 * | API 类型 | 优先路径 | 回退路径 |
	 * |----------|---------|---------|
	 * | OpenAI Chat Completions | /v1/models | /models |
	 * | OpenAI Responses / Codex | /v1/models | /models |
	 * | Anthropic Messages | /v1/models | /models |
	 * | Google Gemini | /v1beta/models | - |
	 * | Mistral Conversations | /v1/models | /models |
	 *
	 * OpenAI 生态（Chat Completions / Responses / Codex / Mistral）统一通过
	 * GET /v1/models 获取模型列表。
	 * 虽然 Anthropic 官方未公开 models 端点，但大部分兼容 Anthropic 协议的
	 * 第三方网关同样支持 /v1/models。优先尝试 /v1/models，再回退到 /models。
	 * Google Gemini 使用独立的 /v1beta/models。
	 */
	private buildModelsRequest(
		baseUrl: string,
		apiKey: string,
		apiType?: string,
		requestHeaders?: Record<string, string>,
	): TestRequest[] {
		const api = this.normalizeApiType(apiType);
		// 与真实会话一致：允许 provider 配置的自定义 headers（含 User-Agent）
		// 覆盖 SDK 默认 UA，保证「获取模型」与「真实会话」走同一套网络形象。
		const extraHeaders = this.normalizeRequestHeaders(requestHeaders);

		if (api === "google-generative-ai") {
			// Google Gemini：使用独立的 v1beta 路径
			const u = baseUrl.replace(/\/+$/, "");
			const needsPrefix = !/[\/]v\d+(alpha|beta)?$/.test(u);
			const versioned = needsPrefix ? `${u}/v1beta` : u;
			return [{
				url: `${versioned}/models?key=${encodeURIComponent(apiKey)}`,
				headers: { "Content-Type": "application/json", ...extraHeaders },
			}];
		}

		if (api === "anthropic-messages") {
			// Anthropic：优先尝试 /v1/models（兼容大部分第三方网关），
			// 再回退到 /models（原生 Anthropic API 或旧实现）
			const u = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
			const headers = this.withAnthropicSdkUserAgent({
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				"Content-Type": "application/json",
				...extraHeaders,
			});
			const primaryUrl = `${u}/v1/models`;
			const fallbackUrl = `${u}/models`;
			return primaryUrl === fallbackUrl
				? [{ url: primaryUrl, headers }]
				: [
					{ url: primaryUrl, headers },
					{ url: fallbackUrl, headers },
				];
		}

		// OpenAI 兼容 API（Chat Completions / Responses / Codex / Mistral）：
		// 优先尝试 ensureVersionPath 补齐后的路径，再回退到原始 baseUrl + /models
		const headers = this.withOpenAiSdkUserAgent({
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			...extraHeaders,
		});
		const u = baseUrl.replace(/\/+$/, "");
		const primaryUrl = `${this.ensureVersionPath(baseUrl)}/models`;
		const fallbackUrl = `${u}/models`;

		return primaryUrl === fallbackUrl
			? [{ url: primaryUrl, headers }]
			: [
				{ url: primaryUrl, headers },
				{ url: fallbackUrl, headers },
			];
	}


	private parseModelsResponse(
		body: Record<string, unknown>,
		apiType?: string,
	): FetchedModel[] {
		const listing = parseProviderModelsResponse(body, this.normalizeApiType(apiType));
		const catalog = getPiAiCatalogIndex();
		return listing.map((model) => enrichFetchedModelFromCatalog(model, catalog));
	}

	private normalizeModelsForPi(data: PiModelsFile): PiModelsFile {
		return {
			...data,
			providers: Object.fromEntries(
				Object.entries(data.providers).map(([name, provider]) => [
					name,
					{
						...provider,
						api: this.normalizeApiType(provider.api),
						models: provider.models.map((model) => ({
							...model,
							api: typeof model.api === "string"
								? this.normalizeApiType(model.api)
								: model.api,
						})),
					},
				]),
			),
		};
	}

	private normalizeApiType(apiType?: string) {
		switch (apiType) {
			case "anthropic":
			case "anthropic-messages":
				return "anthropic-messages";
			case "openai-codex-responses":
				return "openai-codex-responses";
			case "openai-chat-completions":
				// 兼容早期 pi-desktop 暴露过的别名；pi 官方 registry 名称是 openai-completions。
				return "openai-completions";
			case "openai-completions":
			case "openai-responses":
			case "google-generative-ai":
			case "mistral-conversations":
				return apiType;
			default:
				return "openai-completions";
		}
	}

	/**
	 * 确保 OpenAI 兼容 API 的基础 URL 包含 /v1 版本路径。
	 * 仅用于「获取模型列表 / 用量探测」；真实会话走 pi，不会用此补齐。
	 */
	private ensureVersionPath(baseUrl: string): string {
		return ensureOpenAiVersionPath(baseUrl);
	}

	private normalizeRequestHeaders(headers?: Record<string, string>) {
		if (!headers) return {};
		return Object.fromEntries(
			Object.entries(headers).filter(
				([key, value]) =>
					key.trim().length > 0 && typeof value === "string",
			),
		);
	}

	private withOpenAiSdkUserAgent(headers: Record<string, string>) {
		const hasUserAgent = Object.keys(headers).some(
			(key) => key.toLowerCase() === "user-agent",
		);
		// pi 的 openai-responses provider 走 OpenAI JS SDK。部分代理会按 SDK
		// 默认 User-Agent 拦截请求，所以配置检测需要模拟该默认值，避免“检测通过、会话 403”。
		return hasUserAgent ? headers : { ...headers, "User-Agent": "OpenAI/JS 6.26.0" };
	}

	private withAnthropicSdkUserAgent(headers: Record<string, string>) {
		const hasUserAgent = Object.keys(headers).some(
			(key) => key.toLowerCase() === "user-agent",
		);
		// pi 的 anthropic-messages provider 走 Anthropic SDK。部分服务会验证
		// User-Agent 避免非官方客户端，所以需要模拟 SDK 的默认值。
		return hasUserAgent ? headers : { ...headers, "User-Agent": "anthropic-sdk-typescript/0.27.3" };
	}

	private redactSecret(value: string, apiKey: string) {
		if (!apiKey) return value;
		return value.split(apiKey).join("***");
	}

	// ── 导出 / 导入 ───────────────────────────────────────

	/** 将 pi 配置文件打包为单个 JSON 对象，便于用户备份和迁移。 */
	async exportConfig(): Promise<string> {
		const [models, auth, settings, mcp] = await Promise.all([
			this.readJsonFile<PiModelsFile>("models.json", { providers: {} }),
			this.readJsonFile<PiAuthFile>("auth.json", {}),
			this.readJsonFile<PiSettings>("settings.json", {}),
			this.readJsonFile<McpConfigFile>("mcp.json", { mcpServers: {} }),
		]);
		return JSON.stringify(
			{
				version: 1,
				exportedAt: new Date().toISOString(),
				files: {
					"models.json": models.parsed,
					"auth.json": auth.parsed,
					"settings.json": settings.parsed,
					"mcp.json": mcp.parsed,
				},
			},
			null,
			2,
		);
	}

	/** 从导出的 JSON 包恢复配置文件，返回导入结果。 */
	async importConfig(
		packageJson: string,
	): Promise<ConfigValidationResult> {
		let pkg: unknown;
		try {
			pkg = JSON.parse(packageJson);
		} catch (e) {
			const debugDetails = e instanceof Error ? e.message : String(e);
			console.error("[ConfigManager] Invalid configuration import JSON", e);
			return {
				valid: false,
				error: this.translate("mainConfig.invalidJson"),
				debugDetails,
			};
		}
		const data = pkg as Record<string, unknown>;
		const files = data.files as Record<string, unknown> | undefined;
		if (!files || typeof files !== "object") {
			return { valid: false, error: this.translate("mainConfig.importFilesRequired") };
		}

		// 按需写入已知文件；mcp.json 走 adapter 校验，避免脏包覆盖可写层。
		const allowed: Array<[string, string]> = [
			["models.json", "models.json"],
			["auth.json", "auth.json"],
			["settings.json", "settings.json"],
		];
		for (const [key, fileName] of allowed) {
			if (files[key] != null) {
				await this.writeJsonFile(fileName, files[key]);
			}
		}
		if (files["mcp.json"] != null) {
			const mcpFile = files["mcp.json"] as McpConfigFile;
			const mcpError = validateMcpConfigFile(mcpFile);
			if (mcpError) return { valid: false, error: mcpError };
			await this.writeJsonFile("mcp.json", mcpFile);
		}
		return { valid: true };
	}

	/**
	 * 查询 provider 用量/余额（内置候选 + 用户自定义探针）。
	 *
	 * 设计：内置候选表（USAGE_PROBE_CANDIDATES）+ 用户探针文件（~/.pi/agent/usage-probes.json）
	 * 合并后，按 baseUrl/apiType 匹配适用候选，逐个尝试探测 URL；解析成功的第一个结果即返回。
	 * 全部失败时返回结构化错误，并对响应做密钥脱敏，避免把 token 回传给渲染层。
	 * 新增内置 provider 在 providerUsageProbe 登记；用户自定义无需改代码，直接写 JSON。
	 */
	async fetchProviderUsage(
		baseUrl: string,
		apiKey: string,
		apiType?: string,
		requestHeaders?: Record<string, string>,
	): Promise<ProviderUsageResult> {
		const api = this.normalizeApiType(apiType);
		const extraHeaders = this.normalizeRequestHeaders(requestHeaders);
		const startedAt = Date.now();

		// 用户自定义探针每次读盘合并（用量查询低频，换取改完立刻生效）。
		const userProbes = await loadUserUsageProbes(this.configDir);
		for (const error of userProbes.errors) {
			console.warn("[ConfigManager] 用户用量探针配置被忽略：", error);
		}

		// 过滤出适用于此 provider 的候选端点（内置在前，用户探针追加在后）。
		const applicable = [...USAGE_PROBE_CANDIDATES, ...userProbes.candidates].filter((c) =>
			candidateApplies(c, baseUrl, api),
		);
		if (applicable.length === 0) {
			return {
				success: false,
				error: this.translate("mainConfig.providerUsageUnsupported"),
			};
		}

		// 无 key 时只可能 401，快速失败并给出提示。
		if (!apiKey) {
			return { success: false, error: this.translate("mainConfig.providerUsageNoKey") };
		}

		// 逐候选、逐 URL 尝试；命中的首个成功即返回。
		for (const candidate of applicable) {
			const urls = usageProbeUrls(candidate, baseUrl, (url) =>
				this.ensureVersionPath(url),
			);
			for (const requestUrl of urls) {
				const controller = new AbortController();
				const timeout = setTimeout(
					() => controller.abort(),
					PROVIDER_TEST_TIMEOUT_MS,
				);
				try {
					const res = await net.fetch(requestUrl, {
						method: candidate.method ?? "GET",
						headers: this.withOpenAiSdkUserAgent({
							...buildProbeHeaders(candidate.headers, apiKey),
							...extraHeaders,
						}),
						...(candidate.method === "POST" && candidate.body !== undefined
							? { body: JSON.stringify(candidate.body) }
							: {}),
						signal: controller.signal,
					});
					const raw = await res.text();
					const safeRaw = this.redactSecret(raw, apiKey);
					if (!res.ok) {
						// 非 2xx：可能是端点不存在，换下一个 URL/候选继续。
						continue;
					}
					let body: unknown;
					try {
						body = JSON.parse(raw);
					} catch {
						body = null;
					}
					const parsed = parseUsageResponseBody(body, safeRaw, candidate.parse);
					if (parsed.matched) {
						return {
							success: true,
							kind: parsed.kind,
							periods: parsed.periods,
							balance: parsed.balance,
							credits: parsed.credits,
							at: startedAt,
						};
					}
					// 2xx 但结构不匹配：不是预期的 usage 端点，继续探测。
				} finally {
					clearTimeout(timeout);
				}
			}
		}

		return {
			success: false,
			error: this.translate("mainConfig.providerUsageFailed"),
		};
	}
}
