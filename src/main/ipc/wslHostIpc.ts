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
 *
 * onProfileChanged（W1 收口）：档案 update/remove 成功后通知装配层失效该档案的资源管理器池。
 * 池自身在每次请求时也会重读档案（distro/user 变即重建），这个端口只是让"已移除/已改名"立刻
 * 生效、不必等下一次访问；回调失败绝不能把已成功的档案写入回滚成错误响应。
 */
export type WslHostProfileChangeHook = (hostId: string) => void;

export type WslHostIpcInput = {
	userDataDir: string;
	references?: WslHostReferences;
	/** update/remove 成功后的失效通知（装配层接 PiResourceManagerPool.invalidate）。 */
	onProfileChanged?: WslHostProfileChangeHook;
};

export function registerWslHostIpc(input: WslHostIpcInput): void {
	const open = () => createWslHostStore(input.userDataDir, input.references === undefined ? {} : { references: input.references });
	const notifyProfileChanged = (hostId: string): void => {
		const hook = input.onProfileChanged;
		if (!hook) return;
		try {
			hook(hostId);
		} catch {
			// 失效通知是副作用，不是写入结果的一部分：档案已经落盘，这里静默吞掉。
		}
	};

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
			const host = await store.update(id, patch);
			notifyProfileChanged(host.id);
			return { ok: true, host };
		} catch (error) {
			return { ok: false, code: codeOf(error, WSL_HOST_CODES.invalid) };
		}
	});

	ipcMain.handle(ipcChannels.remoteHostsWslRemove, async (_event, id: unknown): Promise<WslHostRemoveResult> => {
		try {
			const store = await open();
			const removedId = await store.remove(id);
			notifyProfileChanged(removedId);
			return { ok: true, id: removedId };
		} catch (error) {
			return { ok: false, code: codeOf(error, WSL_HOST_CODES.storeInvalid) };
		}
	});
}
