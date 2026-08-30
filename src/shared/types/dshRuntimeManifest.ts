/**
 * DSH runtime 分发契约（AgentRuntimeProvider 阶段 2）。
 *
 * runtime 是「按需下载、解压到 userData/runtimes/dsh/<runtimeVersion>/ 的
 * @deepseek-ai 依赖包集合」。app 内不再内置这些包，host fork 时
 * `--dsh-node-modules` 指向 runtime 目录的 node_modules（hostEntry 零改动）。
 *
 * 版本耦合的由来：hostEntry 与 DshHost 里的桥代码（dshHostBridge / pideckPluginBridge）
 * 在 app 侧，runtime 侧是 @deepseek-ai/* 包。两侧虽无编译期依赖，但桥协议是
 * 事实上的契约——runtime 不能任意跳版本，所以每个 runtime 都声明它兼容的
 * app 版本区间（minAppVersion / maxAppVersion），由这里的选择逻辑把关。
 *
 * 本文件保持纯类型 + 纯函数（无任何运行时层依赖），主/渲染两侧与 node 单测共享。
 */

/** 清单 schema 版本：结构不兼容变更时 +1，旧 runtime 会被判定为不可用并提示重装。 */
export const DSH_RUNTIME_MANIFEST_SCHEMA = 1;

/** 清单文件名（位于 runtime 目录根，也位于 tarball 内的顶层目录）。 */
export const DSH_RUNTIME_MANIFEST_FILE = "manifest.json";

/** tarball 内的顶层目录名（解压后剥掉这一层）。 */
export const DSH_RUNTIME_ARCHIVE_ROOT = "dsh-runtime";

/** runtime 清单。 */
export type DshRuntimeManifest = {
	schemaVersion: number;
	/** runtime 版本（= dsh 版本，如 0.1.1-rc.2）；同时是解压目录名。 */
	runtimeVersion: string;
	/** 产出该 runtime 的 PiDeck 版本，便于排查「哪个 app 版本打的」。 */
	builtByAppVersion: string;
	/** 兼容的最低 app 版本（含）。 */
	minAppVersion: string;
	/** 兼容的最高 app 版本（不含）；空串 = 不设上限。 */
	maxAppVersion: string;
	/** tarball 的 sha256（小写 hex），下载完整性校验用。 */
	archiveSha256: string;
	/** 归档内必须存在的关键包（解压后校验，防清单与归档不一致）。 */
	requiredPackages: string[];
	/** 包数量（展示用）。 */
	packageCount: number;
};

/** 已安装的 runtime（清单 + 所在目录名）。 */
export type InstalledDshRuntime = {
	manifest: DshRuntimeManifest;
	/** 目录名，通常与 runtimeVersion 相同（多版本共存目录可能带后缀）。 */
	dirName: string;
};

/**
 * 下载源里的一条可安装版本（Electron update feed 同款模式）。
 *
 * 为什么需要它而不只读 tarball 里的 manifest：sha256 必须在下载**之前**知道，
 * 否则校验形同虚设（拿到文件再读它自己声明的哈希 = 自证）。因此清单信息由
 * 下载源索引提供，tarball 内的 manifest 只作二次交叉校验。
 */
export type DshRuntimeRelease = {
	runtimeVersion: string;
	minAppVersion: string;
	/** 兼容的最高 app 版本（不含）；空串 = 不设上限。 */
	maxAppVersion: string;
	/** tarball 下载地址（可为镜像）。 */
	url: string;
	/** tarball 的 sha256（小写 hex）。 */
	sha256: string;
	/** 归档字节数（进度展示用）。 */
	size: number;
};

/** 下载源索引文件（dsh-runtime-releases.json）。 */
export type DshRuntimeReleaseIndex = {
	schemaVersion: number;
	releases: DshRuntimeRelease[];
};

/**
 * 为当前 app 版本挑出要安装的版本：兼容区间内 runtimeVersion 最大的一条。
 * 与 selectRuntime 的区别是入参形状不同（索引条目 vs 已安装清单）。
 */
export function selectRelease(
	releases: readonly DshRuntimeRelease[],
	appVersion: string,
): DshRuntimeRelease | undefined {
	const compatible = releases.filter(
		(release) =>
			compareSemver(appVersion, release.minAppVersion) >= 0 &&
			(!release.maxAppVersion || compareSemver(appVersion, release.maxAppVersion) < 0),
	);
	if (compatible.length === 0) return undefined;
	return compatible.reduce((best, current) =>
		compareSemver(current.runtimeVersion, best.runtimeVersion) > 0 ? current : best,
	);
}

// ── 语义版本比较 ──

type ParsedVersion = { core: number[]; pre: Array<string | number> };

