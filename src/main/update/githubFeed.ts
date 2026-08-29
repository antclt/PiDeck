/**
 * GitHub Releases 无配额检查源（对齐 electron-updater GitHubProvider 策略）。
 *
 * 为什么不调 api.github.com REST API：
 * 未认证 REST API 限 60 次/小时/IP（NAT 共享会耗尽，正是更新检查"看起来没有新版本"的
 * 常见原因）；认证又要求每个用户各自 OAuth 授权（token 用户级，应用无法代用户获取）。
 * 而以下三个端点走 GitHub 静态/网页层，不受 REST 配额限制：
 *   - https://github.com/{owner}/{repo}/releases/latest            → 302 重定向到最新 tag 页
 *   - https://github.com/{owner}/{repo}/releases.atom              → 公开 Atom feed（发布说明）
 *   - https://github.com/{owner}/{repo}/releases/download/{tag}/latest.yml → Release 资产下载
 *
 * 主路径：latest.yml（electron-builder 生成，含 version + 资产清单，无需解析 HTML）。
 * 降级路径（过渡期线上 release 没有 latest.yml 时）：atom feed 拿版本/说明，
 * 资产列表用 REST API 兜底（低频，发布流程改造后不再触发）。
 *
 * 本文件只含纯函数，不 import Electron；测试直接注入 fetchImpl 即可。
 */

export type HttpFetch = (
	url: string,
	init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; url: string; text(): Promise<string>; json(): Promise<unknown> }>;

/** electron-builder latest.yml 解析结果（只取检查更新需要的字段）。 */
export type LatestYmlInfo = {
	version: string;
	/** 资产清单（url 为文件名，实际下载地址 = release 资产 URL）。 */
	files: Array<{ url: string; size?: number; sha512?: string }>;
	/** 发布/构建时间（ISO 字符串，可能缺失）。 */
	releaseDate?: string;
	/** 主包路径（同 files[0].url）。 */
	path?: string;
};

/** GitHub Release 资产信息（REST 兜底 / latest.yml 归一化后的通用形态）。 */
export type ReleaseAsset = {
	name: string;
	url: string;
	size: number;
};

export type GithubReleaseInfo = {
	tag: string;
	/** 版本号（tag 去掉 v 前缀）。 */
	version: string;
	releaseName?: string;
	releaseNotes?: string;
	releaseUrl: string;
	publishedAt?: string;
};

/** 重定向跟随后的最终 URL 里提取 tag：https://github.com/o/r/releases/tag/v1.2.3 */
export function extractTagFromRedirectUrl(finalUrl: string): string | null {
	try {
		const url = new URL(finalUrl);
		const match = /\/tag\/([^/]+)\/?$/.exec(url.pathname);
		return match ? decodeURIComponent(match[1]) : null;
	} catch {
		return null;
	}
}

/** 从 atom feed 的 entry link 提取 tag：https://github.com/o/r/releases/tag/v1.2.3 */
export function extractTagFromAtomLink(href: string): string | null {
	const match = /\/tag\/([^/]+)\/?$/.exec(href);
	return match ? decodeURIComponent(match[1]) : null;
}

export function normalizeVersion(version: string): string {
	return version.trim().replace(/^v/i, "");
}

export function compareVersions(left: string, right: string): number {
	const leftParts = normalizeVersion(left).split(/[.-]/);
	const rightParts = normalizeVersion(right).split(/[.-]/);
	const leftCore = leftParts.map(toNumericPart);
	const rightCore = rightParts.map(toNumericPart);
	const length = Math.max(leftCore.length, rightCore.length);
	for (let index = 0; index < length; index += 1) {
		const diff = (leftCore[index] ?? 0) - (rightCore[index] ?? 0);
		if (diff !== 0) return diff;
	}
	// 数字段全部相等时，带预发布标识（如 0.7.2-beta）低于同号正式版（0.7.2），与 semver 一致：
	// beta 测试客户端在正式版发布后能收到更新提示；正式版客户端不会被拉回预发布版。
	const leftPrerelease = hasPrereleaseTag(leftParts);
	const rightPrerelease = hasPrereleaseTag(rightParts);
	if (leftPrerelease !== rightPrerelease) return leftPrerelease ? -1 : 1;
	return 0;
}

