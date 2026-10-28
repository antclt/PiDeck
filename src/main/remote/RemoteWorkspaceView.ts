/**
 * 远端工作区事实层（v5 §3）：树、Git 面板、侧栏圆点在同一个项目上读的是**同一份事实**。
 *
 * 三个事实族放在一处：
 * - `dir(path)`：一个目录的直接子项（懒加载单位）；
 * - `repos()`：项目里有哪些仓库（远端一次发现的结果）；
 * - `status(repoPath)`：一个仓库的工作区状态。
 *
 * 这一层只做三件事——**合并、发号（revision）、按矩阵失效**；它不知道 SSH、不知道 Git 命令怎么写，
 * 三个装载端口由调用方注入。于是「一次内容变化打几次往返」变成可断言的数字，而不是靠人肉统计。
 *
 * 权威边界（写下来以免被后来的便利逻辑带歪）：
 * 1. `invalidate` 只标脏，**不触发装载**——刷新成本由读的人（界面）决定，一次写不会造成广播风暴。
 * 2. 失败就是失败：装载失败返回稳定码 + `outcome`，旧值保留并标脏；绝不把「没拿到」说成「没有」。
 * 3. 项目级隔离：所有 key 以 projectId 前缀，`clearProject` 只清自己那份（host 断开时清全部）。
 */
import type { Op } from "../../shared/op";
import { createFactCache, type FactCache, type FactCacheStats, type FactSnapshot } from "./RemoteFactCache";

/** 一个可失效的范围（写面用它声明「我改了哪些事实」）。 */
export type WorkspaceScope = { kind: "dir"; path: string } | { kind: "repos" } | { kind: "status"; repoPath: string };

/** 一次写操作对事实的影响。路径是**项目根相对**路径（与文件面契约一致）。 */
export type WorkspaceWriteEffect = {
	/** 被写到的路径（新增/改名/删除/保存）；它们的**所在目录**会被标脏。 */
	paths?: readonly string[];
	/** 写发生在哪个仓库：`status(repoPath)` 与 `repos()` 一起标脏（可能新建了 `.git`）。 */
	repoPath?: string;
};

/** 事实变化的通知：一次失效一个事件，带上被标脏的全部范围（同一次写只发一次）。 */
export type WorkspaceChange = { projectId: string; scopes: WorkspaceScope[] };

export type RemoteWorkspacePorts<Dir, Repos, Status> = {
	listDir(projectId: string, path: string): Promise<Op<Dir>>;
	listRepos(projectId: string): Promise<Op<Repos>>;
	status(projectId: string, repoPath: string): Promise<Op<Status>>;
};

export type RemoteWorkspaceView<Dir, Repos, Status> = {
	dir(projectId: string, path: string): Promise<FactSnapshot<Dir>>;
	repos(projectId: string): Promise<FactSnapshot<Repos>>;
	status(projectId: string, repoPath: string): Promise<FactSnapshot<Status>>;
	refreshDir(projectId: string, path: string): Promise<FactSnapshot<Dir>>;
	refreshRepos(projectId: string): Promise<FactSnapshot<Repos>>;
	refreshStatus(projectId: string, repoPath: string): Promise<FactSnapshot<Status>>;
	invalidate(projectId: string, scope: WorkspaceScope): void;
	/** 写面之后的失效矩阵：一处写 => 所在目录 + 该仓库状态 + 仓库列表。 */
	afterWrite(projectId: string, effect: WorkspaceWriteEffect): void;
	/** 丢掉一个项目的全部事实（关闭项目/宿主重连）。 */
	clearProject(projectId: string): void;
	/** 丢掉全部（host 断开）。 */
	clearAll(): void;
	/** 三个缓存的计数合并（预算门禁直接读它）。 */
	stats(): FactCacheStats;
	/**
	 * 订阅事实变化（S8 推送的接口面）：今天由写面/失效同步触发，将来换成 helper `fs.watch` 事件时
	 * 上层代码不改。监听者抛错不影响写面（观察者不是事务的一部分）。
	 */
	onChanged(listener: (change: WorkspaceChange) => void): () => void;
};

const SEP = "\u0000";
const dirKey = (projectId: string, path: string) => `${projectId}${SEP}dir${SEP}${path}`;
const reposKey = (projectId: string) => `${projectId}${SEP}repos`;
const statusKey = (projectId: string, repoPath: string) => `${projectId}${SEP}status${SEP}${repoPath}`;
const projectPrefix = (projectId: string) => `${projectId}${SEP}`;

/** 路径的所在目录（`a/b/c.txt` → `a/b`，根层文件 → 空串）。不做规范化：契约里路径已是 POSIX 相对路径。 */
export function parentDirOf(path: string): string {
	const at = path.lastIndexOf("/");
	return at <= 0 ? "" : path.slice(0, at);
}

