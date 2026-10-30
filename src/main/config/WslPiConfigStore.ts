/**
 * WslPiConfigStore（P1-1）：一个 WSL 连接档案的 pi 配置目录，按发行版 HOME 读写 models.json / settings.json。
 *
 * 为什么单独一个存储，而不是复用 ConfigManager / RemotePiConfigBackend：
 * - 绝不复用全局 `configManager.configureWsl`：那会改所有窗口的单例 configDir，两个 WSL 目标并发就串环境。
 *   这里每次调用都从档案重新解析，实例之间没有共享可变状态；
 * - 绝不复用 ssh helper：那条通道要走 SSH 会话，WSL 是本机 UNC 路径，混用会把两套失败语义搅在一起；
 * - 绝不回退 Windows HOME：档案缺失、发行版不可达、HOME 不可读都在**读文件之前**回稳定码，
 *   否则「配置页看着是空的」会被用户当成 WSL 配置真的为空，一保存就把发行版里的配置覆盖掉。
 *
 * 读写语义与本地保持一致：
 * - 读：文件不存在 = 新安装（返回空对象）；JSON 损坏 = WSL_CONFIG_FILE_INVALID（不当作空配置）；
 * - 写 models.json：整文件写入，写前跑与本地相同的校验规则；
 * - 写 settings.json：锁外重读磁盘后按 settingsFormPayload 的合并规则落盘（资源类键以磁盘为准）；
 * - 写入用 durable（临时文件 + fsync + rename），中途失败不留半份文件。
 */

