import { isRemoteProject } from "../../../shared/projectLocation";
import type { Project } from "../../../shared/types";

/**
 * 文件搜索的能力边界（渲染层唯一判据）。
 *
 * 内容检索依赖本机 file-index sidecar：远端 helper 只有名字搜索，WSL 项目的索引根为空
 * （宿主扫 UNC 不可靠，见 main/ipc/filesIpc.ts 的 indexRootsFor）。位置不支持时不要发
 * files.searchContent、不要显示内容 loading，UI 用「仅文件名」提示说明能力边界。
 *
 * 缺省（project 为空）保持既有行为：调用点没有位置信息时不擅自收窄能力。
 */
export function projectSupportsContentSearch(project: Project | undefined): boolean {
	if (project === undefined) return true;
	if (isRemoteProject(project)) return false;
	return project.environment !== "wsl";
}

/**
 * 「仅文件名搜索」提示只在两个条件同时成立时出现：
 * 该位置确实不支持内容检索，且用户已经输入了查询词（空查询的空态不该出现能力提示）。
 */
export function shouldShowFileNameOnlyHint(input: { contentSearchSupported: boolean; query: string }): boolean {
	return !input.contentSearchSupported && input.query.trim().length > 0;
}
