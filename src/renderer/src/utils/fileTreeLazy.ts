import type { FileTreeNode } from "../../../shared/types";

/** 目录是否已经拉过子项（有 children 数组即视为已加载，含空目录）。 */
export function findLoadedDirectory(
	nodes: FileTreeNode[],
	directoryPath: string,
): FileTreeNode | undefined {
	for (const node of nodes) {
		if (node.type === "directory" && node.path === directoryPath) {
			return Array.isArray(node.children) ? node : undefined;
		}
		if (node.children?.length) {
			const nested = findLoadedDirectory(node.children, directoryPath);
			if (nested) return nested;
		}
	}
	return undefined;
}

export function mergeFileTreeChildren(
	nodes: FileTreeNode[],
	directoryPath: string,
	children: FileTreeNode[],
): FileTreeNode[] {
	return nodes.map((node) => {
		if (node.type === "directory" && node.path === directoryPath) {
			return {
				...node,
				children,
				hasChildren: children.length > 0,
			};
		}
		if (node.children && node.children.length > 0) {
			return {
				...node,
				children: mergeFileTreeChildren(node.children, directoryPath, children),
			};
		}
		return node;
	});
}

/**
 * 按路径从短到长补齐已展开目录，保证父目录先于子目录写入。
 * 单个目录失败（已删/无权限）跳过，不阻断整棵树。
 */
export async function hydrateExpandedFileTree(
	listDirectory: (directory: string) => Promise<FileTreeNode[]>,
	tree: FileTreeNode[],
	expandedDirs: Iterable<string>,
): Promise<FileTreeNode[]> {
	const dirs = [...expandedDirs].sort((left, right) => left.length - right.length);
	let next = tree;
	for (const directory of dirs) {
		try {
			const children = await listDirectory(directory);
			next = mergeFileTreeChildren(next, directory, children);
		} catch {
			// 持久化里的展开路径可能已不存在；忽略后展开态仍保留，下次刷新自然消失。
		}
	}
	return next;
}

/** 切项目或新请求发出后，旧 files:list 不得再写入当前抽屉（#159）。 */
export function shouldApplyFileTreeResult(
	requestedProjectId: string,
	currentProjectId: string | undefined,
	requestGeneration: number,
	currentGeneration: number,
): boolean {
	return requestedProjectId === currentProjectId && requestGeneration === currentGeneration;
}

/**
 * 拉浅层根再补齐已展开目录；中途项目切走或请求被取代时返回 null，
 * 避免慢扫描结果盖住当前项目的文件树。
 */
export async function loadProjectFileTree(
	listRoot: () => Promise<FileTreeNode[]>,
	expandedDirs: Iterable<string>,
	isCurrent: () => boolean,
	listDirectory: (directory: string) => Promise<FileTreeNode[]> = listRoot,
): Promise<FileTreeNode[] | null> {
	const tree = await listRoot();
	if (!isCurrent()) return null;
	const next = await hydrateExpandedFileTree(listDirectory, tree, expandedDirs);
	if (!isCurrent()) return null;
	return next;
}
