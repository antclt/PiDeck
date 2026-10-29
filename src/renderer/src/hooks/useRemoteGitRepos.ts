import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteGitRepo } from "../../../shared/types/git";
import type { RemoteProject } from "../../../shared/types/project";
import { desktopApi } from "../desktopApi";
import { repositoryListingToSelector } from "../utils/remoteGitRepos";

type RemoteGitReposState = { repos?: RemoteGitRepo[]; truncated: boolean };

/**
 * Repository discovery for the panel's scope selector: one bounded read per project identity, plus an explicit reload
 * after the user refreshes or successfully initializes the root repository. Discovery is read-only and never decides
 * the selected scope by itself - the panel owns that state, so a reload can never move the view under the user.
 */
export function useRemoteGitRepos(project: RemoteProject) {
	const projectKey = JSON.stringify([project.id, project.locator.hostId, project.locator.remotePath]);
	const [state, setState] = useState<RemoteGitReposState>({ truncated: false });
	const active = useRef(0);
	const reload = useCallback(async (): Promise<void> => {
		const generation = ++active.current;
		try {
			// 公共入口优先：仓库列表带 truncated/revision/generation，且与本地同形。
			const listing = await desktopApi.git.repositoryList(project.id).catch(() => null);
			if (generation !== active.current) return;
			if (listing !== null && listing.ok) {
				setState(repositoryListingToSelector(listing.value));
				return;
			}
			// 旧宿主/旧装配没有公共入口时保留一版兼容读取；其它失败按失败处理，不二次请求。
			if (listing !== null && listing.code !== "UNSUPPORTED_CAPABILITY") {
				setState({ truncated: false });
				return;
			}
			const result = await desktopApi.git.remoteRepos(project.id);
			// A stale answer from a previous project identity must not populate the new selector.
			if (generation !== active.current) return;
			if (result.ok) setState({ repos: result.repos, truncated: result.truncated });
			else setState({ truncated: false });
		} catch {
			// Discovery is an enhancement: a failed list hides the selector and leaves the root scope working. The
			// repository reads themselves report the stable error when the selected scope cannot be read.
			if (generation === active.current) setState({ truncated: false });
		}
	}, [project.id]);
	useEffect(() => {
		setState({ truncated: false });
		void reload();
		return () => {
			active.current += 1;
		};
	}, [projectKey, reload]);
	return { repos: state.repos, truncated: state.truncated, reload };
}
