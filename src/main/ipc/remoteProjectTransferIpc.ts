/**
 * 远端项目的文件传入/传出（本机 ↔ 远端）。
 *
 * 单独成文件的两个理由：
 * 1. 这两条通道都要弹系统对话框并做本机 IO，与「只读项目浏览」是不同的事；
 * 2. `remoteProjectIpc.ts` 已经在 400 行红线附近，继续往里塞会让那个文件同时管列表、搜索、
 *    登记与传输四件事。
 *
 * 共用的主机/根解析来自 `createRemoteProjectTargetResolver`（唯一实现，不在两处各写一遍）。
 */

import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { BrowserWindow, dialog, ipcMain } from "electron";
import { codeOf } from "../../shared/op";
import { ipcChannels } from "../../shared/ipc";
import type { RemoteProjectDownloadResult, RemoteProjectUploadResult } from "../../shared/types/remoteHost";
import type { RemoteHostConnectionService, RemoteProjectSession } from "../remote/RemoteHostConnectionService";
import type { RemoteProjectTarget } from "./remoteProjectTarget";
import { REMOTE_PROJECT_UPLOAD_MAX_BYTES } from "../remote/RemoteProjectFileUpload";
import { createRemoteWorkspaceReader, type RemoteWorkspacePort } from "../remote/RemoteWorkspaceReader";
import { REMOTE_PROJECT_TRASH_DIR } from "../remote/RemoteProjectEntryCommands";
import { createRemoteProjectTargetResolver } from "./remoteProjectTarget";
import { createLocalIoBudget, LOCAL_FILE_IO_TIMEOUT_MS, LOCAL_IO_TIMEOUT_CODE, parseLocalUploadPaths, withLocalIoTimeout } from "./remoteUploadPaths";

const CONTROL = /[\u0000-\u001f\u007f]/;

// codeOf 只有一份实现（`shared/op.ts`）。

