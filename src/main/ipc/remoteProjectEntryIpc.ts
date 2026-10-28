import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { codeOf, opError, opFail, opFailFromCode, opOk, type Op } from "../../shared/op";
import type { RemoteEntryCreateResult, RemoteEntryDeleteResult, RemoteEntryRenameResult, RemoteEntryStatResult, RemoteTrashListResult, RemoteTrashPruneResult, RemoteTrashRestoreResult } from "../../shared/types/remoteFiles";
import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";
import { createRemoteProjectEntryService, REMOTE_FILE_ENTRY_CODES } from "../remote/RemoteProjectEntryService";

const VERSION = /^[a-f0-9]{32}$/;
/** 回收站 id 形状是 IPC 边界的一部分：main 生成、renderer 只回传。 */
const TRASH_ID = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/;
const PROJECT_ID = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value === value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const SENDER = (sender: IpcMainInvokeEvent["sender"]): boolean => Number.isSafeInteger(sender.id) && sender.id >= 1 && !sender.isDestroyed();

/**
 * 远端文件管理 IPC 边界（Phase 5 文件面；docs/remote-file-management-plan.md §3.2/§3.5）。
 *
 * 只做输入形状/值域/发送者/启用门禁与稳定码信封；locator、令牌、主机锁与固定 Node 命令全部在
 * RemoteProjectEntryService。renderer 永远不发送 hostId/绝对路径/摘要。
 * 与文本保存 IPC 各自持有令牌表（互不驱逐）；窗口销毁时本模块撤销本表令牌，文本模块撤销它自己的。
 *
 * 信封形状是契约层的 `Op<T>`（v5 §2「单信封」）：成功 `{ok:true, value}`，失败 `{ok:false, code, outcome}`。
 * `outcome` 由 `code` 落在闭集里推出（`REMOTE_FILE_RESULT_UNCONFIRMED` ⇒ unknown），所以「可能已执行」
 * 这件事在结构上就传得下去，不再依赖渲染层猜码。
 */
