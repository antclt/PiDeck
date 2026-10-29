/**
 * Git 读事实的缓存（v5 W4 前置：**把「读事实」与「签授权」拆开**）。
 *
 * 为什么必须拆：`git:remote-snapshot` 一次调用里既读状态、又**签发写授权**（每个 scope 一个一次性令牌）。
 * 直接把快照缓存起来，等于把旧的一次性授权反复发出去——这与 `entry.stat` 是同一类错误（读路径签令牌），
 * 也是 W3 里记下的那条硬结论。
 *
 * 拆开之后的职责：
 * - 这里只负责**事实**：同 `(项目, 仓库)` 的并发读合并成一次远端往返，并给事实一个 `revision`；
 * - 令牌仍然**每次现签**（在 `remoteGitReadIpc` 里），绑定的就是当前这份事实的 revision；
 * - 事实会不会旧？会——但旧事实**不能**让写穿过去：helper 侧每个写动词都带 `expectedRevision`
 *   （`git.push`/`git.pull` 等已在用），revision 不符时远端自己拒绝。所以「缓存事实」不会削弱安全边界，
 *   只会让界面看到稍旧的快照，而这正是用户点刷新要解决的事。
 *
 * 失效：任何写动词成功、仓库发现变化、`git.init` 之后都标脏；标脏只让下一次读重新装载，不主动装载。
 */

export type SnapshotFactsCacheOptions = {
	/** 单项目缓存的仓库数上限（多仓项目最多也就几个；上限只是防御异常输入）。 */
	maxReposPerProject?: number;
};

/** 一次读事实的条件：连接代数围栏与显式刷新。 */
export type SnapshotFactsReadOptions = {
	/** 连接代数（`RemoteProjectSession.connectionId`）：变了就不能再发布旧代事实。 */
	generation?: string;
	/** 显式刷新：越过已完成缓存（在途同代装载仍可合并）。 */
	force?: boolean;
};

type Entry<T> = { facts: T; revision: number; stale: boolean; generation?: string };
type Flight<T> = { cancelled: boolean; generation?: string; promise: Promise<{ facts: T; revision: number }> };

export type SnapshotFactsCache<T> = {
	/** 读事实：命中就返回，未命中/已标脏/换就装载（同键并发只装载一次）。 */
	read(projectId: string, repoPath: string, load: () => Promise<T>, options?: SnapshotFactsReadOptions): Promise<{ facts: T; revision: number; cached: boolean }>;
	/** 显式刷新：越过已完成缓存；已完成的旧事实不能满足一次明确核对。 */
	refresh(projectId: string, repoPath: string, load: () => Promise<T>, options?: Omit<SnapshotFactsReadOptions, "force">): Promise<{ facts: T; revision: number; cached: boolean }>;
	/** 现值（不装载）：用来判断“这次读是否会命中暖缓存”，从而决定是否需要活的连接身份。 */
	peek(projectId: string, repoPath: string): { facts: T; revision: number; stale: boolean } | undefined;
	/** 标脏一个仓库（写动词成功后调用）。 */
	invalidate(projectId: string, repoPath: string): void;
	/** 标脏一个项目的全部仓库（`git.init`、仓库发现变化后调用）。 */
	invalidateProject(projectId: string): void;
	/** 丢弃全部（宿主断开/项目关闭）。 */
	clear(): void;
	stats(): { loads: number; merges: number; hits: number; entries: number };
};

const KEY_SEPARATOR = "\u0000";

