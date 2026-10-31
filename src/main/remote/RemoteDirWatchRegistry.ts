/**
 * 目录订阅登记表（helper 1.24.0 的 `fs.watch` → 事实失效）。
 *
 * 事件帧只带 `watchId`，不带项目：所以「哪个项目的哪些目录」必须由发起订阅的一方登记下来。这里就是
 * 那份登记表，只做三件事：
 *
 * 1. **身份来自真实 helper 生命周期**：`sessionKey` 由主进程给出（`RemoteProjectSession.connectionId`
 *    = manager 实例 + 连接 generation）。同一次 helper 会话里，每次读都会新建一个 session 包装对象，
 *    但它们必须映射到同一个 key；重连/换根/换 manager 必须映射到不同的 key。**不能用包装对象本身**，
 *    否则同一会话的每次读都会再订一个 watcher，直到 helper 的 4 个 watcher 上限把后来的订阅全拒掉。
 * 2. **换会话 = 旧 watcher 全死**：登记表跟着换代，旧 `watchId` 立刻不再认；换代后迟到的订阅结果
 *    不得登记到新代，清理也不得跨代关闭新 watcher。
 * 3. **只算范围、不碰缓存**：它把 (host, watchId) 换回一组 `项目 + 目录` 范围，标脏由调用方完成，
 *    所以这个模块不依赖事实层，也不依赖 IPC。
 *
 * helper 的物理上限是 **4 个 watchId、每个最多 32 条路径**（不是 4 个目录）。超限时拒绝而不是排队：
 * 订阅是降级能力，读成功不因订阅失败而报错，但也不能假装已经订阅成功。
 */

import { parentDirOf } from "./RemoteWorkspaceView";

export type DirWatchScope = { projectId: string; paths: readonly string[] };

/** helper 契约里的真实上限；`remoteHelperEntry` 的方法测试与本表的策略都以它为准。 */
export const DIR_WATCH_LIMITS = { watchersPerHost: 4, pathsPerWatcher: 32 } as const;

export type DirWatchEnsureOptions = {
	/** 要监听的目录（项目根相对；根目录是空串）。省略时只监听根目录。 */
	paths?: readonly string[];
	/** 成对退订：登记表在项目关闭/连接释放时调用它（helper 已死时调用会失败，忽略即可）。 */
	unwatch?: (watchId: string) => Promise<unknown>;
};

/**
 * 一次 ensure 的结果：`rejected` 是因为 **4 watcher 上限**被拒的路径块数。
 *
 * 只有上限拒绝才计数：helper 不支持订阅（拿不到 watchId）不算「降级到上限」，调用方据此区分
 * 「订阅能力缺失」与「预算用满」——后者必须留下可断言的状态，不能假装覆盖。
 */
export type DirWatchEnsureResult = { rejected: number };

export type DirWatchRegistry = {
	/**
	 * 为 (连接, 项目) 建立订阅。`subscribe` 由调用方提供（它才知道怎么发请求），返回 `watchId`；
	 * 返回 undefined/空串表示 helper 不支持或不给 id（静默降级到只读刷新）。
	 */
	ensure(hostId: string, sessionKey: unknown, projectId: string, subscribe: (paths: readonly string[]) => Promise<string | undefined>, options?: DirWatchEnsureOptions): Promise<DirWatchEnsureResult>;
	/** 事件 → 应标脏的范围；未登记返回 undefined。 */
	scopesForEvent(hostId: string, watchId: string): DirWatchScope[] | undefined;
	/** 某个项目在当前代已被 watcher 覆盖的路径（去重）。深层订阅据此判断「还要不要 rewatch」。 */
	pathsOf(hostId: string, projectId: string): string[];
	/** 诊断/测试：某个 host 当前登记了几条订阅。 */
	sizeOf(hostId: string): number;
	/** 诊断/测试：某个 host 当前登记的全部 watchId。 */
	watchIdsOf(hostId: string): string[];
	/** 连接释放（断连前/显式断开）：只释放这一代，先成对退订再清登记。 */
	releaseHost(hostId: string, sessionKey: unknown): Promise<void>;
	/** 项目关闭：退订一个项目在该 host 上的全部订阅，不影响别的项目。 */
	releaseProject(hostId: string, projectId: string): Promise<void>;
	/** 项目关闭（不知道 host 时）：扫全部 host，退订这个项目的订阅。 */
	closeProject(projectId: string): Promise<void>;
	/** helper 已死（断连/宿主销毁）：登记直接丢弃，不再发退订。 */
	clearHost(hostId: string): void;
	/** 全部成对退订后丢弃（进程退出）。 */
	releaseAll(): Promise<void>;
	/** 全部丢弃（不回退订）。 */
	clearAll(): void;
};

/**
 * 一次写要让哪些目录事实失效：写到的路径所在目录 + 它的父目录（目录自身的 mtime/子项数也变了）。
 * 返回去重后的**项目相对目录路径**（根层是空串）。
 */
export function dirPathsAfterWrite(paths: readonly string[]): string[] {
	const touched = new Set<string>();
	for (const path of paths) {
		const parent = parentDirOf(path);
		touched.add(parent);
		if (parent !== "") touched.add(parentDirOf(parent));
	}
	return [...touched];
}

/**
 * 同上，直接返回事实缓存的 `项目 + 目录` 键（调用方不用自己拼分隔符）。
 */
export function dirKeysAfterWrite(projectId: string, paths: readonly string[]): string[] {
	return dirPathsAfterWrite(paths).map((path) => projectId + "\u0000" + path);
}

