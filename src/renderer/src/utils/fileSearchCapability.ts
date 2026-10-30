import { isRemoteProject } from "../../../shared/projectLocation";
import type { Project } from "../../../shared/types";

/**
 * helper hello 能力清单里内容搜索的名字（与 main/remote/RemoteHelperContract.ts 的
 * REMOTE_HELPER_METHOD_FS_SEARCH_CONTENT 同一个 wire 词汇；渲染层不能 import 主进程模块，
 * 所以这里是字符串常量而不是跨层引用）。
 */
export const REMOTE_CONTENT_SEARCH_CAPABILITY = "fs.searchContent";

/**
 * 文件搜索的能力边界（渲染层唯一判据）。
 *
 * 本机内容检索依赖 file-index sidecar；远端只有 helper 1.25.0+ 声明了 `fs.searchContent` 才有内容搜索，
 * 旧 helper 的 hello 清单里没有它——缺席即不支持，绝不靠"试一次失败"来猜。WSL 项目仍走宿主 UNC，
 * 索引根为空（见 main/ipc/filesIpc.ts 的 indexRootsFor），所以固定不支持。
 *
 * `helperCapabilities` 来自连接 hello（rootStatus 的 helperCapabilities 字段）。远端项目缺少该值时
 * 一律判为不支持：能力回退必须保守，不能把未知当成可用。
 */
export function projectSupportsContentSearch(project: Project | undefined, helperCapabilities?: readonly string[] | null): boolean {
	if (project === undefined) return true;
	if (isRemoteProject(project)) return remoteCapabilitiesAllowContentSearch(helperCapabilities);
	return project.environment !== "wsl";
}

/** 能力清单是否允许内容搜索：只有显式声明 `fs.searchContent` 的会话才算支持。 */
export function remoteCapabilitiesAllowContentSearch(helperCapabilities: readonly string[] | null | undefined): boolean {
	return helperCapabilities !== undefined && helperCapabilities !== null && helperCapabilities.includes(REMOTE_CONTENT_SEARCH_CAPABILITY);
}

/**
 * 是否应当发起内容搜索：能力不支持时**一个 IPC 都不发**（旧 helper 回退的关键断言点），
 * 词太短也不发（与 useFileSearch 的最小长度口径一致）。
 */
export function shouldRunRemoteContentSearch(supported: boolean, query: string): boolean {
	return supported && query.trim().length >= 2;
}

/**
 * 「仅文件名搜索」提示只在两个条件同时成立时出现：
 * 该位置确实不支持内容检索，且用户已经输入了查询词（空查询的空态不该出现能力提示）。
 */
export function shouldShowFileNameOnlyHint(input: { contentSearchSupported: boolean; query: string }): boolean {
	return !input.contentSearchSupported && input.query.trim().length > 0;
}
