/**
 * 更新源（GitHub Release 镜像）共享契约 —— 主进程与渲染层共用，禁止 import 运行时层。
 *
 * 背景：GitHub provider 的 githubUrl() 只支持 host 覆盖（企业版语义），拼不出
 * 「https://<镜像>/https://github.com/...」前缀代理的路径，因此镜像走 generic
 * provider：把 `镜像前缀 + /ayuayue/PiDeck/releases/latest/download` 整体作为
 * feed baseUrl，latest.yml 与安装包/blockmap 的相对路径都会拼在其后。
 *
 * 镜像可用性变化快：维护者应在发版前实测（curl -L 镜像/releases/latest/download/latest.yml），
 * 死掉的镜像及时从清单移除。设置页的预设列表与主进程 feed URL 生成都读这份清单，
 * 改动两处自动同步（同一事实来源）。
 */

import type { UpdateSourceId } from "./types/settings";

/**
 * GitHub 侧仓库坐标。
 *
 * 仓库已从个人账号转移到组织 `pideck-app`（显示名 PiDeck）。旧坐标 `ayuayue/PiDeck`
 * 只能靠 GitHub 重定向工作，一旦重定向失效（旧名被回收/重定向被删）更新检查会直接 404，
 * 禁止再回填旧 owner。
 */
export const GITHUB_REPO_OWNER = "pideck-app";
/**
 * AtomGit 侧仓库坐标。
 *
 * AtomGit 命名空间与 GitHub 完全独立：仓库转到组织后，镜像仍挂在个人账号下。
 * 两侧必须分开取常量——把 GitHub 侧 owner 改掉却误用了这一组（或反之），会同时打断
 * 国内更新源、公告、模型目录与热更新，因为它们的取件 URL 都走 AtomGit。
 */
export const ATOMGIT_REPO_OWNER = "ayuayue";
/** 仓库名：两侧同名，改仓库名时两边同步。 */
export const UPDATE_REPO = "PiDeck";

/** generic feed 的固定路径段：GitHub 把 `releases/latest/download/<asset>` 302 到当前最新 release。 */
export const RELEASES_LATEST_DOWNLOAD_PATH = "/releases/latest/download";

/** AtomGit 托管根域名。 */
export const ATOMGIT_HOST = "https://atomgit.com";

/**
 * AtomGit OpenAPI 根域名（注意与托管域名不同：api.atomgit.com）。
 *
 * 匿名 `/raw/` 路径已被 GitCode 前端应用接管（返回 SPA HTML 壳 + 易盾验证码 SDK），
 * 程序化取文件内容必须走官方开放接口：
 * `GET {ATOMGIT_API_HOST}/api/v5/repos/:owner/:repo/contents/:path?ref=<branch>`
 * 返回 JSON（content 为 base64），匿名可读公开仓库（实测 5 连发均 ~0.4s 无限速）。
 */
export const ATOMGIT_API_HOST = "https://api.atomgit.com";

/** AtomGit Release 仓库根路径，例如 `https://atomgit.com/ayuayue/PiDeck`。 */
export function atomGitReleasesBase(): string {
	return `${ATOMGIT_HOST}/${ATOMGIT_REPO_OWNER}/${UPDATE_REPO}`;
}

/** AtomGit Release generic feed baseUrl（latest.yml 与安装包都下载自此路径）。 */
export function atomGitFeedUrl(): string {
	return `${atomGitReleasesBase()}/releases/download/latest`;
}

/**
 * AtomGit latest release 的 OpenAPI。
 *
 * 网页 `atomgit.com/.../releases/latest` 是 SPA 壳，不会像 GitHub 那样 302 到
 * `/releases/tag/vX.Y.Z`，程序化读版本必须走 JSON 的 `tag_name`。
 */
export function atomGitLatestReleaseApiUrl(): string {
	return `${ATOMGIT_API_HOST}/api/v5/repos/${ATOMGIT_REPO_OWNER}/${UPDATE_REPO}/releases/latest`;
}

/** 镜像/非官方更新源清单：保留 AtomGit 作为国内加速源（第一首选）；github 走原生链路。 */
export const UPDATE_SOURCE_MIRRORS: ReadonlyArray<{ id: UpdateSourceId; host: string }> = [{ id: "atomgit", host: ATOMGIT_HOST }];

/** GitHub Release 仓库根路径，例如 `https://github.com/pideck-app/PiDeck`。 */
export function gitHubReleasesBase(): string {
	return `https://github.com/${GITHUB_REPO_OWNER}/${UPDATE_REPO}`;
}

/**
 * GitHub latest 资产根路径，例如 `https://github.com/ayuayue/PiDeck/releases/latest/download`。
 * 与 AtomGit 的 `/releases/download/latest` 路径不同，两边不能共用同一套拼接。
 */
export function gitHubLatestDownloadBase(): string {
	return `${gitHubReleasesBase()}${RELEASES_LATEST_DOWNLOAD_PATH}`;
}

/** 镜像前缀 → generic feed baseUrl。对于 atomgit 直接返回 atomgit feed url。 */
export function buildCustomSourceFeedUrl(host: string): string {
	if (host === ATOMGIT_HOST || host.startsWith(ATOMGIT_HOST)) {
		return atomGitFeedUrl();
	}
	return `${host}/${gitHubReleasesBase()}${RELEASES_LATEST_DOWNLOAD_PATH}`;
}

/**
 * 规范化自定义镜像前缀：trim、去尾斜杠、强制 https/http。非法/空返回 null（UI 实时校验用）。
 */
export function normalizeCustomMirrorHost(raw: string | null | undefined): string | null {
	const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
	if (!trimmed) return null;
	if (!/^https?:\/\//i.test(trimmed)) return null;
	try {
		const parsed = new URL(trimmed);
		if (!parsed.hostname) return null;
		return trimmed;
	} catch {
		return null;
	}
}