export function registerRemoteProjectTransferIpc(input: { enabled: boolean; service?: () => RemoteHostConnectionService | undefined | Promise<RemoteHostConnectionService | undefined>; locator?: (projectId: string) => { kind: "ssh"; hostId: string; remotePath: string } | undefined }): void {
	const projectTarget = createRemoteProjectTargetResolver({ service: input.service, locator: input.locator });
	/** 与只读通道逐字同构：hostId 再校验一次，避免 reader 的诊断指向另一台主机。 */
	const sessionPort = (session: RemoteProjectSession, hostId: string): RemoteWorkspacePort => ({
		request: (requestHostId, method, params, options) => (requestHostId === hostId ? session.request(method, params, options) : Promise.reject(new Error("SSH_HOST_NOT_READY"))),
		cancel: (requestHostId, requestId, options) => (requestHostId === hostId ? session.cancel(requestId, options) : Promise.reject(new Error("SSH_HOST_NOT_READY"))),
	});
	/** 与只读通道同一条相对路径判据：拒绝绝对路径、`..` 与保留命名空间。 */
	const readRelative = (value: unknown): string | undefined => {
		if (typeof value !== "string") return undefined;
		const trimmed = value.trim();
		if (trimmed === "") return "";
		if (trimmed.length > 4096 || trimmed.startsWith("/") || CONTROL.test(trimmed)) return undefined;
		if (trimmed.split("/").some((segment) => segment === ".." || segment === "")) return undefined;
		return trimmed;
	};

	/**
	 * 逐条上传并如实回报。
	 *
	 * 一个文件失败不影响其余项：多选/拖放一次传十个，把整批压成一个布尔值等于让用户猜哪个没上去。
	 * 只有「一个都没成」才整批按失败返回（界面那时只需要一条错误）。
	 */
	const uploadMany = async (target: RemoteProjectTarget, directory: string, localPaths: readonly string[]): Promise<RemoteProjectUploadResult> => {
		const uploaded: Array<{ name: string; bytes: number }> = [];
		const failed: Array<{ name: string; code: string }> = [];
		const budget = createLocalIoBudget();
		for (const localPath of localPaths) {
			const name = basename(localPath);
			// 预算只统计本机 IO（stat + readFile）的耗时：把远端上传耗时也算进来，
			// 一次慢上传就能把后面本机完全正常的文件扣成「本机 IO 超时」。
			let localIoSplit = 0;
			try {
				// 本机 IO 也可能挂死：拖进来的 UNC / 已断开的网络盘上 `stat()` 会一直等（Windows 上尤其），
				// 那会把这一次 IPC 永久挂在「上传中」。单条有上限，整批另有预算：第一条超时后剩余项
				// 直接失败——`stat` 都不返回说明这些路径整体不可用，逐条再等没有信息增量。
				if (budget.exhausted()) throw new Error(LOCAL_IO_TIMEOUT_CODE);
				const statStartedAt = Date.now();
				const info = await withLocalIoTimeout(stat(localPath), Math.min(LOCAL_FILE_IO_TIMEOUT_MS, budget.remaining()));
				localIoSplit += Date.now() - statStartedAt;
				if (!info.isFile()) throw new Error("REMOTE_UPLOAD_NOT_A_FILE");
				if (info.size < 1 || info.size > REMOTE_PROJECT_UPLOAD_MAX_BYTES) throw new Error("REMOTE_FILE_TOO_LARGE");
				const readStartedAt = Date.now();
				const bytes = await withLocalIoTimeout(readFile(localPath), Math.min(LOCAL_FILE_IO_TIMEOUT_MS, budget.remaining()));
				localIoSplit += Date.now() - readStartedAt;
				await target.service.uploadProjectFile({ hostId: target.hostId, root: target.remotePath, relative: directory === "" ? name : `${directory}/${name}`, bytes });
				budget.spend(localIoSplit);
				uploaded.push({ name, bytes: bytes.length });
			} catch (error) {
				const code = codeOf(error, "REMOTE_UPLOAD_FAILED");
				// 本机 IO 超时（或整批路径都不可用）就把预算清零，剩余项立刻失败而不是各等 30s。
				// 超时说明这些路径整体不可用：直接清零，剩余项立即失败而不是各等一个单条上限。
				budget.spend(code === LOCAL_IO_TIMEOUT_CODE ? budget.remaining() : localIoSplit);
				failed.push({ name, code });
			}
		}
		// 一个都没成：把**第一条真实失败码**交出去。之前多文件全失败时折叠成笼统的
		// REMOTE_UPLOAD_FAILED，于是「网络盘断掉」这种最需要说清的场景反而看不到原因。
		if (uploaded.length === 0 && failed.length > 0) return { ok: false, code: failed[0].code };
		if (uploaded.length === 0) return { ok: false, code: "REMOTE_UPLOAD_FAILED" };
		return { ok: true, uploaded, failed };
	};

	/**
	 * 把本机文件上传到远端项目的某个目录。
	 *
	 * 选择对话框在主进程（本机路径绝不从渲染层来），字节经 `service.uploadProjectFile` 的 stdin 分块
	 * 通道写到远端——不是文本编辑器保存，二进制与大文件都走同一条路。多选时逐个上传并如实回报：
	 * 一个失败不影响其余项，也不把整批变成一个布尔值。
	 */
	ipcMain.handle(ipcChannels.remoteProjectUpload, async (event, projectIdValue: unknown, directoryValue: unknown): Promise<RemoteProjectUploadResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		const directory = typeof directoryValue === "string" ? directoryValue.trim() : "";
		// 目录相对路径复用同一套校验（空串 = 项目根，合法）。
		if (directoryValue !== undefined && directory !== "" && readRelative(directory) === undefined) return { ok: false, code: "REMOTE_PROJECT_PATH_INVALID" };
		const target = await projectTarget(projectIdValue);
		if ("code" in target) return { ok: false, code: target.code };

		const owner = event.sender.isDestroyed() ? undefined : BrowserWindow.fromWebContents(event.sender);
		const options = { properties: ["openFile", "multiSelections"] as Array<"openFile" | "multiSelections"> };
		const choice = owner === null || owner === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options);
		if (choice.canceled === true || !Array.isArray(choice.filePaths) || choice.filePaths.length === 0) return { ok: false, code: "REMOTE_UPLOAD_CANCELED", canceled: true };

		return await uploadMany(target, directory, choice.filePaths);
	});

	/**
	 * 拖放上传：渲染层给出本机文件绝对路径（来自 `webUtils.getPathForFile`），不再弹对话框。
	 *
	 * 信任模型：路径由**用户拖放动作**产生，但渲染层仍在往主进程传本机路径，所以这里逐条校验
	 * （绝对路径、长度、控制字符）+ 逐个 `stat` 确认是常规文件，再走与对话框上传完全相同的
	 * 大小门与写通道。也就是说「拖放」只是省掉一次选文件，不放宽任何远端写约束。
	 */
	ipcMain.handle(ipcChannels.remoteProjectUploadPaths, async (_event, projectIdValue: unknown, directoryValue: unknown, pathsValue: unknown): Promise<RemoteProjectUploadResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		const directory = typeof directoryValue === "string" ? directoryValue.trim() : "";
		if (directoryValue !== undefined && directory !== "" && readRelative(directory) === undefined) return { ok: false, code: "REMOTE_PROJECT_PATH_INVALID" };
		const parsed = parseLocalUploadPaths(pathsValue);
		if (!parsed.ok) return { ok: false, code: "REMOTE_UPLOAD_INVALID_PATHS" };
		const target = await projectTarget(projectIdValue);
		if ("code" in target) return { ok: false, code: target.code };
		return await uploadMany(target, directory, parsed.paths);
	});

	/**
	 * 把远端项目里的一个文件下载到本机。
	 *
	 * 与 `remoteProjectRead` 共用同一条读链路（同一个 `withProjectSession` 边界、同一个 reader），
	 * 区别只在落点：这里弹保存对话框并把字节写到本机，而不是把 base64 交给渲染层。
	 * 为什么放主进程：写本机路径必须由用户经系统对话框选择，渲染层只传「远端哪个文件」。
	 */
	ipcMain.handle(ipcChannels.remoteProjectDownload, async (event, projectIdValue: unknown, pathValue: unknown): Promise<RemoteProjectDownloadResult> => {
		if (!input.enabled) return { ok: false, code: "REMOTE_FEATURE_DISABLED" };
		const relative = readRelative(pathValue);
		if (relative === undefined || relative === "") return { ok: false, code: "REMOTE_PROJECT_PATH_INVALID" };
		// 回收站不是用户文件：与读通道同一道门（路径在远端，绝不能进本机）。
		if (relative === REMOTE_PROJECT_TRASH_DIR || relative.startsWith(REMOTE_PROJECT_TRASH_DIR + "/")) return { ok: false, code: "REMOTE_FILE_PROTECTED_PATH" };
		const target = await projectTarget(projectIdValue);
		if ("code" in target) return { ok: false, code: target.code };
		let content: Uint8Array;
		try {
			const outcome = await target.service.withProjectSession(target.hostId, target.remotePath, async (session) => {
				const reader = createRemoteWorkspaceReader({ port: sessionPort(session, target.hostId) });
				return reader.readFile(target.hostId, relative);
			});
			if (!outcome.ok) return { ok: false, code: outcome.code };
			content = outcome.value.content;
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_PROJECT_READ_FAILED") };
		}
		// 对话框挂到发起窗口上：无归属的对话框在 macOS 上会飘到别的 space，在 Windows 上可能被主窗口盖住。
		const owner = event.sender.isDestroyed() ? undefined : BrowserWindow.fromWebContents(event.sender);
		const options = { defaultPath: basename(relative) };
		const choice = owner === null || owner === undefined ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(owner, options);
		if (choice.canceled === true || typeof choice.filePath !== "string" || choice.filePath.length === 0) return { ok: false, code: "REMOTE_DOWNLOAD_CANCELED", canceled: true };
		try {
			await writeFile(choice.filePath, content);
		} catch (error) {
			return { ok: false, code: codeOf(error, "REMOTE_DOWNLOAD_WRITE_FAILED") };
		}
		return { ok: true, path: choice.filePath, bytes: content.length };
	});
}
