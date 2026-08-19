import type { AppSettings } from "../../shared/types";
import type { SessionProxyMode, SessionProxyOverride } from "../../shared/types/session";

/**
 * 会话级代理策略（纯函数，可单测）。
 *
 * 背景：pi 代理与 DSH host 的代理本质上都是「子进程 spawn 时的环境变量注入」，
 * 但两者粒度不同——pi 每个会话一个子进程，可以按会话覆盖；DSH 是单一共享 host
 * 进程（所有 DSH 会话共用），只能做 host 级聚合（用户确认的降级方案，不保证
 * dsh host 内部读取这些 env，见 DshHost 装配处注释）。本模块只输出策略结果，
 * 环境变量注入由 PiProcess / DshHost 各自执行。
 */

/** 标准 HTTP(S)/ALL 代理环境变量（大小写双份，覆盖 linux/mac/windows 工具链）。 */
export const PROXY_ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
] as const;

/** 代理绕过（NO_PROXY）环境变量。 */
export const PROXY_BYPASS_ENV_KEYS = ["NO_PROXY", "no_proxy"] as const;

/** DSH host fork env patch：set 为注入键值，unset 为从继承环境剥离的键。 */
export type HostProxyEnvPatch = {
	set: Partial<Record<(typeof PROXY_ENV_KEYS)[number] | (typeof PROXY_BYPASS_ENV_KEYS)[number], string>>;
	unset: Array<(typeof PROXY_ENV_KEYS)[number] | (typeof PROXY_BYPASS_ENV_KEYS)[number]>;
};

export type PiProxyModeSettings = Pick<AppSettings, "piProxyEnabled" | "piProxyUrl">;

/**
 * 把会话级覆盖应用到 pi 子进程设置。仅调整 piProxyEnabled 开关：
 * on → 强制开启（URL 仍复用全局 piProxyUrl）；off → 强制关闭；follow/缺省 → 原样。
 * 不返回新对象时（follow/无设置），调用方应直接复用原 settings。
 * 泛型保留 settings 的完整类型（如 PiProcessSettings），调用方无需收窄。
 */
export function applyPiProxyMode<T extends PiProxyModeSettings>(
	settings: T | undefined,
	mode: SessionProxyMode | undefined,
): T | undefined {
	if (!settings || mode === undefined || mode === "follow") return settings;
	if (mode === "on") {
		// on 但全局 URL 为空时保留开启位：applyPiProxyEnv 会因空 URL 直接放行（直连），
		// 具体告警由 PiProcess spawn 侧记录（本模块保持纯函数、不写日志）。
		return { ...settings, piProxyEnabled: true };
	}
	return { ...settings, piProxyEnabled: false };
}

/**
 * DSH host 级代理模式聚合：共享 host 无法按会话隔离，只能取所有 DSH 会话覆盖的并集。
 * 冲突规则：off（强制直连）优先于 on——直连是安全默认（不会因代理配置错误而全断），
 * 显式「直连」表达了用户的最强意图；任一 off → host 剥离代理 env；无 off 但任一
 * on → host 注入全局代理；全部 follow/无覆盖 → 沿用当前行为（不动）。
 */
export function aggregateDshProxyMode(
	overrides: ReadonlyArray<SessionProxyOverride | undefined>,
): SessionProxyMode {
	let forcedOn = false;
	for (const override of overrides) {
		if (!override) continue;
		// off 是「必须直连」，一票否决（先于 on 判断）。
		if (override.mode === "off") return "off";
		if (override.mode === "on") forcedOn = true;
	}
	return forcedOn ? "on" : "follow";
}

/**
 * 由聚合模式 + 全局代理配置生成 DSH host fork env patch。
 * - on：注入全局 URL（URL 为空时无法代理，返回 undefined 表示不动，等用户先配 URL）；
 * - off：剥离标准代理环境变量（含 NO_PROXY，避免残留配置互相干扰）；
 * - follow：undefined（不动，保持 dsh host 现有行为）。
 */
export function buildHostProxyEnvPatch(
	mode: SessionProxyMode,
	global: { url: string; bypass: string },
): HostProxyEnvPatch | undefined {
	if (mode === "off") {
		return {
			set: {},
			unset: [...PROXY_ENV_KEYS, ...PROXY_BYPASS_ENV_KEYS],
		};
	}
	if (mode === "on") {
		const url = global.url.trim();
		if (!url) return undefined;
		const set: HostProxyEnvPatch["set"] = {};
		for (const key of PROXY_ENV_KEYS) set[key] = url;
		const bypass = global.bypass.trim();
		if (bypass) {
			for (const key of PROXY_BYPASS_ENV_KEYS) set[key] = bypass;
		}
		// 同键还需从继承环境剥离旧值，避免场景：上次 session off 清掉了键，
		// 但用户系统环境本身带 HTTP_PROXY，这里 set 覆盖即可，无需 unset。
		return { set, unset: [] };
	}
	return undefined;
}

/** 把 patch 应用到已构建的 fork env（原地修改）：先剥离后注入，顺序固定。 */
export function applyProxyEnvPatch(
	env: Record<string, string>,
	patch: HostProxyEnvPatch,
): void {
	for (const key of patch.unset) delete env[key];
	for (const [key, value] of Object.entries(patch.set)) {
		if (value !== undefined) env[key] = value;
	}
}