import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { WSL_CONFIG_CODES, WSL_CONFIG_CODE_SET, type PiConfigFileKey, type WslPiConfigSnapshot, type WslPiConfigWriteReceipt } from "../../shared/piConfig";
import { PROJECT_HOST_ID_PATTERN } from "../../shared/projectLocation";
import { mainProcessT, type MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import type { WslHostListItem } from "../../shared/types/wslHost";
import { writeDurableJsonFile } from "../persistence/durableJsonStore";
import { linuxPathToWslUnc, parseWslUncPath, type WslEnvironment } from "../wsl/WslPaths";
import { createWslHostStore } from "../wsl/WslHostStore";
import { resolveWslEnvironment } from "../wsl/WslEnvironment";
import { isSafeProviderName } from "./providerMigration";
import { mergeSettingsFormPayload } from "./settingsFormPayload";

/** 与本地 ConfigManager.validateModels 同一组上限（模型 id 超长往往是误填，且会撑爆网关/日志）。 */
const MODEL_ID_MAX_LENGTH = 256;

type WslConfigCopy = (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;

/**
 * 文件系统边界（可注入）：单测用假端口证明「读了哪些路径、失败怎么映射」，
 * 生产用 node 实现（durable 原子写）。三个方法都按「目录不存在返回 null / 其它错误抛出」约定。
 */
export type WslPiConfigFileSystem = {
	statDirectory(path: string): Promise<{ isDirectory: boolean } | null>;
	readTextFile(path: string): Promise<string | null>;
	writeTextFile(path: string, content: string): Promise<void>;
};

export type WslPiConfigStorePorts = {
	/** WslHostStore.list()：每次调用都重新读档案，用户改名/换 distro 后不需要重启。 */
	listProfiles: () => Promise<readonly WslHostListItem[]>;
	/** resolveWslEnvironment(distro, user)：失败时它会静默回退 /home/<user>，所以下面还会用 stat 验证 HOME 真的存在。 */
	resolveEnvironment: (distro: string, user: string) => Promise<WslEnvironment>;
	fs?: WslPiConfigFileSystem;
	translate?: WslConfigCopy;
};

export type WslPiConfigSaveResult = { valid: true; receipt: WslPiConfigWriteReceipt } | { valid: false; error: string };

export type WslPiConfigStore = {
	read(input: { hostId: string; file: PiConfigFileKey }): Promise<WslPiConfigSnapshot>;
	saveModels(input: { hostId: string; data: unknown }): Promise<WslPiConfigSaveResult>;
	saveSettings(input: { hostId: string; settings: Record<string, unknown> }): Promise<WslPiConfigSaveResult>;
};

function stable(code: string): Error {
	return new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 端口抛出的错误若已经是闭集里的稳定码就原样保留，避免把「环境与档案不符」洗成「发行版不可用」。 */
function stableCodeOf(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : "";
	return WSL_CONFIG_CODE_SET.has(message) ? message : undefined;
}

function isMissingFile(error: unknown): boolean {
	const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
	return code === "ENOENT" || code === "ENOTDIR";
}

/** Windows PowerShell 5.1 手写的配置常带 BOM，裸 JSON.parse 会直接失败（与本地读写同一条规则）。 */
function stripBom(raw: string): string {
	return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * models.json 保存校验：规则与本地 ConfigManager.validateModels 一致（provider 名宽松安全校验、
 * models 数组、模型 id 控制字符/长度、baseUrl 控制字符），文案复用同一组 mainConfig.* 词典。
 * 为什么不再抽一份共享实现：ConfigManager 的校验是私有的、且被 tests/configValidateModels.test.mjs
 * 按私有方法直接调用（单文件转译 harness 不认新依赖），抽走会让存量断言变红；规则本身只有这几条。
 */
function validateModelsForSave(data: unknown, translate: WslConfigCopy): { ok: true } | { ok: false; error: string } {
	if (!isRecord(data) || !isRecord(data.providers)) return { ok: false, error: translate("mainConfig.modelsProvidersRequired") };
	for (const [providerName, providerValue] of Object.entries(data.providers)) {
		if (!isSafeProviderName(providerName) || CONTROL_CHARS.test(providerName)) return { ok: false, error: translate("mainConfig.providerNameInvalid", { provider: providerName }) };
		if (!isRecord(providerValue) || !Array.isArray(providerValue.models)) return { ok: false, error: translate("mainConfig.providerModelsRequired", { provider: providerName }) };
		if (typeof providerValue.baseUrl === "string" && CONTROL_CHARS.test(providerValue.baseUrl)) return { ok: false, error: translate("mainConfig.baseUrlInvalid", { provider: providerName }) };
		const models = providerValue.models;
		for (let index = 0; index < models.length; index += 1) {
			const model = models[index];
			if (!isRecord(model) || typeof model.id !== "string" || model.id.length === 0) return { ok: false, error: translate("mainConfig.modelIdRequired", { provider: providerName, index: index + 1 }) };
			if (CONTROL_CHARS.test(model.id) || model.id.length > MODEL_ID_MAX_LENGTH) return { ok: false, error: translate("mainConfig.modelIdInvalid", { provider: providerName, index: index + 1 }) };
		}
	}
	return { ok: true };
}

/** 默认 fs 端口：目录 stat / UTF-8 读 / durable 原子写（临时文件 + fsync + rename，UNC 上同样安全）。 */
export function createNodeWslPiConfigFileSystem(): WslPiConfigFileSystem {
	return {
		async statDirectory(path) {
			try {
				return { isDirectory: (await stat(path)).isDirectory() };
			} catch (error) {
				if (isMissingFile(error)) return null;
				throw error;
			}
		},
		async readTextFile(path) {
			try {
				return await readFile(path, "utf8");
			} catch (error) {
				if (isMissingFile(error)) return null;
				throw error;
			}
		},
		async writeTextFile(path, content) {
			await writeDurableJsonFile(path, content);
		},
	};
}

function fileKeyOf(file: unknown): PiConfigFileKey {
	if (file === "models" || file === "settings") return file;
	throw stable(WSL_CONFIG_CODES.targetInvalid);
}

export function createWslPiConfigStore(ports: WslPiConfigStorePorts): WslPiConfigStore {
	const fs = ports.fs ?? createNodeWslPiConfigFileSystem();
	const translate = ports.translate ?? ((key, params) => mainProcessT("zh-CN", key, params));

	type Resolved = { configDir: string; profile: WslHostListItem };

	/**
	 * 解析一步都不许「乐观成功」：档案 → 发行版 HOME → 目录可访问，全部判定通过才允许读/写文件。
	 * 发行版根用 \\wsl.localhost\<distro> 判定：发行版被注销/9P 不可达时 stat 直接失败，
	 * 而不是等 wsl.exe 超时后把 /home/<user> 当成真的 HOME 去读写。
	 */
	async function resolve(hostId: unknown): Promise<Resolved> {
		if (typeof hostId !== "string" || !PROJECT_HOST_ID_PATTERN.test(hostId)) throw stable(WSL_CONFIG_CODES.targetInvalid);
		let profiles: readonly WslHostListItem[];
		try {
			profiles = await ports.listProfiles();
		} catch {
			throw stable(WSL_CONFIG_CODES.unavailable);
		}
		const profile = profiles.find((item) => item.id === hostId);
		if (!profile) throw stable(WSL_CONFIG_CODES.hostNotFound);

		let environment: WslEnvironment;
		try {
			environment = await ports.resolveEnvironment(profile.distro, profile.user);
		} catch (error) {
			// 端口自己给出的稳定码原样透出（装配层用它表达「解析出的环境与档案对不上」）；
			// 端口意外失败按发行版不可用处理——绝不当成本机目录继续读写。
			throw stable(stableCodeOf(error) ?? WSL_CONFIG_CODES.distroUnavailable);
		}
		if (!isAbsolute(environment.windowsHome)) throw stable(WSL_CONFIG_CODES.unavailable);

		await requireDirectory(linuxPathToWslUnc("/", profile.distro), WSL_CONFIG_CODES.distroUnavailable);
		await requireDirectory(environment.windowsHome, WSL_CONFIG_CODES.pathUnreadable);
		return { configDir: join(environment.windowsHome, ".pi", "agent"), profile };
	}

	async function requireDirectory(path: string, code: string): Promise<void> {
		let stats: { isDirectory: boolean } | null;
		try {
			stats = await fs.statDirectory(path);
		} catch {
			throw stable(code);
		}
		if (!stats?.isDirectory) throw stable(code);
	}

	async function readFileData(path: string, file: PiConfigFileKey): Promise<Record<string, unknown>> {
		let raw: string | null;
		try {
			raw = await fs.readTextFile(path);
		} catch {
			throw stable(WSL_CONFIG_CODES.pathUnreadable);
		}
		if (raw === null) return file === "models" ? { providers: {} } : {};
		let parsed: unknown;
		try {
			parsed = JSON.parse(stripBom(raw));
		} catch {
			throw stable(WSL_CONFIG_CODES.fileInvalid);
		}
		if (!isRecord(parsed)) throw stable(WSL_CONFIG_CODES.fileInvalid);
		return parsed;
	}

	function snapshotOf(profile: WslHostListItem, file: PiConfigFileKey, data: Record<string, unknown>): WslPiConfigSnapshot {
		return { kind: "wsl", hostId: profile.id, file, label: profile.label, distro: profile.distro, user: profile.user, data };
	}

	async function writeConfigFile(path: string, data: Record<string, unknown>): Promise<void> {
		try {
			await fs.writeTextFile(path, `${JSON.stringify(data, null, 2)}\n`);
		} catch {
			throw stable(WSL_CONFIG_CODES.pathUnreadable);
		}
	}

	function receiptOf(profile: WslHostListItem, file: PiConfigFileKey): WslPiConfigWriteReceipt {
		return { kind: "wsl", hostId: profile.id, file };
	}

	return {
		async read(input) {
			const file = fileKeyOf(input.file);
			const { configDir, profile } = await resolve(input.hostId);
			return snapshotOf(profile, file, await readFileData(join(configDir, `${file}.json`), file));
		},
		async saveModels(input) {
			const { configDir, profile } = await resolve(input.hostId);
			const validation = validateModelsForSave(input.data, translate);
			if (!validation.ok) return { valid: false, error: validation.error };
			await writeConfigFile(join(configDir, "models.json"), input.data as Record<string, unknown>);
			return { valid: true, receipt: receiptOf(profile, "models") };
		},
		async saveSettings(input) {
			if (!isRecord(input.settings)) throw stable(WSL_CONFIG_CODES.fileInvalid);
			const { configDir, profile } = await resolve(input.hostId);
			const path = join(configDir, "settings.json");
			// 锁外重读 + 合并：与本地 saveSettingsConfig 一样，资源类键以磁盘为准，
			// 页面的整份快照不能把别处刚写入的 packages/extensions 静默回退。
			const current = await readFileData(path, "settings");
			await writeConfigFile(path, mergeSettingsFormPayload(current, input.settings));
			return { valid: true, receipt: receiptOf(profile, "settings") };
		},
	};
}

/**
 * 装配用默认端口：档案来自 WslHostStore（每次重读），发行版 HOME 走 resolveWslEnvironment。
 * warn 用于暴露 printenv 失败后的兼容回退——回退仍然会被 stat 校验，不会静默假装成功。
 */
export function createWslPiConfigStoreFor(userDataDir: string, options: { warn?: (message: string, details: Record<string, unknown>) => void } = {}): WslPiConfigStore {
	return createWslPiConfigStore({
		listProfiles: async () => (await createWslHostStore(userDataDir)).list(),
		resolveEnvironment: async (distro, user) => {
			const environment = await resolveWslEnvironment(distro, user, options.warn ? { warn: options.warn } : {});
			// 环境与档案必须自洽：解析回退或发行版改名后，宁可拒绝，也不把配置写到另一个发行版目录。
			const unc = parseWslUncPath(environment.windowsHome);
			if (!unc || unc.distro.toLowerCase() !== distro.toLowerCase() || unc.linuxPath !== environment.linuxHome) throw stable(WSL_CONFIG_CODES.unavailable);
			return environment;
		},
	});
}
