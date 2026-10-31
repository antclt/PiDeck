import { PROJECT_SERVICE_CODES, ProjectServiceError, REMOTE_UNSUPPORTED_DETAIL, unwrapOp, type ProjectGitService, type ProjectServicesApi } from "./projectServiceContracts";
import type { GitCompareRefsValue, GitHistoryPage, GitRef, GitRepositoryListing, GitResourceGroups } from "../../../shared/types/git";
import type { ProjectFileTarget } from "../../../shared/types";

/**
 * Git 读面自 T7 起已经在 main 里按项目位置路由（gitStatus / historyPage / repositoryList /
 * refs / compareRefs 对本地与远端是同一通道），所以两个 provider 的读实现是同一份；
 * 差异只在写面：本机直接委派，远端写需要 main 所有的令牌经纪（Phase C）。
 */
function createReadFace(api: ProjectServicesApi): Pick<ProjectGitService, "status" | "refresh" | "history" | "repos" | "refs" | "compare"> {
	return {
		status(projectId, repoPath) {
			return api.git.status(projectId, repoPath);
		},
		refresh(projectId, repoPath) {
			// 公共 status 通道每次都会重新读事实；这里显式命名 refresh，避免调用方误以为有缓存写。
			return api.git.status(projectId, repoPath);
		},
		async history(projectId, options, repoPath): Promise<GitHistoryPage> {
			return unwrapOp(await api.git.historyPage(projectId, options, repoPath), PROJECT_SERVICE_CODES.remoteFailed);
		},
		async repos(projectId): Promise<GitRepositoryListing> {
			return unwrapOp(await api.git.repositoryList(projectId), PROJECT_SERVICE_CODES.remoteFailed);
		},
		refs(projectId, repoPath): Promise<GitRef[]> {
			return api.git.refs(projectId, repoPath);
		},
		async compare(projectId, base, head, repoPath): Promise<GitCompareRefsValue> {
			return unwrapOp(await api.git.compareRefs(projectId, base, head, repoPath), PROJECT_SERVICE_CODES.remoteFailed);
		},
	};
}

/** 本机 Git provider：读写都直接委派现有 git:* 通道。 */
export function createLocalProjectGitService(api: ProjectServicesApi): ProjectGitService {
	return {
		...createReadFace(api),
		async stage(projectId, targets, repoPath) {
			await api.git.stage(projectId, targets, repoPath);
		},
		async unstage(projectId, targets, repoPath) {
			await api.git.unstage(projectId, targets, repoPath);
		},
		async commit(projectId, message, repoPath) {
			await api.git.commit(projectId, message, repoPath);
		},
		async discard(projectId, resources, repoPath) {
			await api.git.discardFiles(projectId, resources, repoPath);
		},
	};
}

function unsupportedWrite(): never {
	throw new ProjectServiceError(PROJECT_SERVICE_CODES.unsupported, "rejected", REMOTE_UNSUPPORTED_DETAIL.gitWrite);
}

/** 远端 Git provider：读面与本地同一份；写面在 Phase C（令牌经纪）之前显式拒绝，不假装成功。 */
export function createRemoteProjectGitService(api: ProjectServicesApi): ProjectGitService {
	return {
		...createReadFace(api),
		async stage() {
			unsupportedWrite();
		},
		async unstage() {
			unsupportedWrite();
		},
		async commit() {
			unsupportedWrite();
		},
		async discard() {
			unsupportedWrite();
		},
	};
}

export type { ProjectGitService as ProjectGitServiceImpl, ProjectFileTarget as ProjectGitTarget };
