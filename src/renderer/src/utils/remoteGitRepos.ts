import type { GitRepositoryListing, RemoteGitRepo } from "../../../shared/types/git";

/**
 * 公共仓库列表 → 选择器使用的扁平项（v5 T8）。
 *
 * 选择器的 scope 只认项目相对路径：`relativePath` 是唯一可写回 scope 的值，`displayPath` 只是标签；
 * `truncated` 必须原样带到 UI，不能因为“只是增强功能”就吞掉。
 */
export function repositoryListingToSelector(listing: GitRepositoryListing): { repos: RemoteGitRepo[]; truncated: boolean } {
	return {
		repos: listing.repos.map((repo) => ({ path: repo.relativePath, name: repo.name })),
		truncated: listing.truncated,
	};
}
