import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { codeOf } from "../../shared/op";
import type { WslHostListResult, WslHostMutationResult, WslHostRemoveResult } from "../../shared/types/wslHost";
import { createWslHostStore, WSL_HOST_CODES, type WslHostReferences } from "../wsl/WslHostStore";

/**
 * WSL 连接档案 IPC（第 9 步）。
 *
 * 不设 feature gate：WSL 是 Windows 上的本机环境能力，入口可见性由 UI 的平台判断负责；
 * 通道本身只读写本机档案文件，不启动 wsl.exe、不接触任何发行版数据。
 */
export function registerWslHostIpc(input: { userDataDir: string; references?: WslHostReferences }): void {
	const open = () => createWslHostStore(input.userDataDir, input.references === undefined ? {} : { references: input.references });

	ipcMain.handle(ipcChannels.remoteHostsWslList, async (): Promise<WslHostListResult> => {
		try {
			const store = await open();
			return { ok: true, hosts: await store.list() };
		} catch (error) {
			return { ok: false, code: codeOf(error, WSL_HOST_CODES.storeInvalid) };
		}
	});

	ipcMain.handle(ipcChannels.remoteHostsWslAdd, async (_event, value: unknown): Promise<WslHostMutationResult> => {
		try {
			const store = await open();
			return { ok: true, host: await store.add(value) };
		} catch (error) {
			return { ok: false, code: codeOf(error, WSL_HOST_CODES.invalid) };
		}
	});

	ipcMain.handle(ipcChannels.remoteHostsWslUpdate, async (_event, id: unknown, patch: unknown): Promise<WslHostMutationResult> => {
		try {
			const store = await open();
			return { ok: true, host: await store.update(id, patch) };
		} catch (error) {
			return { ok: false, code: codeOf(error, WSL_HOST_CODES.invalid) };
		}
	});

	ipcMain.handle(ipcChannels.remoteHostsWslRemove, async (_event, id: unknown): Promise<WslHostRemoveResult> => {
		try {
			const store = await open();
			return { ok: true, id: await store.remove(id) };
		} catch (error) {
			return { ok: false, code: codeOf(error, WSL_HOST_CODES.storeInvalid) };
		}
	});
}