function toNumericPart(part: string): number {
	return Number.parseInt(part, 10) || 0;
}

/** 版本号里是否带非数字段（如 beta/rc），即 semver 预发布标识。 */
function hasPrereleaseTag(parts: string[]): boolean {
	return parts.some((part) => !/^\d+$/.test(part));
}

/**
 * 解析 electron-builder 生成的 latest.yml（结构固定，行级解析足够，不引 yaml 依赖）。
 * 支持：
 *   version: 1.2.3
 *   files:
 *     - url: PiDeck-Setup-1.2.3.exe
 *       sha512: xxx
 *       size: 12345
 *   path: PiDeck-Setup-1.2.3.exe
 *   sha512: xxx
 *   releaseDate: 2026-01-01T00:00:00.000Z
 */
export function parseLatestYml(text: string): LatestYmlInfo | null {
	if (typeof text !== "string" || !text.trim()) return null;
	const lines = text.split(/\r?\n/);
	let version = "";
	let releaseDate: string | undefined;
	let path: string | undefined;
	const files: LatestYmlInfo["files"] = [];
	let inFiles = false;
	let currentFile: { url: string; size?: number; sha512?: string } | null = null;

	const flushFile = () => {
		if (currentFile && currentFile.url) files.push(currentFile);
		currentFile = null;
	};

	for (const raw of lines) {
		const line = raw.trimEnd();
		const trimmed = line.trim();
		if (trimmed.startsWith("version:")) {
			version = trimmed.slice("version:".length).trim();
			continue;
		}
		if (trimmed.startsWith("releaseDate:")) {
			releaseDate = trimmed.slice("releaseDate:".length).trim();
			continue;
		}
		if (trimmed.startsWith("path:")) {
			path = trimmed.slice("path:".length).trim();
			continue;
		}
		if (trimmed === "files:" || trimmed === "files") {
			inFiles = true;
			continue;
		}
		if (inFiles && trimmed.startsWith("- url:")) {
			flushFile();
			currentFile = { url: trimmed.slice("- url:".length).trim() };
			continue;
		}
		if (inFiles && currentFile && trimmed.startsWith("url:")) {
			currentFile.url = trimmed.slice("url:".length).trim();
			continue;
		}
		if (inFiles && currentFile && trimmed.startsWith("size:")) {
			const size = Number.parseInt(trimmed.slice("size:".length).trim(), 10);
			if (Number.isFinite(size)) currentFile.size = size;
			continue;
		}
		if (inFiles && currentFile && trimmed.startsWith("sha512:")) {
			currentFile.sha512 = trimmed.slice("sha512:".length).trim();
			continue;
		}
	}
	flushFile();

	if (!version) return null;
	return { version, files, releaseDate, path };
}

/** 解析 GitHub releases.atom 的第一个 entry（最新 release）。 */
export function parseAtomFeed(xml: string): GithubReleaseInfo | null {
	if (typeof xml !== "string" || !xml.trim()) return null;
	const entry = /<entry[\s>][\s\S]*?<\/entry>/.exec(xml);
	const block = entry ? entry[0] : xml;

	const titleMatch = /<title(?:[^>]*)>([\s\S]*?)<\/title>/.exec(block);
	const linkMatch = /<link[^>]*href="([^"]+)"/.exec(block);
	const publishedMatch = /<published>([\s\S]*?)<\/published>/.exec(block);
	const contentMatch = /<content[^>]*>([\s\S]*?)<\/content>/.exec(block);

	const tag = linkMatch ? extractTagFromAtomLink(linkMatch[1]) : null;
	if (!tag) return null;

	const decodeXml = (value: string) =>
		value
			.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/&amp;/g, "&")
			.trim();

	return {
		tag,
		version: normalizeVersion(tag),
		releaseName: titleMatch ? decodeXml(titleMatch[1]) : undefined,
		releaseNotes: contentMatch ? decodeXml(contentMatch[1]) : undefined,
		releaseUrl: linkMatch ? linkMatch[1] : `https://github.com/releases/tag/${tag}`,
		publishedAt: publishedMatch ? publishedMatch[1] : undefined,
	};
}

