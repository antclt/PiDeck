import type { GitRepoInfo } from "../../../shared/types";

const EMPTY_REPOS: GitRepoInfo[] = [];

/**
 * 按 (仓库列表引用, projectId) 缓存过滤结果。
 *
 * 只缓存引用、不缓存内容：`repos` 一变（哪怕内容相同）缓存自然失效，
 * 所以不存在「列表变了但看到旧结果」的可能。
 */
const filteredCache = new WeakMap<readonly GitRepoInfo[], Map<string, GitRepoInfo[]>>();

/**
 * 只保留属于当前项目的仓库条目。
 *
 * 切项目时 GitDrawerHost / GitPanel 复用同一实例（见 GitPanel 的「项目切换会复用同一个
 * GitPanel 实例」处理），而仓库列表要等一次 listRepos IPC 才回来；这段时间 scope 里仍是
 * 上一项目的仓库，其 target.projectId 属于旧项目。继续把它下发给面板，Git 一侧的
 * parseGitProjectTarget 会以 GIT_PROJECT_TARGET_MISMATCH 拒绝，变更区就挂出一条错误。
 *
 * **返回值身份必须稳定**（同输入 → 同引用，过滤后也一样）：GitDrawerHost 有两个
 * `useEffect` 以 `repos` 为依赖，其中一个每次都写入新的 state 对象；每次渲染换新数组
 * 会让 effect 反复重跑 → setState → 再渲染 → 再换新数组，无限循环直到 React 抛
 * 「Maximum update depth exceeded」（React #185）。所以过滤结果按引用缓存，
 * 不要改成「每次 filter 一个新数组」。
 */
export function reposForProject(projectId: string | undefined, repos: readonly GitRepoInfo[]): GitRepoInfo[] {
	if (!projectId || repos.length === 0) return EMPTY_REPOS;
	let byProject = filteredCache.get(repos);
	if (!byProject) {
		byProject = new Map<string, GitRepoInfo[]>();
		filteredCache.set(repos, byProject);
	}
	const cached = byProject.get(projectId);
	if (cached) return cached;
	const projectRepos = repos.filter((repo) => repo.target.projectId === projectId);
	// 没跨项目条目时返回原引用（省一次分配，也让身份天然稳定）
	const result = projectRepos.length === repos.length ? (repos as GitRepoInfo[]) : projectRepos;
	byProject.set(projectId, result);
	return result;
}
