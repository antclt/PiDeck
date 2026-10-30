/**
 * PiConfigRouter (plan §6.4.1, Batch A + WS2 P1-1): the single decision point behind the existing models/settings
 * config IPC. An absent/local target keeps today's ConfigManager path byte-for-byte; an ssh target routes only to
 * the RemotePiConfigBackend; a wsl target routes only to WslPiConfigStore. Neither remote port can touch
 * ConfigManager, so a failed remote/wsl read cannot silently fall back to local files or local keys.
 *
 * Provider connection tests, model catalog fetches and usage queries are NOT routed here: they are explicitly
 * deferred for every non-local target (ssh and wsl alike), so their handlers call rejectRemotePiConfigTarget and
 * answer the stable PROVIDER_OPERATION_UNSUPPORTED code without any network/helper/wsl.exe request.
 */

import { REMOTE_CONFIG_CODES, WSL_CONFIG_CODES, type PiConfigReadOptions, type PiConfigTarget, type PiConfigWriteOptions } from "../../shared/piConfig";
import type { ConfigFileReadResult } from "../../shared/types";
import type { ConfigValidationResult, PiModelsFile, PiSettings } from "./ConfigManager";
import { readPiConfigReadOptions, readPiConfigTarget, readPiConfigWriteOptions } from "./piConfigTarget";
import type { RemotePiConfigBackend } from "./RemotePiConfigBackend";
import type { WslPiConfigSaveResult, WslPiConfigStore } from "./WslPiConfigStore";

export type PiConfigLocalPorts = {
	getModelsConfig: () => Promise<ConfigFileReadResult<{ providers: Record<string, unknown> }>>;
	getSettingsConfig: () => Promise<ConfigFileReadResult<Record<string, unknown>>>;
	saveModelsConfig: (data: PiModelsFile) => Promise<ConfigValidationResult>;
	saveSettingsConfig: (settings: PiSettings) => Promise<ConfigValidationResult>;
};

export type PiConfigRouterPorts = {
	local: PiConfigLocalPorts;
	remote?: RemotePiConfigBackend;
	/** wsl 目标只走这里；未装配 = fail closed（WSL_CONFIG_UNAVAILABLE），不退回本机。 */
	wsl?: WslPiConfigStore;
};

export type PiConfigReadRoute<T> = { kind: "local"; value: T } | import("../../shared/piConfig").RemotePiConfigSnapshot | import("../../shared/piConfig").WslPiConfigSnapshot;
/** wsl 保存与本地同语义（整文件 + 校验结果），所以它的返回值也带 ConfigValidationResult 的形状。 */
export type PiConfigWriteRoute = { kind: "local"; value: ConfigValidationResult } | { kind: "wsl"; value: WslPiConfigSaveResult } | import("../../shared/piConfig").RemotePiConfigWriteReceipt;

function stable(code: string): Error {
	return new Error(code);
}

/**
 * Reject a non-local target for the explicitly deferred provider operations (testProvider/fetchModels/usage).
 * Absent/local target stays allowed; an ssh- or wsl-shaped target gets the documented stable code before any I/O
 * (a wsl run would execute wsl.exe, which is exactly the "test/usage stays a local provider probe" boundary).
 */
export function rejectRemotePiConfigTarget(value: unknown): void {
	const target = readPiConfigTarget(value);
	if (target.kind !== "local") throw stable(REMOTE_CONFIG_CODES.providerOperationUnsupported);
}

export function createPiConfigRouter(ports: PiConfigRouterPorts) {
	function remoteBackend(): RemotePiConfigBackend {
		if (ports.remote === undefined) throw stable(REMOTE_CONFIG_CODES.unavailable);
		return ports.remote;
	}
	function wslStore(): WslPiConfigStore {
		if (ports.wsl === undefined) throw stable(WSL_CONFIG_CODES.unavailable);
		return ports.wsl;
	}
	function readTarget(options: unknown): PiConfigTarget {
		const parsed: PiConfigReadOptions = readPiConfigReadOptions(options);
		return parsed.target ?? { kind: "local" };
	}
	function writeOptions(options: unknown): PiConfigWriteOptions & { target: PiConfigTarget } {
		const parsed = readPiConfigWriteOptions(options);
		return { ...parsed, target: parsed.target ?? { kind: "local" } };
	}
	function requireSshGuard(options: PiConfigWriteOptions): { expectedVersion: string; patch: Record<string, unknown> } {
		if (typeof options.expectedVersion !== "string" || options.patch === undefined) throw stable(REMOTE_CONFIG_CODES.versionConflict);
		return { expectedVersion: options.expectedVersion, patch: options.patch };
	}

	return {
		async readModels(options?: unknown): Promise<PiConfigReadRoute<ConfigFileReadResult<{ providers: Record<string, unknown> }>>> {
			const target = readTarget(options);
			if (target.kind === "ssh") return await remoteBackend().read({ hostId: target.hostId, file: "models" });
			if (target.kind === "wsl") return await wslStore().read({ hostId: target.hostId, file: "models" });
			return { kind: "local", value: await ports.local.getModelsConfig() };
		},
		async readSettings(options?: unknown): Promise<PiConfigReadRoute<ConfigFileReadResult<Record<string, unknown>>>> {
			const target = readTarget(options);
			if (target.kind === "ssh") return await remoteBackend().read({ hostId: target.hostId, file: "settings" });
			if (target.kind === "wsl") return await wslStore().read({ hostId: target.hostId, file: "settings" });
			return { kind: "local", value: await ports.local.getSettingsConfig() };
		},
		async saveModels(data: PiModelsFile, options?: unknown): Promise<PiConfigWriteRoute> {
			const parsed = writeOptions(options);
			if (parsed.target.kind === "ssh") {
				const guard = requireSshGuard(parsed);
				return await remoteBackend().patch({ hostId: parsed.target.hostId, file: "models", ...guard });
			}
			if (parsed.target.kind === "wsl") return { kind: "wsl", value: await wslStore().saveModels({ hostId: parsed.target.hostId, data }) };
			return { kind: "local", value: await ports.local.saveModelsConfig(data) };
		},
		async saveSettings(data: PiSettings, options?: unknown): Promise<PiConfigWriteRoute> {
			const parsed = writeOptions(options);
			if (parsed.target.kind === "ssh") {
				const guard = requireSshGuard(parsed);
				return await remoteBackend().patch({ hostId: parsed.target.hostId, file: "settings", ...guard });
			}
			if (parsed.target.kind === "wsl") return { kind: "wsl", value: await wslStore().saveSettings({ hostId: parsed.target.hostId, settings: data }) };
			return { kind: "local", value: await ports.local.saveSettingsConfig(data) };
		},
	};
}

export type PiConfigRouter = ReturnType<typeof createPiConfigRouter>;