export function createRemoteWorkspaceView<Dir, Repos, Status>(ports: RemoteWorkspacePorts<Dir, Repos, Status>, options: { maxEntriesPerFamily?: number } = {}): RemoteWorkspaceView<Dir, Repos, Status> {
	const maxEntries = options.maxEntriesPerFamily;
	const dirs = createFactCache<Dir>((key) => {
		const parts = splitKey(key);
		return ports.listDir(parts[0], parts[2]);
	}, { ...(maxEntries === undefined ? {} : { maxEntries }) });
	const repos = createFactCache<Repos>((key) => ports.listRepos(splitKey(key)[0]), { maxEntries: 64 });
	const statuses = createFactCache<Status>((key) => {
		const parts = splitKey(key);
		return ports.status(parts[0], parts[2]);
	}, { maxEntries: 64 });

	const listeners = new Set<(change: WorkspaceChange) => void>();

	/** 把一组范围应用到缓存（不通知）。 */
	function applyScopes(projectId: string, scopes: readonly WorkspaceScope[]): void {
		for (const scope of scopes) {
			if (scope.kind === "dir") dirs.invalidate(dirKey(projectId, scope.path));
			else if (scope.kind === "repos") repos.invalidate(reposKey(projectId));
			else statuses.invalidate(statusKey(projectId, scope.repoPath));
		}
	}

	/** 一次失效一个事件：同一次写只发一次，监听者抛错不影响写面。 */
	function emit(projectId: string, scopes: readonly WorkspaceScope[]): void {
		if (scopes.length === 0) return;
		const change: WorkspaceChange = { projectId, scopes: [...scopes] };
		for (const listener of [...listeners]) {
			try {
				listener(change);
			} catch {
				// 观察者不是事务的一部分：界面渲染出错不能把已经生效的写报成失败。
			}
		}
	}

	return {
		dir: (projectId, path) => dirs.read(dirKey(projectId, path)),
		repos: (projectId) => repos.read(reposKey(projectId)),
		status: (projectId, repoPath) => statuses.read(statusKey(projectId, repoPath)),
		refreshDir: (projectId, path) => dirs.refresh(dirKey(projectId, path)),
		refreshRepos: (projectId) => repos.refresh(reposKey(projectId)),
		refreshStatus: (projectId, repoPath) => statuses.refresh(statusKey(projectId, repoPath)),
		invalidate(projectId: string, scope: WorkspaceScope): void {
			applyScopes(projectId, [scope]);
			emit(projectId, [scope]);
		},
		afterWrite(projectId: string, effect: WorkspaceWriteEffect): void {
			const touchedDirs = new Set<string>();
			for (const path of effect.paths ?? []) {
				const parent = parentDirOf(path);
				touchedDirs.add(parent);
				// 目录自身的元数据也变了（mtime/子项数），所以它的父目录同样要失效；
				// 根层（""）没有父目录，跳过即可。
				const grandparent = parentDirOf(parent);
				if (parent !== "") touchedDirs.add(grandparent);
			}
			// 写可能建出/删掉仓库（`.git`），所以仓库列表总是标脏；状态只在知道仓库时标脏。
			const scopes: WorkspaceScope[] = [
				...[...touchedDirs].map((path): WorkspaceScope => ({ kind: "dir", path })),
				{ kind: "repos" },
				...(effect.repoPath === undefined ? [] : [{ kind: "status", repoPath: effect.repoPath } as WorkspaceScope]),
			];
			applyScopes(projectId, scopes);
			emit(projectId, scopes);
		},
		onChanged(listener: (change: WorkspaceChange) => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		clearProject(projectId: string): void {
			const prefix = projectPrefix(projectId);
			const mine = (key: string) => key.startsWith(prefix);
			dirs.clearWhere(mine);
			repos.clearWhere(mine);
			statuses.clearWhere(mine);
		},
		clearAll(): void {
			dirs.clear();
			repos.clear();
			statuses.clear();
		},
		stats(): FactCacheStats {
			const a = dirs.stats();
			const b = repos.stats();
			const c = statuses.stats();
			return {
				loads: a.loads + b.loads + c.loads,
				merges: a.merges + b.merges + c.merges,
				hits: a.hits + b.hits + c.hits,
				failures: a.failures + b.failures + c.failures,
				inflight: a.inflight + b.inflight + c.inflight,
				entries: a.entries + b.entries + c.entries,
			};
		},
	};
}

/** key 由本模块唯一构造：`<projectId>\0<family>\0<...>`；解析回来时不做任何猜测。 */
function splitKey(key: string): string[] {
	return key.split(SEP);
}