export function registerRemoteProjectEntryIpc(input: { enabled: boolean; service: () => RemoteHostConnectionService | undefined | Promise<RemoteHostConnectionService | undefined>; locator: (projectId: string) => { kind: "ssh"; hostId: string; remotePath: string } | undefined }) {
	const entry = createRemoteProjectEntryService({
		locator: (projectId) => {
			const locator = input.locator(projectId);
			return locator === undefined ? undefined : { hostId: locator.hostId, remotePath: locator.remotePath };
		},
		withProject: async (target, work) => {
			const service = await input.service();
			if (!service) throw new Error("REMOTE_CONNECTION_SERVICE_UNAVAILABLE");
			const result = await service.withProjectSession(target.hostId, target.remotePath, (session) => work(session));
			// 连接层的信封只有 {ok, code}：这里升成完整信封（outcome 由码推出），再以异常交给端口。
			if (!result.ok) throw opError(opFailFromCode(result.code));
			return result.value;
		},
	});
	const senders = new Map<number, { sender: IpcMainInvokeEvent["sender"]; destroy: () => void }>();
	function watchSender(sender: IpcMainInvokeEvent["sender"]): number {
		if (!SENDER(sender)) throw new Error("REMOTE_FILE_INPUT_INVALID");
		if (!senders.has(sender.id)) {
			const destroy = () => {
				entry.releaseSender(sender.id);
				senders.delete(sender.id);
			};
			senders.set(sender.id, { sender, destroy });
			sender.once("destroyed", destroy);
		}
		return sender.id;
	}
	/**
	 * 统一信封：启用门禁 → （handler 内）入参校验 → 服务；任何异常都折叠成闭集稳定码。
	 * 门禁关闭时不注册 sender 资源，返回的只有 REMOTE_FEATURE_DISABLED（渲染层连「有这条路」都不该知道）。
	 *
	 * 闭集过滤与迁移前逐字一致：`REMOTE_FILE_ENTRY_CODES` 之外的码（含自由文本、含连接层自己的码）
	 * 一律折成 `REMOTE_FILE_COMMAND_FAILED`，否则这条通道会变成 stderr 的下水道。
	 */
	async function wrap<T>(task: () => Promise<T>): Promise<Op<T>> {
		if (!input.enabled) return opFail("REMOTE_FEATURE_DISABLED");
		try {
			return opOk(await task());
		} catch (error) {
			const code = codeOf(error, "REMOTE_FILE_COMMAND_FAILED");
			return opFailFromCode(REMOTE_FILE_ENTRY_CODES.has(code) ? code : "REMOTE_FILE_COMMAND_FAILED");
		}
	}

	ipcMain.handle(ipcChannels.remoteProjectEntryStat, async (event, projectId: unknown, relative: unknown): Promise<RemoteEntryStatResult> =>
		wrap(async () => {
			if (!PROJECT_ID(projectId) || typeof relative !== "string") throw new Error("REMOTE_FILE_INPUT_INVALID");
			const sender = watchSender(event.sender);
			return await entry.stat(sender, projectId, relative);
		}),
	);

	ipcMain.handle(ipcChannels.remoteProjectFileCreate, async (event, projectId: unknown, parent: unknown, name: unknown): Promise<RemoteEntryCreateResult> =>
		wrap(async () => {
			if (!PROJECT_ID(projectId) || typeof parent !== "string" || typeof name !== "string") throw new Error("REMOTE_FILE_INPUT_INVALID");
			const sender = watchSender(event.sender);
			return await entry.createFile(sender, projectId, parent, name);
		}),
	);

	ipcMain.handle(ipcChannels.remoteProjectDirectoryCreate, async (event, projectId: unknown, parent: unknown, name: unknown): Promise<RemoteEntryCreateResult> =>
		wrap(async () => {
			if (!PROJECT_ID(projectId) || typeof parent !== "string" || typeof name !== "string") throw new Error("REMOTE_FILE_INPUT_INVALID");
			const sender = watchSender(event.sender);
			return await entry.createDirectory(sender, projectId, parent, name);
		}),
	);

	ipcMain.handle(ipcChannels.remoteProjectEntryRename, async (event, projectId: unknown, source: unknown, target: unknown, version: unknown): Promise<RemoteEntryRenameResult> =>
		wrap(async () => {
			if (!PROJECT_ID(projectId) || typeof source !== "string" || typeof target !== "string") throw new Error("REMOTE_FILE_INPUT_INVALID");
			// 令牌格式不合法不烧令牌：形状校验在打开 SSH 之前。
			if (typeof version !== "string" || !VERSION.test(version)) throw new Error("REMOTE_FILE_INPUT_INVALID");
			const sender = watchSender(event.sender);
			return await entry.rename(sender, projectId, source, target, version);
		}),
	);

	ipcMain.handle(ipcChannels.remoteProjectEntryDelete, async (event, projectId: unknown, relative: unknown, version: unknown): Promise<RemoteEntryDeleteResult> =>
		wrap(async () => {
			if (!PROJECT_ID(projectId) || typeof relative !== "string") throw new Error("REMOTE_FILE_INPUT_INVALID");
			if (typeof version !== "string" || !VERSION.test(version)) throw new Error("REMOTE_FILE_INPUT_INVALID");
			const sender = watchSender(event.sender);
			return await entry.deleteEntry(sender, projectId, relative, version);
		}),
	);

	ipcMain.handle(ipcChannels.remoteProjectTrashList, async (event, projectId: unknown): Promise<RemoteTrashListResult> =>
		wrap(async () => {
			if (!PROJECT_ID(projectId)) throw new Error("REMOTE_FILE_INPUT_INVALID");
			const sender = watchSender(event.sender);
			return await entry.listTrash(sender, projectId);
		}),
	);

	ipcMain.handle(ipcChannels.remoteProjectTrashRestore, async (event, projectId: unknown, trashId: unknown): Promise<RemoteTrashRestoreResult> =>
		wrap(async () => {
			if (!PROJECT_ID(projectId) || typeof trashId !== "string" || !TRASH_ID.test(trashId)) throw new Error("REMOTE_FILE_INPUT_INVALID");
			const sender = watchSender(event.sender);
			return await entry.restoreTrash(sender, projectId, trashId);
		}),
	);

	ipcMain.handle(ipcChannels.remoteProjectTrashPrune, async (event, projectId: unknown, trashIds: unknown): Promise<RemoteTrashPruneResult> =>
		wrap(async () => {
			if (!PROJECT_ID(projectId)) throw new Error("REMOTE_FILE_INPUT_INVALID");
			if (!Array.isArray(trashIds) || trashIds.length === 0 || trashIds.length > 32 || trashIds.some((id) => typeof id !== "string" || !TRASH_ID.test(id))) throw new Error("REMOTE_FILE_INPUT_INVALID");
			const sender = watchSender(event.sender);
			return await entry.pruneTrash(sender, projectId, trashIds);
		}),
	);

	return {
		/** 退出清理：撤销全部 sender 令牌并解除窗口监听（与文本保存 IPC 各管各的表）。 */
		dispose(): void {
			for (const { sender, destroy } of senders.values()) sender.removeListener("destroyed", destroy);
			senders.clear();
		},
		/** 测试/诊断：入口服务（令牌表大小与 releaseSender 的可观察语义）。 */
		service: entry,
	};
}
export type RemoteProjectEntryIpc = ReturnType<typeof registerRemoteProjectEntryIpc>;
