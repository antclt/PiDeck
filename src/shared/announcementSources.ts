/**
 * 公告源 URL 清单（无服务器拉取模式）—— 主进程与单测共用，禁止 import 运行时层。
 *
 * 源顺序即 fallback 顺序（用户请求：jsDelivr 为主源，内置 GitHub 代理做 fallback）：
 * 1. jsDelivr gh CDN：国内直连最稳，但缓存最长 24h —— 日常公告足够；
 * 2. 内置镜像前缀代理 raw：镜像实时回源，紧急公告（改完立即 commit）比 jsDelivr
 *    更快触达，可用性波动大所以只做次选；
 * 3. raw.githubusercontent.com 直连：海外用户/代理环境兜底（国内直连基本不可用）。
 *
 * 镜像清单复用 updateSources.ts 的 UPDATE_SOURCE_MIRRORS（同一事实来源，镜像
 * 死亡时改一处两端同步）。公告文件与更新链路解耦：不读用户更新源设置，
 * 恒用固定顺序（公告是低频小文件，没必要让用户配置）。
 */

import { UPDATE_REPO, UPDATE_REPO_OWNER, UPDATE_SOURCE_MIRRORS } from "./updateSources";

/** 公告源文件名（仓库根目录）。 */
export const ANNOUNCEMENT_FILE_NAME = "announcements.json";

/** 公告源分支：main（公告只随主干发布，dev 不承载公告）。 */
export const ANNOUNCEMENT_BRANCH = "main";

/** raw.githubusercontent 直连 URL（源站，权威但国内直连不可达）。 */
export const ANNOUNCEMENT_RAW_URL = `https://raw.githubusercontent.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO}/${ANNOUNCEMENT_BRANCH}/${ANNOUNCEMENT_FILE_NAME}`;

/** jsDelivr gh CDN URL（主源；缓存最长 24h）。 */
export const ANNOUNCEMENT_JSDELIVR_URL = `https://cdn.jsdelivr.net/gh/${UPDATE_REPO_OWNER}/${UPDATE_REPO}@${ANNOUNCEMENT_BRANCH}/${ANNOUNCEMENT_FILE_NAME}`;

/**
 * 完整源列表（按序尝试，任一成功即止）。
 * 镜像前缀代理格式：`https://<mirror>/https://raw.githubusercontent.com/...`，
 * 与更新链路 buildCustomSourceFeedUrl 的前缀拼接语义一致。
 */
export const ANNOUNCEMENT_SOURCE_URLS: readonly string[] = [
	ANNOUNCEMENT_JSDELIVR_URL,
	...UPDATE_SOURCE_MIRRORS.map((mirror) => `${mirror.host}/${ANNOUNCEMENT_RAW_URL}`),
	ANNOUNCEMENT_RAW_URL,
];
