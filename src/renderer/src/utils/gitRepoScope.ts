import type { GitRepoInfo } from "../../../shared/types";

const EMPTY_REPOS: GitRepoInfo[] = [];

/**
 * 只保留属于当前项目的仓库条目。
 *
 * 切项目时 GitDrawerHost / GitPanel 复用同一实例（见 GitPanel 的「项目切换会复用同一个
 * GitPanel 实例」处理），而仓库列表要等一次 listRepos IPC 才回来；这段时间 scope 里仍是
 * 上一项目的仓库，其 target.projectId 属于旧项目。继续把它下发给面板，Git 一侧的
 * parseGitProjectTarget 会以 GIT_PROJECT_TARGET_MISMATCH 拒绝，变更区就挂出一条错误。
 *
 * 列表里没有跨项目条目时返回原引用：调用方（useGitRepoScope → GitDrawerHost → GitPanel）
 * 有以 repos/hasMultipleRepos 为依赖的 effect，每次渲染换新数组会白跑一轮。
 */
export function reposForProject(projectId: string | undefined, repos: readonly GitRepoInfo[]): GitRepoInfo[] {
	if (!projectId || repos.length === 0) return EMPTY_REPOS;
	const projectRepos = repos.filter((repo) => repo.target.projectId === projectId);
	return projectRepos.length === repos.length ? (repos as GitRepoInfo[]) : projectRepos;
}
