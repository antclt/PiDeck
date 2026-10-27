import type { RemoteWorkspaceEntry } from "../../../../shared/types/remoteHost";

/**
 * 远端目录条目排序：目录在前、文件在后，同类按名字。
 *
 * 与本地文件树读法一致；抽成纯函数是为了让「顺序」这条规则可以离开 React 单测。
 */
export function sortRemoteEntries(entries: readonly RemoteWorkspaceEntry[]): RemoteWorkspaceEntry[] {
	return [...entries].sort((first, second) => (first.kind === second.kind ? first.name.localeCompare(second.name) : first.kind === "directory" ? -1 : 1));
}

/** 主机未连接是最常见的失败，且与「路径有问题」完全不同：直接说怎么办，而不是只扔稳定码。 */
export function isRemoteHostNotConnectedCode(code: string): boolean {
	return code === "SSH_HOST_NOT_READY" || code === "SSH_CONNECTION_FAILED";
}

export const remoteEntryRelativePath = (segments: string[], name: string): string => [...segments, name].join("/");
export const remoteEntryParentPath = (segments: string[]): string => segments.join("/");
