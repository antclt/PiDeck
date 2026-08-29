/**
 * PiDeck 应用更新检查编排（无配额方案）。
 *
 * 主路径：releases/latest 重定向拿最新 tag → 下载 latest.yml（版本 + 资产清单）。
 * 降级路径（线上 release 尚未生成 latest.yml 的过渡期）：
 *   atom feed 拿版本/说明 → REST API 按 tag 拉资产（低频兜底，发布流程改造后不再触发）。
 *
 * 纯 Node 无 Electron 依赖；fetchImpl 可注入便于单测。
 */

import type { AppUpdateAsset, AppUpdateInfo } from "../../shared/types";
import {
	compareVersions,
	createGithubRepo,
	extractTagFromRedirectUrl,
	fetchAtomFeed,
	fetchLatestYml,
	githubReleaseAssets,
	latestYmlAssets,
	parseGithubReleaseJson,
	type GithubRepo,
	type HttpFetch,
} from "./githubFeed";

export type { GithubRepo, HttpFetch } from "./githubFeed";

/** 每次 GitHub 请求的默认超时（ms）：本地网络异常时手动/后台检查都不会永远挂起。 */
export const DEFAULT_CHECK_TIMEOUT_MS = 10_000;

/**
 * 更新检查/发布/issue 链接指向的 GitHub 仓库坐标（唯一事实来源）。
 * 仓库已由 pi-desktop 更名为 PiDeck：旧坐标目前只能靠 GitHub 改名重定向工作，
 * 一旦重定向失效（旧名被他人注册/回收）更新检查会直接 404，禁止再回填旧名。
 */
export const UPDATE_REPO_OWNER = "ayuayue";
export const UPDATE_REPO = "PiDeck";

/** 按当前平台/架构/安装形态挑选推荐资产（从原 src/main/index.ts 迁移）。 */
export function selectRecommendedAsset(
	assets: AppUpdateAsset[],
	installationType?: "portable" | "installed",
): AppUpdateAsset | undefined {
	const platform = process.platform;
	const arch = process.arch;
	// Windows 便携版以 electron-builder 注入的运行时环境变量为准；旧 settings 可能残留 installed。
	const isPortable =
		platform === "win32"
			? process.env.PORTABLE_EXECUTABLE_DIR !== undefined || installationType === "portable"
			: installationType === "portable";

	// 映射资产以便匹配
	const candidates = assets.map((asset) => ({
		...asset,
		lowerName: asset.name.toLowerCase(),
	}));

	// 根据架构确定关键词，严格匹配
	const archKeywords =
		arch === "arm64" ? ["arm64", "aarch64"] : ["x64", "amd64", "x86_64"];
	const matchesArch = (name: string) =>
		archKeywords.some((keyword) => name.includes(keyword));

	// 检查是否为非目标架构（用于排除不匹配的资产）
	const isWrongArch = (name: string) => {
		if (arch === "arm64") {
			// 当前是 ARM64，排除 x64 相关的
			return /\b(x64|amd64|x86_64)\b/i.test(name);
		} else {
			// 当前是 x64，排除 arm64 相关的
			return /\b(arm64|aarch64)\b/i.test(name);
		}
	};

	const isWindowsAsset = (name: string) =>
		/\.(exe|msi)$/i.test(name) || (name.endsWith(".zip") && !/(mac|darwin|osx|linux|appimage|deb|tar\.gz)/i.test(name));
	const isMacAsset = (name: string) => /\.(dmg)$/i.test(name) || /(mac|darwin|osx)/i.test(name);
	const isLinuxAsset = (name: string) => /(appimage|\.deb$|\.tar\.gz$|linux)/i.test(name);

	if (platform === "win32") {
		// Windows 只能在 Windows 资产里挑选；Release 同时包含 macOS zip，不能用全局 zip 回退。
		const platformCandidates = candidates.filter((asset) => isWindowsAsset(asset.lowerName));
		// Windows: 优先匹配当前安装形态（便携版 vs 安装版）和架构
		if (isPortable) {
			// 便携版 exe 是单文件绿色版，无需安装；优先推荐非 Setup 的便携 exe，其次 .zip
			return (
				platformCandidates.find(
					(asset) => !asset.lowerName.includes("setup") && asset.lowerName.endsWith(".exe") && matchesArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => !asset.lowerName.includes("setup") && asset.lowerName.endsWith(".exe") && !isWrongArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.endsWith(".zip") && matchesArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.endsWith(".zip") && !isWrongArch(asset.lowerName),
				)
			);
		} else {
			// 安装版：优先推荐带 Setup 的安装 exe，其次普通 exe，最后 zip
			return (
				platformCandidates.find(
					(asset) => asset.lowerName.includes("setup") && asset.lowerName.endsWith(".exe") && matchesArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.includes("setup") && asset.lowerName.endsWith(".exe") && !isWrongArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.endsWith(".exe") && matchesArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.endsWith(".exe") && !isWrongArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.endsWith(".zip") && matchesArch(asset.lowerName),
				) ??
				platformCandidates.find(
					(asset) => asset.lowerName.endsWith(".zip") && !isWrongArch(asset.lowerName),
				)
			);
		}
	}

	if (platform === "darwin") {
		// macOS 只在 macOS 资产中选择，避免 x64 zip 回退到 Windows/Linux 包。
		const platformCandidates = candidates.filter((asset) => isMacAsset(asset.lowerName));
		return (
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".dmg") && matchesArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".dmg") && !isWrongArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".zip") && matchesArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".zip") && !isWrongArch(asset.lowerName),
			)
		);
	}

	if (platform === "linux") {
		// Linux 只在 Linux 资产中选择，避免跨平台 zip/exe 被误推荐。
		const platformCandidates = candidates.filter((asset) => isLinuxAsset(asset.lowerName));
		return (
			platformCandidates.find(
				(asset) => asset.lowerName.includes("appimage") && matchesArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) =>
					asset.lowerName.includes("appimage") && !isWrongArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".deb") && matchesArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".deb") && !isWrongArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".tar.gz") && matchesArch(asset.lowerName),
			) ??
			platformCandidates.find(
				(asset) => asset.lowerName.endsWith(".tar.gz") && !isWrongArch(asset.lowerName),
			)
		);
	}

	// 回退：返回第一个匹配架构的资产
	return candidates.find((asset) => matchesArch(asset.lowerName)) ?? candidates[0];
}