/**
 * 解析 `major.minor.patch[-prerelease][+build]`。
 * 宽松解析：非数字段按 0 处理，比较结果仍稳定（不会抛错打断 UI）。
 */
function parseVersion(version: string): ParsedVersion {
	const trimmed = version.trim().replace(/^\D+/, "");
	const [corePart = "", rest = ""] = trimmed.split("-", 2);
	const buildStripped = rest.split("+")[0] ?? "";
	const core = corePart.split(".").map((part) => {
		const value = Number.parseInt(part, 10);
		return Number.isFinite(value) ? value : 0;
	});
	// 补齐到三段，保证 0.7 与 0.7.0 等价。
	while (core.length < 3) core.push(0);
	const pre = buildStripped
		? buildStripped.split(".").map((part) => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : part))
		: [];
	return { core, pre };
}

/** 比较 prerelease 段：数字 < 字母；同类型按数值/字典序；段数少者更小。 */
function comparePrerelease(a: Array<string | number>, b: Array<string | number>): number {
	if (a.length === 0 && b.length === 0) return 0;
	// 正式版 > 预发布版（1.0.0 > 1.0.0-rc.1）
	if (a.length === 0) return 1;
	if (b.length === 0) return -1;
	const max = Math.max(a.length, b.length);
	for (let i = 0; i < max; i += 1) {
		const left = a[i];
		const right = b[i];
		if (left === undefined) return -1;
		if (right === undefined) return 1;
		if (left === right) continue;
		const leftIsNum = typeof left === "number";
		const rightIsNum = typeof right === "number";
		if (leftIsNum && rightIsNum) return left < right ? -1 : 1;
		if (leftIsNum !== rightIsNum) return leftIsNum ? -1 : 1;
		return String(left) < String(right) ? -1 : 1;
	}
	return 0;
}

/** 语义版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0。 */
export function compareSemver(a: string, b: string): number {
	const left = parseVersion(a);
	const right = parseVersion(b);
	for (let i = 0; i < 3; i += 1) {
		const l = left.core[i] ?? 0;
		const r = right.core[i] ?? 0;
		if (l !== r) return l < r ? -1 : 1;
	}
	return comparePrerelease(left.pre, right.pre);
}

// ── 兼容区间判定 ──

/** 清单 schema 是否为本 app 可读（schema 不认识的 runtime 一律不可用）。 */
export function isManifestSchemaSupported(manifest: DshRuntimeManifest): boolean {
	return manifest.schemaVersion === DSH_RUNTIME_MANIFEST_SCHEMA;
}

/**
 * app 版本是否落在 runtime 声明的兼容区间内。
 * 区间语义：`minAppVersion <= appVersion < maxAppVersion`（max 为空 = 不设上限）。
 */
export function isAppVersionCompatible(
	appVersion: string,
	manifest: DshRuntimeManifest,
): boolean {
	if (!isManifestSchemaSupported(manifest)) return false;
	if (compareSemver(appVersion, manifest.minAppVersion) < 0) return false;
	if (manifest.maxAppVersion && compareSemver(appVersion, manifest.maxAppVersion) >= 0) return false;
	return true;
}

// ── 多版本选择 / 回收 ──

/**
 * 选出要启用的 runtime：在兼容当前 app 的版本里取 runtimeVersion 最大的那个。
 * 不兼容的版本一律跳过（即使更新），否则会静默用上一个桥协议的 runtime。
 */
export function selectRuntime(
	runtimes: readonly InstalledDshRuntime[],
	appVersion: string,
): InstalledDshRuntime | undefined {
	const compatible = runtimes.filter((entry) => isAppVersionCompatible(appVersion, entry.manifest));
	if (compatible.length === 0) return undefined;
	return compatible.reduce((best, current) =>
		compareSemver(current.manifest.runtimeVersion, best.manifest.runtimeVersion) > 0 ? current : best,
	);
}

/**
 * 回收判定：保留 keep（当前启用版本）与最新一个兼容版本，其余可删。
 * 保留「最新兼容版」而非「最新版本」：不兼容的更新版本留着也无法回退启用。
 */
export function collectRecyclableRuntimes(
	runtimes: readonly InstalledDshRuntime[],
	appVersion: string,
	keepDirName?: string,
): string[] {
	const keep = new Set<string>();
	if (keepDirName) keep.add(keepDirName);
	const compatible = runtimes
		.filter((entry) => isAppVersionCompatible(appVersion, entry.manifest))
		.sort((a, b) => compareSemver(b.manifest.runtimeVersion, a.manifest.runtimeVersion));
	if (compatible[0]) keep.add(compatible[0].dirName);
	return runtimes.filter((entry) => !keep.has(entry.dirName)).map((entry) => entry.dirName);
}
