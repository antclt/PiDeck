import { useMemo } from "react";
import type { Project } from "../../../shared/types";
import { desktopApi } from "../desktopApi";
import type { ProjectServices } from "../services/projectServiceContracts";
import { createProjectServices } from "../services/projectServices";

/**
 * 按项目位置提供面板服务（Phase A：先只提供工厂，不强迫现有面板迁移）。
 * Phase B 起文件/Git 面板改用本 hook，组件内不再出现 isRemoteProject 的通道分支。
 */
export function useProjectServices(project: Project): ProjectServices {
	return useMemo(() => createProjectServices(project, desktopApi), [project]);
}