export type CheckAppUpdateOptions = {
	owner: string;
	repo: string;
	currentVersion: string;
	installationType?: "portable" | "installed";
	fetchImpl?: HttpFetch;
	/** 每次 GitHub 请求的超时（ms）；默认 10s。防止用户本地网络异常时检查永远挂起
	 *  （历史上「一进设置页就转圈、手动更新被卡死」的根因）。 */
	timeoutMs?: number;
	log?: (level: "info" | "warn", message: string, details?: Record<string, unknown>) => void;
};

/** 从 atom feed 补齐 releaseName/releaseNotes（latest.yml 主路径也拉一次，无配额成本）。 */
async function enrichFromAtom(
	repo: GithubRepo,
	fetchImpl: HttpFetch,
	log?: CheckAppUpdateOptions["log"],
): Promise<{ releaseName?: string; releaseNotes?: string; publishedAt?: string; releaseUrl?: string }> {
	try {
		const atom = await fetchAtomFeed(repo, fetchImpl);
		if (!atom) return {};
		return {
			releaseName: atom.releaseName,
			releaseNotes: atom.releaseNotes,
			publishedAt: atom.publishedAt,
			releaseUrl: atom.releaseUrl,
		};
	} catch (error) {
		// atom 补齐失败不影响主流程（说明可缺省）。
		log?.("warn", "Atom feed enrichment failed", { error: error instanceof Error ? error.message : String(error) });
		return {};
	}
}

/**
 * 校验「推荐资产」的下载 URL 真实可用，并把 URL 修正为第一个可用变体。
 *
 * 为什么需要（v0.7.1 实测）：GitHub 保存资产时把文件名中的空格替换为点号，electron-builder
 * 的 latest.yml 又可能写连字符安全名——latest.yml 里的文件名与真实资产名不一致时，
 * 按 latest.yml 拼出的下载 URL「检查正常、点下载 404」。此处按已知命名变换依次 HEAD 探测
 * （原名 → 空格→点号 → 连字符→点号），命中即修正 URL；全部不可用则返回 undefined，
 * UI 禁用应用内下载并回退浏览器打开 release 页。代价仅 1~3 次 HEAD（无配额，检查周期 2h）。
 */
