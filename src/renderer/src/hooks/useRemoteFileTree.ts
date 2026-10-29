import { useCallback, useEffect, useRef, useState } from "react";
import type { FileTreeNode } from "../../../shared/types";
import type { ProjectDirectoryEntry } from "../../../shared/types/projectFiles";
import { desktopApi } from "../desktopApi";
import { createLazyDirTreeController, lazyDirTreeInitialState, type LazyDirTreeController, type LazyDirTreeState } from "../utils/lazyDirTree";

/**
 * 远端项目的文件树：与本机文件抽屉共用 `lazyDirTree` 内核，只是每一层按需走公共目录页。
 *
 * 为什么不在渲染层一次拉全树：远端每次列目录都是一次 SSH 往返，真实项目会变成几十次。
 * 公共目录页自己带 revision/generation 与显式截断，这里只负责把条目映射成 `FileTreeNode`。
 *
 * 忽略规则与本机文件抽屉对齐（`FileSystemService` 的 ALWAYS_IGNORED_NAMES）：`.git` 与
 * `node_modules` 体量巨大且没有浏览价值，远端面板以前把它们当普通目录展示，`.git/objects`
 * 会直接铺满一屏。`ignored` 只是 Git 修饰，不在这里当过滤条件。
 */
const IGNORED_NAMES = new Set([".git", "node_modules"]);

export type RemoteFileTree = LazyDirTreeState & {
	/** 按目录键（= 相对项目根的路径）展开/收起。 */
	toggle: (key: string) => void;
	collapseAll: () => void;
	/** 重新读取根层与所有已加载目录；显式刷新会越过暖事实。 */
	refresh: () => Promise<void>;
	/** 按需读取某一层（搜索结果展开祖先目录时用）。 */
	loadDir: (dir: string) => Promise<boolean>;
	/** 展开到指定目录（含全部祖先），并把当前目录切过去。 */
	reveal: (dir: string) => Promise<void>;
	setCurrentDir: (dir: string) => void;
};

function entryToNode(entry: ProjectDirectoryEntry): FileTreeNode {
	const relativePath = entry.relativePath;
	const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
	const isDirectory = entry.type === "directory";
	return {
		name,
		// 远端节点没有本机路径；这里放相对路径，让 fileTreeNodeKey 得到稳定的目录键。
		path: relativePath,
		relativePath,
		target: entry.target,
		type: entry.type,
		// 远端 `hasChildren` 只能是 "unknown"：不能把“没查过”伪装成“没有子项”。
		...(isDirectory ? { hasChildren: entry.hasChildren !== false } : {}),
	};
}

function remotePageNodes(projectId: string, entries: readonly ProjectDirectoryEntry[]): FileTreeNode[] {
	return entries
		.filter((entry) => !IGNORED_NAMES.has(entry.relativePath.slice(entry.relativePath.lastIndexOf("/") + 1)))
		.map((entry) => entryToNode(entry))
		.sort((left, right) => {
			// 与本机文件树同样的顺序：目录在前、同类按名字；远端返回顺序不作为展示契约。
			const byKind = Number(right.type === "directory") - Number(left.type === "directory");
			return byKind !== 0 ? byKind : left.name.localeCompare(right.name);
		});
}

export function useRemoteFileTree(projectId: string): RemoteFileTree {
	const [state, setState] = useState<LazyDirTreeState>(() => lazyDirTreeInitialState());
	const controller = useRef<LazyDirTreeController | null>(null);

	useEffect(() => {
		const reads = createLazyDirTreeController(async (dir, force) => {
			const result = await desktopApi.files.directoryPage({ projectId, relativePath: dir }, { force });
			if (!result.ok) return { ok: false, code: result.code };
			return {
				ok: true,
				page: {
					nodes: remotePageNodes(projectId, result.value.entries),
					revision: result.value.revision,
					generation: result.value.generation,
					truncated: result.value.truncated,
				},
			};
		});
		controller.current = reads;
		setState(reads.getState());
		const unsubscribe = reads.subscribe(() => setState(reads.getState()));
		void reads.load("");
		// 远端事实通知：只重读已加载的目录；退订随组件卸载/切项目发生。
		const offFacts = desktopApi.remoteHosts.onProjectFactsChanged(projectId, (change) => reads.applyFactsChange(change));
		return () => {
			offFacts();
			unsubscribe();
			reads.dispose();
			if (controller.current === reads) controller.current = null;
		};
	}, [projectId]);

	const toggle = useCallback((key: string) => {
		controller.current?.toggle(key);
	}, []);
	const collapseAll = useCallback(() => {
		controller.current?.collapseAll();
	}, []);
	const refresh = useCallback((): Promise<void> => controller.current?.refresh() ?? Promise.resolve(), []);
	const loadDir = useCallback((dir: string): Promise<boolean> => controller.current?.load(dir) ?? Promise.resolve(false), []);
	const reveal = useCallback((dir: string): Promise<void> => controller.current?.reveal(dir) ?? Promise.resolve(), []);
	const setCurrentDir = useCallback((dir: string) => {
		controller.current?.setCurrentDir(dir);
	}, []);

	return { ...state, toggle, collapseAll, refresh, loadDir, reveal, setCurrentDir };
}
