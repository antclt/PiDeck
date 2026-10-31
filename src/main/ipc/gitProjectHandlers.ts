import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { withWslGitIdentity } from "../git/gitWslContext";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import { resolveProjectWslIdentity } from "../wsl/WslProjectEnvironment";

/** Bind Git IPC work to the trusted project's WSL identity, including project-file-target handlers. */
export function createProjectGitHandler(ipc: Pick<IpcMain, "handle">, projects: Pick<ProjectStore, "get">, settings: Pick<SettingsStore, "get">) {
	return <Args extends unknown[], Result>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: Args) => Result): void => {
		ipc.handle(channel, (event, ...args: Args) => {
			const first = args[0];
			const projectId = typeof first === "string" ? first : typeof first === "object" && first !== null && "projectId" in first && typeof first.projectId === "string" ? first.projectId : undefined;
			const project = projectId !== undefined ? projects.get(projectId) : undefined;
			const identity = project?.environment === "wsl" ? (resolveProjectWslIdentity(project, settings.get()) ?? { distro: "", user: "" }) : undefined;
			return withWslGitIdentity(identity, () => listener(event, ...args));
		});
	};
}
