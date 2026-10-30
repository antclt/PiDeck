import type { FileTreeNode } from "../../../shared/types";
import type { RemoteProjectFactsChange } from "../../../shared/types/remoteHost";

/**
 * 懒加载目录树的共用内核（v5 T8）。本机文件抽屉与远端项目面板都只有「一层一次读」的需求，
 * 差别只在 loader；展开集、按目录代次、失败清空、迟到结果丢弃、刷新范围这些规则必须只有一份。
 *
 * 这里刻意不依赖 React：代次/互斥/迟到读可以用 Node 测试直接钉死，hook 只做订阅与装配。
 * 目录键是**项目相对路径**（根为 ""）；节点身份用 `relativePath`，不把本机绝对路径带进远端。
 */

export type LazyDirPage = {
	nodes: FileTreeNode[];
	/** 该层被 backend 截断（远端 2000 项上限）；UI 必须显式提示，不能静默少显示。 */
	truncated?: boolean;
	/** 同一 generation 内的事实版本；只用于诊断，不参与排序。 */
	revision?: number;
	/** 连接代；跨代的事实不得混用。 */
	generation?: string;
};

export type LazyDirLoadResult = { ok: true; page: LazyDirPage } | { ok: false; code: string };
export type LazyDirLoader = (dir: string, force: boolean) => Promise<LazyDirLoadResult>;

export type LazyDirTreeState = {
	nodes: FileTreeNode[];
	expanded: ReadonlySet<string>;
	loadingDirs: ReadonlySet<string>;
	truncatedDirs: ReadonlySet<string>;
	listed: boolean;
	error: string | null;
	currentDir: string;
};

export type LazyDirTreeController = {
	getState(): LazyDirTreeState;
	subscribe(listener: () => void): () => void;
	/** 读取一层；同一目录的新请求作废旧请求，旧结果不会落地。 */
	load(dir: string, force?: boolean): Promise<boolean>;
	toggle(dir: string): void;
	collapseAll(): void;
	/** 重新读取根层与全部已加载目录（显式刷新按 force 越过暖事实）。 */
	refresh(): Promise<void>;
	/** 展开到指定目录（含祖先），并把当前目录切过去。 */
	reveal(dir: string): Promise<void>;
	/** 恢复持久化展开集：根层之后按深度逐层读取并展开（失败也保留展开意图）。 */
	hydrate(dirs: readonly string[], includeRoot?: boolean): Promise<void>;
	/** 只补读尚未加载的目录；返回是否发起过读取。 */
	loadMissing(dirs: readonly string[]): Promise<boolean>;
	/** 目录是否已经有一份已落地的子项（含空目录）。 */
	hasLoaded(dir: string): boolean;
	/** 沿单子目录链下钻：每层用 descend 决定下一层，返回路径串的相对目录名。 */
	drill(start: string, descend: (children: readonly FileTreeNode[]) => string | null, maxDepth?: number): Promise<void>;
	setCurrentDir(dir: string): void;
	/** 远端事实通知：已加载目录按 scope 强制重读；连接代变化时丢弃整棵树再读根层。 */
	applyFactsChange(change: RemoteProjectFactsChange): void;
	invalidateAll(): void;
	dispose(): void;
};

export function lazyDirTreeInitialState(): LazyDirTreeState {
	return { nodes: [], expanded: new Set(), loadingDirs: new Set(), truncatedDirs: new Set(), listed: false, error: null, currentDir: "" };
}

function buildNodes(children: ReadonlyMap<string, readonly FileTreeNode[]>, expanded: ReadonlySet<string>, failed: ReadonlySet<string>, dir: string): FileTreeNode[] {
	return (children.get(dir) ?? []).map((node) => {
		if (node.type !== "directory") return node;
		const key = node.relativePath;
		if (failed.has(key)) return { ...node, children: undefined, hasChildren: false };
		return expanded.has(key) && children.has(key) ? { ...node, children: buildNodes(children, expanded, failed, key) } : { ...node, children: undefined };
	});
}

