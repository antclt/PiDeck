import type { FileTreeNode } from "../../../shared/types";
import { findDirectoryNodeByPath, parseFileTreeKey, projectFileKey } from "./fileTreeLazy";

/**
 * 本机文件树的展开键（v5 W5）。本机 `files:list` 节点经 `withProjectTargets` 带 target，
 * `fileTreeNodeKey` 因此是 `project:<projectId>\0<relative>`；展开集必须与行组件同键。
 * controller 内部只认项目相对路径，两个方向都集中在这里转换。
 */
export function localExpandedDirKey(projectId: string, relativePath: string): string {
	return projectFileKey({ projectId, relativePath });
}

export function localExpandedDirRelative(key: string, nodes: FileTreeNode[] = []): string | undefined {
	const target = parseFileTreeKey(key);
	if (target !== undefined) return target.relativePath;
	// 兼容旧版/降级节点的 relative: 键。
	if (key.startsWith("relative:")) return key.slice("relative:".length);
	// 兼容早期绝对路径键：迁移函数会先换成项目键，这里只兜底已可见节点。
	return findDirectoryNodeByPath(nodes, key)?.relativePath;
}