async function verifyRecommendedAsset(
	asset: AppUpdateAsset | undefined,
	fetchImpl: HttpFetch,
	log?: CheckAppUpdateOptions["log"],
): Promise<AppUpdateAsset | undefined> {
	if (!asset?.url) return asset;
	const lastSegment = asset.url.slice(asset.url.lastIndexOf("/") + 1);
	let decoded = lastSegment;
	try {
		decoded = decodeURIComponent(lastSegment);
	} catch {
		// 非法编码时保持原样，仅按原 URL 探测
	}
	const candidates = [...new Set([decoded, decoded.replace(/ /g, "."), decoded.replace(/-/g, ".")])];
	const prefix = asset.url.slice(0, asset.url.length - lastSegment.length);
	for (const name of candidates) {
		const url = `${prefix}${encodeURIComponent(name)}`;
		try {
			const response = await fetchImpl(url, { method: "HEAD" });
			if (response.ok) {
				if (url !== asset.url) {
					log?.("warn", "Recommended asset URL corrected to the real GitHub asset name", { from: asset.url, to: url });
				}
				return { ...asset, url };
			}
		} catch (error) {
			log?.("warn", "Recommended asset availability probe failed", {
				url,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	log?.("warn", "Recommended asset URL unavailable, falling back to browser download", { url: asset.url });
	return undefined;
}

/**
 * 无配额更新检查：latest.yml 主路径 + atom/API 降级。
 * 失败时抛出（上层转成用户可读错误）。
 */
export async function checkAppUpdate(options: CheckAppUpdateOptions): Promise<AppUpdateInfo> {
	const { owner, repo: repoName, currentVersion, installationType } = options;
	const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
	// 默认 fetchImpl 带 AbortController 超时：本地网络异常时最多等 timeoutMs 就失败返回，
	// 手动检查显示错误（转圈停止、可重试），后台检查失败后照常调度下一轮。
	const fetchImpl: HttpFetch = options.fetchImpl ?? (async (url, init) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		timer.unref?.();
		try {
			const response = await fetch(url, { ...init, signal: controller.signal });
			return {
				ok: response.ok,
				status: response.status,
				url: response.url,
				text: () => response.text(),
				json: () => response.json(),
			};
		} finally {
			clearTimeout(timer);
		}
	});
	const log = options.log;

	const repo = createGithubRepo(owner, repoName);

	// 1) 最新 tag：github.com 网页域 releases/latest（302 重定向，无 REST 配额）。
	const tag = await resolveLatestTag(repo, fetchImpl);
	log?.("info", "Resolved latest release tag", { tag });

		let info: AppUpdateInfo;
		try {
			// 2) 主路径：下载 latest.yml（Release 资产，无 REST 配额）。
			const yml = await fetchLatestYml(tag, repo, fetchImpl);
			if (!yml) throw new Error("latest.yml is empty");
			const assets = latestYmlAssets(yml, repo, tag);
			const atom = await enrichFromAtom(repo, fetchImpl, log);
			const hasUpdate = compareVersions(yml.version, currentVersion) > 0;
			// 仅在确有更新时校验推荐资产可用性（无更新时用户不会走下载按钮，省一次 HEAD）。
			const recommendedAsset = hasUpdate
				? await verifyRecommendedAsset(selectRecommendedAsset(assets, installationType), fetchImpl, log)
				: selectRecommendedAsset(assets, installationType);
			info = {
				currentVersion,
				latestVersion: yml.version,
				hasUpdate,
				releaseName: atom.releaseName ?? `v${yml.version}`,
				releaseNotes: atom.releaseNotes ?? "",
				releaseUrl: atom.releaseUrl ?? `https://github.com/${owner}/${repoName}/releases/tag/${tag}`,
				publishedAt: atom.publishedAt ?? yml.releaseDate,
				assets,
				recommendedAsset,
			};
		log?.("info", "App update check completed (latest.yml)", {
			currentVersion,
			latestVersion: yml.version,
			hasUpdate: info.hasUpdate,
			source: "latest.yml",
		});
	} catch (ymlError) {
		// 3) 降级路径：atom feed 拿版本/说明 + REST API 按 tag 拉资产（过渡期兜底，低频）。
		log?.("warn", "latest.yml not available, falling back to atom + API", {
			error: ymlError instanceof Error ? ymlError.message : String(ymlError),
		});
		const atom = await fetchAtomFeed(repo, fetchImpl);
		if (!atom) throw new Error("GitHub release feed unavailable");
		let assets: AppUpdateAsset[] = [];
		try {
			const response = await fetchImpl(repo.apiReleaseUrl(tag), {
				headers: { Accept: "application/vnd.github+json", "User-Agent": `pi-desktop/${currentVersion}` },
			});
			if (response.ok) {
				assets = githubReleaseAssets(await response.json());
			}
		} catch (apiError) {
			// 兜底 API 失败不致命：无资产列表也能提示更新（用户走浏览器下载）。
			log?.("warn", "Fallback API asset fetch failed", { error: apiError instanceof Error ? apiError.message : String(apiError) });
		}
		info = {
			currentVersion,
			latestVersion: atom.version,
			hasUpdate: compareVersions(atom.version, currentVersion) > 0,
			releaseName: atom.releaseName ?? `v${atom.version}`,
			releaseNotes: atom.releaseNotes ?? "",
			releaseUrl: atom.releaseUrl,
			publishedAt: atom.publishedAt,
			assets,
			recommendedAsset: selectRecommendedAsset(assets, installationType),
		};
		log?.("info", "App update check completed (atom fallback)", {
			currentVersion,
			latestVersion: atom.version,
			hasUpdate: info.hasUpdate,
			source: "atom",
		});
	}
	return info;
}

/** 拿最新 tag：请求 github.com/{owner}/{repo}/releases/latest，跟随重定向解析最终 URL。 */
async function resolveLatestTag(repo: GithubRepo, fetchImpl: HttpFetch): Promise<string> {
	const response = await fetchImpl(`https://github.com/${repo.owner}/${repo.repo}/releases/latest`, {
		headers: { "User-Agent": "pi-desktop-update-check" },
	});
	if (!response.ok) {
		throw new Error(`GitHub latest release redirect failed (HTTP ${response.status})`);
	}
	const tag = extractTagFromRedirectUrl(response.url);
	if (!tag) {
		throw new Error(`Cannot resolve latest tag from redirect URL: ${response.url}`);
	}
	return tag;
}

export { createGithubRepo, parseGithubReleaseJson };
