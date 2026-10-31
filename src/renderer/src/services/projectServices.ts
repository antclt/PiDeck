import type { Project } from "../../../shared/types";
import { isRemoteProject } from "../../../shared/projectLocation";
import { createLocalProjectFileService, createRemoteProjectFileService } from "./projectFileService";
import { createLocalProjectGitService, createRemoteProjectGitService } from "./projectGitService";
import type { ProjectServiceCapabilities, ProjectServices, ProjectServicesApi } from "./projectServiceContracts";

export { PROJECT_SERVICE_CODES, ProjectServiceError } from "./projectServiceContracts";

/** 本机项目：所有能力都由本机 provider 承担。 */
export const LOCAL_PROJECT_SERVICE_CAPABILITIES: ProjectServiceCapabilities = {
	files: { write: true, trash: true, contentSearch: true, systemOpen: true, watch: "full" },
	git: { read: true, write: true, worktree: true, compare: true, sync: true },
};

/**
 * 远端项目：文件读写/回收站由 helper 承担；内容搜索能力由 hello/rootStatus 协商；
 * 系统打开没有本机路径；深层 watch 是降级事实（预算 4x32）。Git 读面已统一，写面待 Phase C。
 */
export const REMOTE_PROJECT_SERVICE_CAPABILITIES: ProjectServiceCapabilities = {
	files: { write: true, trash: true, contentSearch: "negotiated", systemOpen: false, watch: "degraded" },
	git: { read: true, write: false, worktree: false, compare: true, sync: false },
};

/**
 * 按项目位置组装面板服务。这是 UI 唯一允许知道“本地/远端”的地方：
 * 组件只消费 ProjectServices，不再自己判断 isRemoteProject 去选通道。
 */
export function createProjectServices(project: Project, api: ProjectServicesApi): ProjectServices {
	if (isRemoteProject(project)) {
		return {
			kind: "remote",
			files: createRemoteProjectFileService(api),
			git: createRemoteProjectGitService(api),
			capabilities: REMOTE_PROJECT_SERVICE_CAPABILITIES,
		};
	}
	return {
		kind: "local",
		files: createLocalProjectFileService(api),
		git: createLocalProjectGitService(api),
		capabilities: LOCAL_PROJECT_SERVICE_CAPABILITIES,
	};
}
