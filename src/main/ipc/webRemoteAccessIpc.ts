/**
 * 外网访问 IPC 域：cloudflare quick tunnel / tailscale serve 的状态查询与启停，
 * 以及 EasyTier 只读渠道的聚合状态（其状态随 remote-access-state 一起返回，不单独提供启停）。
 * 只做输入校验和适配，业务全部在 RemoteAccessManager；
 * 状态推送由装配层经构造函数 pushState 注入（指向主窗口 webContents.send）。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { isRemoteAccessChannelId } from "../../shared/types/remoteAccess";
import type { RemoteAccessManager } from "../web/remoteAccess/RemoteAccessManager";
import type { EasyTierManagedConfig } from "../web/remoteAccess/easytierService";
import { sanitizeEasyTierNetworkName, sanitizeEasyTierNetworkSecret, sanitizeEasyTierPeers } from "../../shared/easytierPeers";
import { sanitizeEasyTierVirtualIp } from "../../shared/types/settings";

/**
 * 把渲染层传来的草稿配置收敛成托管配置：逐项走共享清洗函数，非法值一律丢弃。
 * 网络名或密钥为空时返回 null（保持"配置不全"的语义，由 manager 给出提示）。
 */
function toEasyTierManagedConfig(value: unknown): EasyTierManagedConfig | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const networkName = sanitizeEasyTierNetworkName(raw.networkName);
	const networkSecret = sanitizeEasyTierNetworkSecret(raw.networkSecret);
	if (!networkName || !networkSecret) return null;
	return {
		networkName,
		networkSecret,
		peers: sanitizeEasyTierPeers(raw.peers),
		bindIpv4: sanitizeEasyTierVirtualIp(raw.bindIpv4),
		instanceName: networkName,
	};
}

export function registerWebRemoteAccessIpc(deps: { remoteAccessManager: RemoteAccessManager }): void {
	const { remoteAccessManager } = deps;

	ipcMain.handle(ipcChannels.webRemoteAccessState, () => remoteAccessManager.getState());

	ipcMain.handle(ipcChannels.webRemoteAccessStart, (_event, channel: unknown, override: unknown) => {
		if (!isRemoteAccessChannelId(channel)) {
			return { ok: false as const, error: `无效的外网访问渠道: ${String(channel)}` };
		}
		// EasyTier：设置弹框里改完没保存就点启动时，用渲染层草稿覆盖已落盘设置；其余渠道忽略该参数。
		const config = channel === "easytier" ? toEasyTierManagedConfig(override) : null;
		return remoteAccessManager.start(channel, config).then((state) => ({ ok: true as const, state }));
	});

	ipcMain.handle(ipcChannels.webRemoteAccessStop, (_event, channel: unknown) => {
		if (!isRemoteAccessChannelId(channel)) {
			return { ok: false as const, error: `无效的外网访问渠道: ${String(channel)}` };
		}
		return remoteAccessManager.stop(channel).then((state) => ({ ok: true as const, state }));
	});

	ipcMain.handle(ipcChannels.webRemoteAccessRefresh, () => remoteAccessManager.refresh());
}
