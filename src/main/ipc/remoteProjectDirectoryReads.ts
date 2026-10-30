/**
 * 远端项目目录页与批量存在性（从 remoteProjectIpc.ts 拆出，行为保持）。
 *
 * 两者都走同一条只读 `withProjectSession` 边界；这里只负责把目录事实/stat 结果投影成公共形状。
 */

import { codeOf, opFailFromCode, opOk } from "../../shared/op";
import type { ProjectDirectoryPageResult, ProjectPathState, ProjectPathsExistResult } from "../../shared/types/projectFiles";
import type { RemoteProjectTargetResolver } from "./remoteProjectTarget";
import { readRelativePath, readerPath, sessionPort, type RemoteProjectDirSnapshot } from "./remoteProjectReadIpc";
import { createRemoteWorkspaceReader } from "../remote/RemoteWorkspaceReader";

export function projectDirectoryPage(input: { projectId: string; path: string; force: boolean; readDirSnapshot: (projectId: string, relative: string, force: boolean) => Promise<RemoteProjectDirSnapshot>; generationOf: (projectId: string) => string }): Promise<ProjectDirectoryPageResult> {
	const relative = readRelativePath(input.path);
	if (relative === undefined) return Promise.resolve(opFailFromCode("REMOTE_PROJECT_PATH_INVALID"));
	return input.readDirSnapshot(input.projectId, relative, input.force).then((read) => {
		if (!read.ok) return opFailFromCode(read.code);
		const prefix = relative === "" ? "" : relative + "/";
		const entries = read.snapshot.value
			.filter((entry) => entry.kind === "file" || entry.kind === "directory")
			.map((entry) => ({
				target: { projectId: input.projectId, relativePath: prefix + entry.name },
				relativePath: prefix + entry.name,
				type: entry.kind as "file" | "directory",
				// helper 的 fs.list 不逐项探测：远端只能是 unknown，不能伪装成“没有子项”。
				hasChildren: (entry.kind === "directory" ? "unknown" : false) as boolean | "unknown",
			}));
		return opOk({ entries: entries.slice(0, 2000), truncated: entries.length > 2000, revision: read.snapshot.revision, generation: input.generationOf(input.projectId) });
	});
}

export async function projectPathsExist(input: { projectId: string; paths: readonly string[]; projectReadTarget: RemoteProjectTargetResolver }): Promise<ProjectPathsExistResult> {
	const relativePaths: string[] = [];
	for (const path of input.paths) {
		const relative = readRelativePath(path);
		if (relative === undefined) return opFailFromCode("REMOTE_PROJECT_PATH_INVALID");
		relativePaths.push(relative);
	}
	const target = await input.projectReadTarget(input.projectId);
	if ("code" in target) return opFailFromCode(target.code);
	try {
		const outcome = await target.service.withProjectSession(
			target.hostId,
			target.remotePath,
			async (session) => {
				const reader = createRemoteWorkspaceReader({ port: sessionPort(session, target.hostId) });
				const states: ProjectPathState[] = [];
				// 128 路径 = 2 帧（≤64/帧）；批量是全有或全无，含缺失路径时退回逐项只读 stat，
				// 仍然不签发任何 entry/文本授权。
				for (let offset = 0; offset < relativePaths.length; offset += 64) {
					const batch = relativePaths.slice(offset, offset + 64);
					try {
						const answer = await reader.statMany(target.hostId, batch.map(readerPath));
						for (let index = 0; index < batch.length; index += 1) states.push({ target: { projectId: input.projectId, relativePath: batch[index] }, exists: true, isDirectory: answer.entries[index]?.kind === "directory" });
					} catch (error) {
						if (codeOf(error, "REMOTE_PROJECT_READ_FAILED") !== "PATH_NOT_FOUND") throw error;
						for (const relativePath of batch) {
							try {
								const fileStat = await reader.stat(target.hostId, readerPath(relativePath));
								states.push({ target: { projectId: input.projectId, relativePath }, exists: true, isDirectory: fileStat.kind === "directory" });
							} catch (inner) {
								if (codeOf(inner, "REMOTE_PROJECT_READ_FAILED") !== "PATH_NOT_FOUND") throw inner;
								states.push({ target: { projectId: input.projectId, relativePath }, exists: false, isDirectory: false });
							}
						}
					}
				}
				return states;
			},
			{ requireReady: true },
		);
		return outcome.ok ? opOk(outcome.value) : opFailFromCode(outcome.code);
	} catch (error) {
		return opFailFromCode(codeOf(error, "REMOTE_PROJECT_READ_FAILED"));
	}
}
