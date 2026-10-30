import { isLocalProject } from "../../../shared/projectLocation";
import type { Project } from "../../../shared/types";

/**
 * 侧栏「启用/关闭工作区」菜单入口的判据。
 *
 * worktree 依赖本机 Git 目录：Chat 项目没有 Git 工作区语义（沿用既有行为），
 * 远端 SSH 项目没有可交给本机 Git 的路径。主进程也会拒绝远端项目
 * （projectsIpc 的 UNSUPPORTED_PROJECT_LOCATION），但入口本身不应先看起来可用。
 */
export function shouldShowWorktreeMenuEntry(project: Project): boolean {
	if (project.kind === "chat") return false;
	return isLocalProject(project);
}

/**
 * 点击「启用/关闭工作区」时的能力判据：返回稳定文案 key，null 表示可执行。
 *
 * 只挡远端项目；Chat 项目仍是本机项目，菜单入口由上一条判据隐藏。
 * 保留这条守卫是防御未来新增入口把主进程的 UNSUPPORTED_PROJECT_LOCATION 原样 toast 出来。
 */
export function worktreeToggleUnavailableKey(project: Project): "remoteGit.worktreeUnsupported" | null {
	return isLocalProject(project) ? null : "remoteGit.worktreeUnsupported";
}