export function createSnapshotFactsCache<T>(options: SnapshotFactsCacheOptions = {}): SnapshotFactsCache<T> {
	const maxRepos = Math.max(1, Math.trunc(options.maxReposPerProject ?? 32));
	const entries = new Map<string, Entry<T>>();
	const inflight = new Map<string, Flight<T>>();
	const counters = { loads: 0, merges: 0, hits: 0 };
	let revisionCounter = 0;

	const keyOf = (projectId: string, repoPath: string) => projectId + KEY_SEPARATOR + repoPath;
	const projectPrefix = (projectId: string) => projectId + KEY_SEPARATOR;
	const cachedFrom = (settled: { facts: T; revision: number }) => ({ facts: settled.facts, revision: settled.revision, cached: true });

	function trimProject(projectId: string): void {
		const keys = [...entries.keys()].filter((key) => key.startsWith(projectPrefix(projectId)));
		// 淘汰最久未用的（Map 保持插入顺序）：先到先出，够用且行为确定。
		while (keys.length > maxRepos) {
			const victim = keys.shift();
			if (victim === undefined) break;
			entries.delete(victim);
		}
	}

	/** 退休一个在途装载：摘掉登记（下一次读可重建 flight）并标记它不得发布结果。 */
	function retireFlight(key: string): void {
		const flight = inflight.get(key);
		if (flight === undefined) return;
		flight.cancelled = true;
		inflight.delete(key);
	}

	/** 本项目的在途装载 key（包含尚无缓存值、只有挂起请求的那些）。 */
	function projectFlightKeys(projectId: string): string[] {
		const prefix = projectPrefix(projectId);
		return [...inflight.keys()].filter((key) => key.startsWith(prefix));
	}

	async function readFacts(projectId: string, repoPath: string, load: () => Promise<T>, options: SnapshotFactsReadOptions = {}) {
		const key = keyOf(projectId, repoPath);
		const generation = options.generation;
		const hit = entries.get(key);
		if (hit !== undefined && hit.generation !== generation && !hit.stale) {
			// 换代：旧代事实不能继续代表现在。保留值（失败时 UI 仍可展示并标「陈旧」），只推进 revision。
			revisionCounter += 1;
			entries.set(key, { ...hit, revision: revisionCounter, stale: true });
		}
		const current = entries.get(key);
		if (options.force !== true && current !== undefined && !current.stale && current.generation === generation) {
			counters.hits += 1;
			// 命中即「用过」：移到末尾，避免热仓库被先淘汰。
			entries.delete(key);
			entries.set(key, current);
			return { facts: current.facts, revision: current.revision, cached: true };
		}
		const running = inflight.get(key);
		if (running !== undefined) {
			if (running.generation === generation) {
				counters.merges += 1;
				return cachedFrom(await running.promise);
			}
			// 旧代在途读不得被新代读合并：退休它，另起一飞。
			retireFlight(key);
		}
		counters.loads += 1;
		const flight = { cancelled: false, generation } as Flight<T>;
		const pending = (async () => {
			const facts = await load();
			// 失效/清理发生在装载途中：旧结果不得重新入缓存，读者拿到既有取消语义。
			if (flight.cancelled) throw new Error("REQUEST_CANCELLED");
			revisionCounter += 1;
			const revision = revisionCounter;
			entries.set(key, { facts, revision, stale: false, ...(generation === undefined ? {} : { generation }) });
			trimProject(projectId);
			return { facts, revision };
		})();
		flight.promise = pending;
		inflight.set(key, flight);
		try {
			const settled = await pending;
			return { facts: settled.facts, revision: settled.revision, cached: false };
		} catch (error) {
			if (flight.cancelled) throw new Error("REQUEST_CANCELLED");
			throw error;
		} finally {
			// 只删自己：退休读的 finally 不能把替代它的新 flight 从登记表里删掉。
			if (inflight.get(key) === flight) inflight.delete(key);
		}
	}

	return {
		read: readFacts,
		refresh: (projectId, repoPath, load, options) => readFacts(projectId, repoPath, load, { ...options, force: true }),
		peek(projectId, repoPath) {
			const entry = entries.get(keyOf(projectId, repoPath));
			return entry === undefined || entry.facts === undefined ? undefined : { facts: entry.facts, revision: entry.revision, stale: entry.stale };
		},
		invalidate(projectId, repoPath) {
			const key = keyOf(projectId, repoPath);
			retireFlight(key);
			const hit = entries.get(key);
			// 没有现值也要记一笔：否则「先失效、后读取」会读到一个看起来没被失效过的新值。
			// 用 stale 标记一个占位即可，装载时会覆盖它。
			if (hit === undefined) {
				revisionCounter += 1;
				entries.set(key, { facts: undefined as unknown as T, revision: revisionCounter, stale: true });
				trimProject(projectId);
				return;
			}
			if (hit.stale) return;
			revisionCounter += 1;
			entries.set(key, { ...hit, revision: revisionCounter, stale: true });
		},
		invalidateProject(projectId) {
			for (const key of projectFlightKeys(projectId)) retireFlight(key);
			for (const key of [...entries.keys()]) {
				if (!key.startsWith(projectPrefix(projectId))) continue;
				const hit = entries.get(key);
				if (hit === undefined || hit.stale) continue;
				revisionCounter += 1;
				entries.set(key, { ...hit, revision: revisionCounter, stale: true });
			}
		},
		clear() {
			for (const key of [...inflight.keys()]) retireFlight(key);
			entries.clear();
		},
		stats: () => ({ ...counters, entries: entries.size }),
	};
}
