/**
 * PiResourceTargetResolver (W1): the only place a resource target becomes a filesystem home.
 *
 * Pure parsing + injected ports: a WSL target is WslHostStore profile -> resolveWslEnvironment -> the
 * distribution HOME as a Windows UNC path (skills/prompts/extensions live under <home>/.pi/agent). It never
 * starts wsl.exe itself and never falls back to the local home: a missing profile, an unreachable distro or an
 * environment that contradicts the profile fails with a stable code before any manager is constructed.
 */

import { isAbsolute } from "node:path";
import { PI_RESOURCE_CODES, type PiResourceTarget } from "../../shared/piConfig";
import type { WslHostListItem } from "../../shared/types/wslHost";
import { parseWslUncPath, type WslEnvironment } from "../wsl/WslPaths";
import { piResourceStableCodeOf, readPiResourceTarget } from "./piResourceTarget";

/** Where a resource request must read/write. cacheKey is the isolation key (hostId + distro + user). */
export type PiResourceTargetResolution =
	| { kind: "local"; cacheKey: "local"; home: string }
	| {
			kind: "wsl";
			cacheKey: string;
			home: string;
			hostId: string;
			label: string;
			distro: string;
			user: string;
			environment: WslEnvironment;
	  };

export type PiResourceTargetResolverPorts = {
	/** WslHostStore.list(): re-read on every resolution so renamed/changed profiles take effect without restart. */
	listProfiles: () => Promise<readonly WslHostListItem[]>;
	/** resolveWslEnvironment(distro, user): the production port also validates UNC shape (see WslPiConfigStoreFor). */
	resolveEnvironment: (distro: string, user: string) => Promise<WslEnvironment>;
	/** Local HOME (Windows home on every platform, matching the rest of the main process). */
	localHome: () => string;
};

export type PiResourceTargetResolver = {
	resolve(target: unknown): Promise<PiResourceTargetResolution>;
};

function stable(code: string): Error {
	return new Error(code);
}

export function createPiResourceTargetResolver(ports: PiResourceTargetResolverPorts): PiResourceTargetResolver {
	async function resolveWsl(hostId: string): Promise<PiResourceTargetResolution> {
		let profiles: readonly WslHostListItem[];
		try {
			profiles = await ports.listProfiles();
		} catch {
			// 档案读不出来就无法证明目标存在：fail closed，不退回本机。
			throw stable(PI_RESOURCE_CODES.unavailable);
		}
		const profile = profiles.find((item) => item.id === hostId);
		if (!profile) throw stable(PI_RESOURCE_CODES.hostNotFound);

		let environment: WslEnvironment;
		try {
			environment = await ports.resolveEnvironment(profile.distro, profile.user);
		} catch (error) {
			// 端口自己给出的稳定码原样透出；意外失败按发行版不可用处理（绝不当成本机目录继续读写）。
			throw stable(piResourceStableCodeOf(error) ?? PI_RESOURCE_CODES.distroUnavailable);
		}
		// 解析出的环境必须与档案自洽：printenv 回退 / 发行版改名 / 非绝对 HOME 时宁可拒绝，
		// 也不把资源管理实例指向另一个发行版或本机目录。
		const unc = parseWslUncPath(environment.windowsHome);
		if (!unc || unc.distro.toLowerCase() !== profile.distro.toLowerCase() || unc.linuxPath !== environment.linuxHome || !isAbsolute(environment.windowsHome)) {
			throw stable(PI_RESOURCE_CODES.unavailable);
		}
		return {
			kind: "wsl",
			cacheKey: `wsl:${profile.id}:${profile.distro}:${profile.user}`,
			home: environment.windowsHome,
			hostId: profile.id,
			label: profile.label,
			distro: profile.distro,
			user: profile.user,
			environment,
		};
	}

	return {
		async resolve(value: unknown): Promise<PiResourceTargetResolution> {
			const target: PiResourceTarget = readPiResourceTarget(value);
			if (target.kind === "local") return { kind: "local", cacheKey: "local", home: ports.localHome() };
			return await resolveWsl(target.hostId);
		},
	};
}