export type GitHubReleasePayload = {
	tag_name?: string;
	name?: string;
	body?: string;
	html_url?: string;
	published_at?: string;
	assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>;
};

/** REST API 兜底：按 tag 拉取 release 详情（仅降级路径使用，低频）。 */
export function parseGithubReleaseJson(data: unknown): GithubReleaseInfo | null {
	if (!data || typeof data !== "object") return null;
	const release = data as GitHubReleasePayload;
	if (typeof release.tag_name !== "string") return null;
	return {
		tag: release.tag_name,
		version: normalizeVersion(release.tag_name),
		releaseName: release.name,
		releaseNotes: release.body,
		releaseUrl: release.html_url ?? `https://github.com/releases/tag/${release.tag_name}`,
		publishedAt: release.published_at,
	};
}

export function githubReleaseAssets(data: unknown): ReleaseAsset[] {
	if (!data || typeof data !== "object") return [];
	const release = data as GitHubReleasePayload;
	return (release.assets ?? [])
		.filter((asset) => typeof asset.name === "string" && typeof asset.browser_download_url === "string")
		.map((asset) => ({
			name: asset.name as string,
			url: asset.browser_download_url as string,
			size: typeof asset.size === "number" ? asset.size : 0,
		}));
}

export type GithubRepo = {
	owner: string;
	repo: string;
	/** 资产下载基址（不含文件名）。 */
	get downloadBase(): string;
	/** REST API 兜底地址（按 tag）。 */
	apiReleaseUrl(tag: string): string;
};

export function createGithubRepo(owner: string, repo: string): GithubRepo {
	return {
		owner,
		repo,
		get downloadBase() {
			return `https://github.com/${owner}/${repo}/releases/download`;
		},
		apiReleaseUrl(tag: string) {
			return `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
		},
	};
}

/** 主路径：latest.yml 解析出的资产归一化成通用形态（url 补全为 release 下载地址）。 */
export function latestYmlAssets(info: LatestYmlInfo, repo: GithubRepo, tag: string): ReleaseAsset[] {
	return info.files.map((file) => ({
		name: file.url,
		url: `${repo.downloadBase}/${encodeURIComponent(tag)}/${encodeURIComponent(file.url)}`,
		size: file.size ?? 0,
	}));
}

/** 下载并解析 releases.atom（公开 feed，无 REST 配额）。 */
export async function fetchAtomFeed(
	repo: GithubRepo,
	fetchImpl: HttpFetch,
): Promise<GithubReleaseInfo | null> {
	const response = await fetchImpl(`https://github.com/${repo.owner}/${repo.repo}/releases.atom`, {
		headers: { accept: "application/atom+xml, application/xml, text/xml, */*" },
	});
	if (!response.ok) {
		throw new Error(`GitHub atom feed failed (HTTP ${response.status})`);
	}
	return parseAtomFeed(await response.text());
}

/** electron-builder 按平台生成的 channel 元数据文件名（与 electron-updater 约定一致）。
 *  Windows: latest.yml / macOS: latest-mac.yml / Linux: latest-linux.yml */
export function getChannelFilename(platform: NodeJS.Platform = process.platform): string {
	if (platform === "darwin") return "latest-mac.yml";
	if (platform === "linux") return "latest-linux.yml";
	return "latest.yml";
}

/** 下载并解析 electron-builder channel 元数据（Release 资产，无 REST 配额）。 */
export async function fetchLatestYml(
	tag: string,
	repo: GithubRepo,
	fetchImpl: HttpFetch,
	channelFilename: string = getChannelFilename(),
): Promise<LatestYmlInfo | null> {
	const response = await fetchImpl(`${repo.downloadBase}/${encodeURIComponent(tag)}/${encodeURIComponent(channelFilename)}`, {
		headers: { "User-Agent": "pi-desktop-update-check" },
	});
	if (!response.ok) {
		throw new Error(`${channelFilename} download failed (HTTP ${response.status})`);
	}
	return parseLatestYml(await response.text());
}
