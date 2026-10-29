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

type Entry<T> = { facts: T; revision: number; stale: boolean };

export type SnapshotFactsCache<T> = {
	/** 读事实：命中就返回，未命中/已标脏就装载（同键并发只装载一次）。 */
	read(projectId: string, repoPath: string, load: () => Promise<T>): Promise<{ facts: T; revision: number; cached: boolean }>;
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
	const inflight = new Map<string, Promise<{ facts: T; revision: number }>>();
	const counters = { loads: 0, merges: 0, hits: 0 };
	let revisionCounter = 0;

	const keyOf = (projectId: string, repoPath: string) => projectId + KEY_SEPARATOR + repoPath;
	const projectPrefix = (projectId: string) => projectId + KEY_SEPARATOR;

	function trimProject(projectId: string): void {
		const keys = [...entries.keys()].filter((key) => key.startsWith(projectPrefix(projectId)));
		// 淘汰最久未用的（Map 保持插入顺序）：先到先出，够用且行为确定。
		while (keys.length > maxRepos) {
			const victim = keys.shift();
			if (victim === undefined) break;
			entries.delete(victim);
		}
	}

	return {
		async read(projectId, repoPath, load) {
			const key = keyOf(projectId, repoPath);
			const hit = entries.get(key);
			if (hit !== undefined && !hit.stale) {
				counters.hits += 1;
				// 命中即「用过」：移到末尾，避免热仓库被先淘汰。
				entries.delete(key);
				entries.set(key, hit);
				return { facts: hit.facts, revision: hit.revision, cached: true };
			}
			const running = inflight.get(key);
			if (running !== undefined) {
				counters.merges += 1;
				const settled = await running;
				return { facts: settled.facts, revision: settled.revision, cached: true };
			}
			counters.loads += 1;
			const pending = load().then((facts) => {
				revisionCounter += 1;
				const revision = revisionCounter;
				entries.set(key, { facts, revision, stale: false });
				trimProject(projectId);
				return { facts, revision };
			});
			inflight.set(key, pending);
			try {
				const settled = await pending;
				return { facts: settled.facts, revision: settled.revision, cached: false };
			} finally {
				inflight.delete(key);
			}
		},
		invalidate(projectId, repoPath) {
			const key = keyOf(projectId, repoPath);
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
			entries.set(key, { facts: hit.facts, revision: revisionCounter, stale: true });
		},
		invalidateProject(projectId) {
			for (const key of [...entries.keys()]) {
				if (!key.startsWith(projectPrefix(projectId))) continue;
				const hit = entries.get(key);
				if (hit === undefined || hit.stale) continue;
				revisionCounter += 1;
				entries.set(key, { facts: hit.facts, revision: revisionCounter, stale: true });
			}
		},
		clear() {
			entries.clear();
		},
		stats: () => ({ ...counters, entries: entries.size }),
	};
}
