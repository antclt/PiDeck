import { useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import { isRemoteProject } from "../../../../shared/projectLocation";
import type { Project } from "../../../../shared/types";
import { remoteHostIdentityIndexAtom } from "../../atoms/remote-host-atoms";
import { applyRemoteHostStateChange, mergeRemoteHostIdentity, readRemoteHostDirectory, readRemoteHostStateChange } from "../../utils/remoteHostIdentity";

/**
 * 侧栏远端项目行的主机身份/连接状态来源。
 *
 * - 目录（label/hostId）只读一次 `remoteHosts.list()`：它不发请求、不启动 SSH，因此可以随项目清单
 *   懒加载；功能未启用时保留空索引，侧栏显示「未知主机」而不是编一个名字。
 * - 连接状态没有同步查询接口，只订阅 `remote:state-changed` 推送；`connect()` 的返回值和之后的自愈/
 *   断线都走同一条推送，避免侧栏与设置页各推一套。
 * - 没有远端项目时不发任何 IPC：纯本地用户不会因为这一行 UI 多一次主进程往返。
 */

type RemoteHostIdentityPort = {
	list(): Promise<unknown>;
	onStateChange(listener: (change: unknown) => void): () => void;
};

function unwiredPort(): RemoteHostIdentityPort {
	return {
		list: async () => ({ ok: false, code: "REMOTE_HOST_IDENTITY_UNWIRED" }),
		onStateChange: () => () => undefined,
	};
}

/** 逐层结构收窄 `desktopApi.remoteHosts`；任何一层不是函数就是「未接线」。 */
export function createRemoteHostIdentityPort(hostApi: unknown): RemoteHostIdentityPort {
	try {
		if (typeof hostApi !== "object" || hostApi === null) return unwiredPort();
		const hosts: unknown = Reflect.get(hostApi, "remoteHosts");
		if (typeof hosts !== "object" || hosts === null) return unwiredPort();
		const list = Reflect.get(hosts, "list");
		const onStateChange = Reflect.get(hosts, "onStateChange");
		if (typeof list !== "function" || typeof onStateChange !== "function") return unwiredPort();
		return {
			list: () => Promise.resolve(list.call(hosts)),
			onStateChange: (listener) => {
				const unsubscribe: unknown = onStateChange.call(hosts, listener);
				return typeof unsubscribe === "function" ? (unsubscribe as () => void) : () => undefined;
			},
		};
	} catch {
		return unwiredPort();
	}
}

/**
 * 载入主机目录并订阅状态推送。
 *
 * 依赖是「远端项目用到的主机 id 集合」而不是项目数组本身：折叠、改名、会话刷新都会换项目对象，
 * 但主机集合不变时不该重新发 list。
 */
export function useRemoteHostIdentityIndex(hostApi: unknown, projects: readonly Project[]): void {
	const setIndex = useSetAtom(remoteHostIdentityIndexAtom);
	const portRef = useRef<RemoteHostIdentityPort>(createRemoteHostIdentityPort(hostApi));
	portRef.current = createRemoteHostIdentityPort(hostApi);
	const hostIds = projects
		.filter(isRemoteProject)
		.map((project) => project.locator.hostId)
		.sort()
		.join(",");

	useEffect(() => {
		const port = portRef.current;
		let active = true;
		if (hostIds.length > 0) {
			void (async () => {
				let result: unknown;
				try {
					result = await port.list();
				} catch {
					return;
				}
				// 卸载或主机集合变化后的迟到结果整体丢弃，不能把旧目录盖到新状态上。
				if (!active) return;
				const directory = readRemoteHostDirectory(result);
				if (directory !== undefined) setIndex((previous) => mergeRemoteHostIdentity(previous, directory));
			})();
		}
		const unsubscribe = port.onStateChange((change) => {
			const parsed = readRemoteHostStateChange(change);
			if (parsed === undefined) return;
			setIndex((previous) => applyRemoteHostStateChange(previous, parsed));
		});
		return () => {
			active = false;
			unsubscribe();
		};
	}, [hostIds, setIndex]);
}