export function createLazyDirTreeController(loader: LazyDirLoader): LazyDirTreeController {
	const children = new Map<string, FileTreeNode[]>();
	const expanded = new Set<string>();
	const loading = new Set<string>();
	const truncatedDirs = new Set<string>();
	/** 读失败且尚未重新成功的目录：节点 hasChildren=false（去掉永久占位），但保留展开意图供重试。 */
	const failed = new Set<string>();
	/** 每个目录各自的代次：同时展开两个目录时，晚到的旧结果不能盖掉新结果。 */
	const generations = new Map<string, number>();
	const revisions = new Map<string, number>();
	const listeners = new Set<() => void>();
	let generation = "";
	/** 整树作废的代次：连接换代/手动 invalidate 后，此前所有在途结果都算迟到。 */
	let epoch = 0;
	let listed = false;
	let error: string | null = null;
	let currentDir = "";
	let disposed = false;
	let snapshot: LazyDirTreeState = lazyDirTreeInitialState();
	/** 只有子项/展开集变化才重建 nodes；加载态/错误的 publish 必须复用同一数组，避免内容代次空转。 */
	let nodesDirty = false;
	let lastNodes: FileTreeNode[] = snapshot.nodes;

	const rebuild = (): void => {
		if (nodesDirty) {
			lastNodes = buildNodes(children, expanded, failed, "");
			nodesDirty = false;
		}
		snapshot = {
			nodes: lastNodes,
			expanded: new Set(expanded),
			loadingDirs: new Set(loading),
			truncatedDirs: new Set(truncatedDirs),
			listed,
			error,
			currentDir,
		};
		for (const listener of listeners) listener();
	};

	return {
		getState: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async load(dir, force = false) {
			if (disposed) return false;
			const ticket = epoch;
			const request = (generations.get(dir) ?? 0) + 1;
			generations.set(dir, request);
			loading.add(dir);
			rebuild();
			try {
				const result = await loader(dir, force);
				if (disposed || ticket !== epoch || generations.get(dir) !== request) return false;
				if (!result.ok) {
					// 读失败不能继续展示上一次的条目：那会让用户以为目录内容仍是当前事实。
					children.delete(dir);
					failed.add(dir);
					truncatedDirs.delete(dir);
					nodesDirty = true;
					error = result.code;
					if (dir === "") listed = false;
					rebuild();
					return false;
				}
				children.set(dir, result.page.nodes);
				failed.delete(dir);
				nodesDirty = true;
				if (result.page.truncated === true) truncatedDirs.add(dir);
				else truncatedDirs.delete(dir);
				if (result.page.revision !== undefined) revisions.set(dir, result.page.revision);
				if (result.page.generation !== undefined && result.page.generation.length > 0) generation = result.page.generation;
				error = null;
				if (dir === "") listed = true;
				rebuild();
				return true;
			} catch {
				if (disposed || ticket !== epoch || generations.get(dir) !== request) return false;
				children.delete(dir);
				failed.add(dir);
				truncatedDirs.delete(dir);
				nodesDirty = true;
				error = "REMOTE_FILE_REQUEST_FAILED";
				if (dir === "") listed = false;
				rebuild();
				return false;
			} finally {
				if (!disposed && ticket === epoch && generations.get(dir) === request) {
					loading.delete(dir);
					rebuild();
				}
			}
		},
		toggle(dir) {
			if (disposed) return;
			const opening = !expanded.has(dir);
			// 展开一个尚未加载的目录不改变 nodes（children 仍未定义）；只有已加载目录的
			// 展开/收起才需要重建，避免一次展开就推进内容代次、白跑一轮 Git 着色。
			const changesNodes = children.has(dir);
			if (opening) {
				expanded.add(dir);
				currentDir = dir;
			} else {
				expanded.delete(dir);
			}
			nodesDirty = nodesDirty || changesNodes;
			rebuild();
			if (opening && !children.has(dir) && !loading.has(dir)) void this.load(dir);
		},
		collapseAll() {
			if (disposed) return;
			const changesNodes = [...expanded].some((dir) => children.has(dir));
			expanded.clear();
			currentDir = "";
			nodesDirty = nodesDirty || changesNodes;
			rebuild();
		},
		async refresh() {
			// 已在途的目录不重复发起：抽屉打开时的静默刷新常与首屏加载重叠，重发会让树在
			// 用户展开/滚动时整块替换（滚动位置和 sticky 几何都会跳）。
			const dirs = [...new Set(["", ...children.keys()])].filter((dir) => !loading.has(dir));
			await Promise.all(dirs.map((dir) => this.load(dir, true)));
		},
		async reveal(dir) {
			if (disposed) return;
			const segments = dir.split("/").filter(Boolean);
			let current = "";
			for (const segment of segments) {
				current = current.length === 0 ? segment : `${current}/${segment}`;
				await this.load(current);
			}
			// 祖先必须全部展开，否则 reveal 后目标目录仍不可见。
			expanded.clear();
			current = "";
			for (const segment of segments) {
				current = current.length === 0 ? segment : `${current}/${segment}`;
				expanded.add(current);
			}
			currentDir = dir;
			nodesDirty = true;
			rebuild();
		},
		async hydrate(dirs, includeRoot = true) {
			if (disposed) return;
			if (includeRoot) await this.load("");
			if (disposed) return;
			const ordered = [...new Set(dirs)].filter((dir) => dir.length > 0).sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
			for (const dir of ordered) {
				if (disposed) return;
				// 失败也保留展开意图：与持久化里的旧键一致，交给下一次显式刷新/自愈重试。
				await this.load(dir);
				expanded.add(dir);
				nodesDirty = true;
				rebuild();
			}
		},
		async loadMissing(dirs) {
			if (disposed) return false;
			let attempted = false;
			for (const dir of new Set(dirs)) {
				if (disposed) return attempted;
				if (children.has(dir) && !failed.has(dir)) continue;
				attempted = true;
				await this.load(dir);
			}
			return attempted;
		},
		hasLoaded: (dir) => children.has(dir),
		async drill(start, descend, maxDepth = 32) {
			if (disposed) return;
			let current = start;
			const chain = new Set<string>([start]);
			for (let depth = 0; depth < Math.max(1, maxDepth); depth += 1) {
				if (disposed) return;
				const loaded = await this.load(current);
				expanded.add(current);
				nodesDirty = true;
				rebuild();
				if (!loaded) break;
				const entries = children.get(current) ?? [];
				const next = descend(entries);
				if (next === null || next === current || !entries.some((node) => node.type === "directory" && node.relativePath === next)) break;
				current = next;
				chain.add(current);
			}
			currentDir = current;
			rebuild();
			void chain;
		},
		setCurrentDir(dir) {
			if (disposed) return;
			currentDir = dir;
			rebuild();
		},
		applyFactsChange(change) {
			if (disposed) return;
			// 换代：旧树来自另一条连接，继续显示就是混用两代事实。保留展开意图，内容重读。
			if (change.generation.length > 0 && generation.length > 0 && change.generation !== generation) {
				const keep = [...children.keys()];
				epoch += 1;
				children.clear();
				failed.clear();
				revisions.clear();
				loading.clear();
				truncatedDirs.clear();
				nodesDirty = true;
				listed = false;
				error = null;
				generation = change.generation;
				rebuild();
				void Promise.all([...new Set(["", ...keep])].map((dir) => this.load(dir, true)));
				return;
			}
			// 整树失效（Git 写成功）：子树条目可能整块变化，重读根与全部已加载目录。这不是「根目录事件」——
			// 根事件只重读根层（下面的 dir 分支），所以不能把 tree 降级成 {kind:"dir", path:""}。
			// 展开集与 currentDir 保留：一次写不该把用户展开的树收回去；旧内容也不清空（重读落地才替换）。
			if (change.scopes.some((scope) => scope.kind === "tree")) {
				void this.refresh();
				return;
			}
			const dirs = new Set<string>();
			for (const scope of change.scopes) {
				if (scope.kind !== "dir") continue;
				if (scope.path === "" || children.has(scope.path)) dirs.add(scope.path);
			}
			for (const dir of dirs) void this.load(dir, true);
		},
		invalidateAll() {
			if (disposed) return;
			epoch += 1;
			children.clear();
			failed.clear();
			revisions.clear();
			loading.clear();
			truncatedDirs.clear();
			nodesDirty = true;
			listed = false;
			error = null;
			rebuild();
		},
		dispose() {
			disposed = true;
			epoch += 1;
			listeners.clear();
		},
	};
}
