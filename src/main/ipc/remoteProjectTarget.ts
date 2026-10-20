/**
 * 远端项目「按 projectId 找主机与根」的唯一解析实现（项目域读通道、上传下载、搜索共用）。
 *
 * 抽出来的理由：这段判定（输入校验 → 登记端口存在 → ssh locator → 连接服务）每个远端项目 IPC 都要
 * 走一遍，复制一份就会漂移成「列表认的路径和下载认的路径不一样」。它**不做任何会话工作**：切换 root、
 * 建会话、读文件必须在调用方各自的 `withProjectSession` 里一起完成，否则第二个项目的 root 切换会落进
 * 第一个项目一次多块读取的中间——那正是这条链路曾经出过的事故形态。
 *
 * 每个失败都是稳定码；非 ssh 项目被拒绝而不是猜测。
 */

import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";

export type RemoteProjectTarget = { hostId: string; remotePath: string; service: RemoteHostConnectionService };

export type RemoteProjectTargetResolver = (projectId: unknown) => Promise<RemoteProjectTarget | { code: string }>;

export function createRemoteProjectTargetResolver(input: { service?: () => RemoteHostConnectionService | undefined | Promise<RemoteHostConnectionService | undefined>; locator?: (projectId: string) => { kind: "ssh"; hostId: string; remotePath: string } | undefined }): RemoteProjectTargetResolver {
	/** 构建服务可能故意失败（ssh 客户端探测不过）。折叠成稳定码，绝不让 rejection 穿过 IPC 边界。 */
	const resolveService = async (): Promise<{ service: RemoteHostConnectionService } | { code: string }> => {
		try {
			const service = await input.service?.();
			return service === undefined ? { code: "REMOTE_CONNECTION_SERVICE_UNAVAILABLE" } : { service };
		} catch {
			return { code: "REMOTE_CONNECTION_SERVICE_UNAVAILABLE" };
		}
	};
	return async (projectId: unknown): Promise<RemoteProjectTarget | { code: string }> => {
		if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 256) return { code: "REMOTE_PROJECT_TARGET_INVALID" };
		if (input.locator === undefined) return { code: "REMOTE_PROJECT_ENROLL_UNAVAILABLE" };
		const locator = input.locator(projectId);
		if (locator === undefined) return { code: "REMOTE_PROJECT_NOT_FOUND" };
		if (locator.kind !== "ssh") return { code: "UNSUPPORTED_PROJECT_LOCATION" };
		const resolved = await resolveService();
		if ("code" in resolved) return { code: resolved.code };
		return { hostId: locator.hostId, remotePath: locator.remotePath, service: resolved.service };
	};
}