/** 登记表里的一代 helper 会话。 */
type HostRecord = {
	sessionKey: unknown;
	unwatch?: (watchId: string) => Promise<unknown>;
	/** watchId → 它监听的范围。 */
	watches: Map<string, DirWatchScope>;
	/** 「项目 + 路径组」签名 → 在途订阅（同 key 并发 ensure 只发一次请求）。 */
	pending: Map<string, Promise<void>>;
};

export function createDirWatchRegistry(): DirWatchRegistry {
	/** hostId → 当前这一代会话的登记。 */
	const byHost = new Map<string, HostRecord>();

	const watchedPathsOf = (record: HostRecord, projectId: string): Set<string> => {
		const watched = new Set<string>();
		for (const scope of record.watches.values()) if (scope.projectId === projectId) for (const path of scope.paths) watched.add(path);
		return watched;
	};

	const unwatchOne = async (record: HostRecord, watchId: string): Promise<void> => {
		const unwatch = record.unwatch;
		if (unwatch === undefined) return;
		try {
			await unwatch(watchId);
		} catch {
			// 退订是清理动作，不是读的前置条件：会话已死/已换代时失败即可，不向上抛。
		}
	};

	const dropWatches = async (record: HostRecord, matches: (scope: DirWatchScope) => boolean): Promise<void> => {
		const victims = [...record.watches].filter(([, scope]) => matches(scope)).map(([watchId]) => watchId);
		for (const watchId of victims) {
			record.watches.delete(watchId);
			await unwatchOne(record, watchId);
		}
	};

	return {
		async ensure(hostId, sessionKey, projectId, subscribe, options = {}) {
			// 身份换代：旧 helper 的 watcher 已经随会话一起死了，登记表留着只会把陈旧 id 当有效。
			// 换代表明上一代的会话已经不可用，所以这里不发退订（请求只会失败）。
			let record = byHost.get(hostId);
			if (record === undefined || !Object.is(record.sessionKey, sessionKey)) {
				record = { sessionKey, watches: new Map(), pending: new Map(), ...(options.unwatch === undefined ? {} : { unwatch: options.unwatch }) };
				byHost.set(hostId, record);
			} else if (record.unwatch === undefined && options.unwatch !== undefined) {
				record.unwatch = options.unwatch;
			}

			const requested = [...new Set(options.paths ?? [""])];
			const watched = watchedPathsOf(record, projectId);
			const missing = requested.filter((path) => !watched.has(path));
			if (missing.length === 0) return { rejected: 0 };
			let rejected = 0;
			// helper 每个 watcher 最多 32 条路径；多出来的路径只能靠下一个 watcher，绝不一次性发超限请求。
			for (let offset = 0; offset < missing.length; offset += DIR_WATCH_LIMITS.pathsPerWatcher) {
				const chunk = missing.slice(offset, offset + DIR_WATCH_LIMITS.pathsPerWatcher);
				const signature = projectId + "\u0000" + chunk.join("\u0000");
				const running = record.pending.get(signature);
				if (running !== undefined) {
					await running;
					continue;
				}
				const task = (async () => {
					// 上限在发请求前就要判：第 5 个 watcher 一定是拒绝，不是排队。
					if (record.watches.size >= DIR_WATCH_LIMITS.watchersPerHost) {
						rejected += 1;
						return;
					}
					const watchId = await subscribe([...chunk]);
					if (watchId === undefined || watchId === "") return;
					// 订阅在途时换了代：这个 id 属于旧 helper，不能登记到新代。
					if (byHost.get(hostId) !== record) return;
					// 等待期间配额被别的项目用完：退掉这个刚建好的，别偷偷超限。
					if (record.watches.size >= DIR_WATCH_LIMITS.watchersPerHost) {
						await unwatchOne(record, watchId);
						rejected += 1;
						return;
					}
					record.watches.set(watchId, { projectId, paths: [...chunk] });
				})();
				record.pending.set(signature, task);
				try {
					await task;
				} finally {
					if (record.pending.get(signature) === task) record.pending.delete(signature);
				}
			}
			return { rejected };
		},
		scopesForEvent(hostId, watchId) {
			const scope = byHost.get(hostId)?.watches.get(watchId);
			// 未登记 = 不是我们发起的（旧会话、别的项目、已撤销）：忽略比猜更安全。
			return scope === undefined ? undefined : [scope];
		},
		pathsOf(hostId, projectId) {
			const record = byHost.get(hostId);
			return record === undefined ? [] : [...watchedPathsOf(record, projectId)];
		},
		sizeOf: (hostId) => byHost.get(hostId)?.watches.size ?? 0,
		watchIdsOf: (hostId) => [...(byHost.get(hostId)?.watches.keys() ?? [])],
		async releaseHost(hostId, sessionKey) {
			const record = byHost.get(hostId);
			// 只释放自己这一代：迟到的清理不能把新会话的 watcher 关掉。
			if (record === undefined || !Object.is(record.sessionKey, sessionKey)) return;
			byHost.delete(hostId);
			await dropWatches(record, () => true);
		},
		async releaseProject(hostId, projectId) {
			const record = byHost.get(hostId);
			if (record === undefined) return;
			await dropWatches(record, (scope) => scope.projectId === projectId);
		},
		async closeProject(projectId) {
			for (const record of [...byHost.values()]) await dropWatches(record, (scope) => scope.projectId === projectId);
		},
		clearHost(hostId) {
			byHost.delete(hostId);
		},
		async releaseAll() {
			const records = [...byHost.values()];
			byHost.clear();
			for (const record of records) await dropWatches(record, () => true);
		},
		clearAll() {
			byHost.clear();
		},
	};
}
