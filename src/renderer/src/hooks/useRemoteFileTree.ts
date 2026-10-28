import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileTreeNode } from "../../../shared/types";
import { desktopApi } from "../desktopApi";

/**
 * 远端项目的文件树：与本机文件抽屉同一套 `FileTreeNode`，只是每一层按需从远端列目录。
 *
 * 为什么在渲染层组树而不是让主进程一次返回整棵树：远端每次列目录都是一次 SSH 往返，
 * 一次拉全树在真实项目上会变成几十次往返。这里只在目录第一次展开时读那一层，与本机
 * 文件树的懒加载语义一致（`hasChildren` + 展开时加载）。
 *
 * 忽略规则与本机文件抽屉对齐（`FileSystemService` 的 ALWAYS_IGNORED_NAMES）：`.git` 与
 * `node_modules` 体量巨大且没有浏览价值，远端面板以前把它们当普通目录展示，`.git/objects`
 * 会直接铺满一屏。
 */
const IGNORED_NAMES = new Set([".git", "node_modules"]);

export type RemoteFileTree = {
	/** 根层节点（已展开的目录带 children）。 */
	nodes: FileTreeNode[];
	expanded: Set<string>;
	/** 正在读取的目录（相对项目根的路径，根为 ""）。 */
	loadingDirs: Set<string>;
	/** 根层是否已经成功列过一次。 */
	listed: boolean;
	error: string | null;
	/** 按目录键（= 相对项目根的路径）展开/收起。 */
	toggle: (key: string) => void;
	collapseAll: () => void;
	/** 重新读取根层与所有已加载目录；用于刷新按钮与写操作之后。 */
	refresh: () => Promise<void>;
	/** 按需读取某一层（搜索结果展开祖先目录时用）。 */
	loadDir: (dir: string) => Promise<boolean>;
	/** 展开到指定目录（含全部祖先），并把当前目录切过去。 */
	reveal: (dir: string) => Promise<void>;
	/** 当前用于新建/上传的目标目录（最后展开的那个目录，默认根）。 */
	currentDir: string;
	setCurrentDir: (dir: string) => void;
};

function entryToNode(projectId: string, parent: string, entry: { name: string; kind: string }): FileTreeNode {
	const relativePath = parent.length === 0 ? entry.name : `${parent}/${entry.name}`;
	const isDirectory = entry.kind === "directory";
	return {
		name: entry.name,
		// 远端节点没有本机路径；这里放相对路径，让 fileTreeNodeKey 得到稳定的目录键。
		path: relativePath,
		relativePath,
		target: { projectId, relativePath },
		type: isDirectory ? "directory" : "file",
		...(isDirectory ? { hasChildren: true } : {}),
	};
}

export function useRemoteFileTree(projectId: string): RemoteFileTree {
	const [childrenByDir, setChildrenByDir] = useState<Record<string, FileTreeNode[]>>({});
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set());
	const [listed, setListed] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [currentDir, setCurrentDir] = useState("");
	// 每个目录各自的代次：同时展开两个目录时，晚到的旧结果不能盖掉新结果。
	const generations = useRef(new Map<string, number>());

	const load = useCallback(
		async (dir: string): Promise<boolean> => {
			const generation = (generations.current.get(dir) ?? 0) + 1;
			generations.current.set(dir, generation);
			setLoadingDirs((previous) => new Set(previous).add(dir));
			try {
				const result = await desktopApi.remoteHosts.listProject(projectId, dir);
				if (generations.current.get(dir) !== generation) return false;
				if (!result.ok) {
					setError(result.code);
					// 读失败不能继续展示上一次的条目：那会让用户以为目录内容仍是当前事实。
					setChildrenByDir((previous) => ({ ...previous, [dir]: [] }));
					if (dir === "") setListed(false);
					return false;
				}
				// 与本机文件树同样的顺序：目录在前、同类按名字；远端返回顺序不作为展示契约。
				const ordered = result.value.entries
					.filter((entry) => !IGNORED_NAMES.has(entry.name))
					.slice()
					.sort((left, right) => {
						const byKind = Number(right.kind === "directory") - Number(left.kind === "directory");
						return byKind !== 0 ? byKind : left.name.localeCompare(right.name);
					});
				const nodes = ordered.map((entry) => entryToNode(projectId, dir, entry));
				setChildrenByDir((previous) => ({ ...previous, [dir]: nodes }));
				setError(null);
				if (dir === "") setListed(true);
				return true;
			} catch {
				if (generations.current.get(dir) !== generation) return false;
				setError("REMOTE_FILE_REQUEST_FAILED");
				if (dir === "") setListed(false);
				return false;
			} finally {
				if (generations.current.get(dir) === generation) {
					setLoadingDirs((previous) => {
						const next = new Set(previous);
						next.delete(dir);
						return next;
					});
				}
			}
		},
		[projectId],
	);

	// 切换项目：整棵树重置，避免沿用上一个项目的目录内容。
	useEffect(() => {
		generations.current.clear();
		setChildrenByDir({});
		setExpanded(new Set());
		setLoadingDirs(new Set());
		setListed(false);
		setError(null);
		setCurrentDir("");
		void load("");
	}, [load]);

	const toggle = useCallback(
		(key: string) => {
			const opening = !expanded.has(key);
			setExpanded((previous) => {
				const next = new Set(previous);
				if (next.has(key)) next.delete(key);
				else next.add(key);
				return next;
			});
			if (!opening) return;
			setCurrentDir(key);
			// 展开才读这一层：未展开的目录不产生任何 SSH 往返。
			if (childrenByDir[key] === undefined && !loadingDirs.has(key)) void load(key);
		},
		[childrenByDir, expanded, loadingDirs, load],
	);

	const reveal = useCallback(
		async (dir: string) => {
			const segments = dir.split("/").filter(Boolean);
			let current = "";
			const keys: string[] = [];
			for (const segment of segments) {
				current = current.length === 0 ? segment : `${current}/${segment}`;
				keys.push(current);
				await load(current);
			}
			setExpanded((previous) => {
				const next = new Set(previous);
				for (const key of keys) next.add(key);
				return next;
			});
			setCurrentDir(dir);
		},
		[load],
	);

	const collapseAll = useCallback(() => {
		setExpanded(new Set());
		setCurrentDir("");
	}, []);

	const refresh = useCallback(async () => {
		const dirs = ["", ...Object.keys(childrenByDir)];
		await Promise.all([...new Set(dirs)].map((dir) => load(dir)));
	}, [childrenByDir, load]);

	const nodes = useMemo(() => {
		const build = (dir: string): FileTreeNode[] =>
			(childrenByDir[dir] ?? []).map((node) => {
				if (node.type !== "directory") return node;
				const key = node.path ?? node.relativePath;
				// 未展开的目录不带 children（行组件据此显示折叠箭头并跳过渲染）；
				// 已展开但还没读回来时同样不带，由行组件显示懒加载占位。
				return expanded.has(key) && childrenByDir[key] !== undefined ? { ...node, children: build(key) } : { ...node, children: undefined };
			});
		return build("");
	}, [childrenByDir, expanded]);

	return { nodes, expanded, loadingDirs, listed, error, toggle, collapseAll, refresh, loadDir: load, reveal, currentDir, setCurrentDir };
}
