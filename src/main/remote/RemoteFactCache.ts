/**
 * 远端事实缓存（v5 §3「事实层」的地基）：**同一个 key 在同一时刻只有一个装载，读的人共享同一份事实**。
 *
 * 为什么需要它：现在文件树、Git 面板、侧栏圆点各自问远端「有哪些文件 / 改了什么」，一次内容变化
 * 会打出两三次 SSH 往返，而且各自的结论可能不一致（不同时刻的快照）。把「谁缓存、谁合并重复请求、
 * 谁决定刷新成本」集中到一处之后：
 * - 并发读同一个 key 只有一个装载（`merges` 计数可断言）；
 * - `invalidate` 只标脏，不触发装载——**刷新成本由读的人决定**，不因为一次写就广播风暴；
 * - `revision` 由这里在「值被替换」或「被标脏」时递增，所以两个界面读同一个 key 时拿到**同一个**
 *   revision，不再各算各的。
 *
 * 刻意不做的事：不轮询、不订阅、不认识 SSH 与 Git。装载函数由调用方注入（本文件的测试就是一个假端口），
 * 所以这里的合并/失效/上限行为全部可离线复现。
 */
import { opFail, type Op, type OpFailure } from "../../shared/op";

/** 一次读取的结果：成功带值，失败带稳定码，两者都带当前的 revision。 */
export type FactSnapshot<T> = { ok: true; value: T; revision: number; stale: boolean } | (OpFailure & { revision: number });

export type FactCacheStats = {
	/** 真正发出去的装载次数。 */
	loads: number;
	/** 因为已有装载在进行而搭车的读取次数（合并掉的重复请求）。 */
	merges: number;
	/** 命中现值、没有装载的读取次数。 */
	hits: number;
	/** 装载失败的次数。 */
	failures: number;
	/** 当前在途装载数。 */
	inflight: number;
	/** 当前缓存的 key 数。 */
	entries: number;
};

export type FactCache<T> = {
	/** 读一个 key：有现值就返回，标脏或不存在就装载（同 key 并发只装载一次）。 */
	read(key: string): Promise<FactSnapshot<T>>;
	/** 标脏：不改值，只让下一次读取去装载。已标脏的 key 重复标脏不额外涨 revision。 */
	invalidate(key: string): void;
	/** 标脏全部匹配的 key（用于「一次写影响多个事实」的失效矩阵）。 */
	invalidateWhere(matches: (key: string) => boolean): void;
	/** 强制重新装载（读的人明确要求刷新时用）。 */
	refresh(key: string): Promise<FactSnapshot<T>>;
	/** 现值（不装载），给「只想渲染已知事实」的路径用。 */
	peek(key: string): FactSnapshot<T> | undefined;
	stats(): FactCacheStats;
	/** 丢弃全部状态（host 断开、项目关闭时调用，避免旧事实跨连接存活）。 */
	clear(): void;
	/** 只丢弃匹配的键（单项目关闭）：不装载、不碰其它项目。 */
	clearWhere(matches: (key: string) => boolean): void;
};

type Entry<T> = { value: T | undefined; revision: number; stale: boolean };
type Inflight<T> = Promise<FactSnapshot<T>>;

/**
 * @param load 装载函数：一次调用对应一次真实的远端往返。
 * @param options.maxEntries 缓存上限（LRU 淘汰）；默认 512，够一个项目的目录树 + 仓库列表。
 */
export function createFactCache<T>(load: (key: string) => Promise<Op<T>>, options: { maxEntries?: number } = {}): FactCache<T> {
	const maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? 512));
	const entries = new Map<string, Entry<T>>();
	const inflight = new Map<string, Inflight<T>>();
	let revisionCounter = 0;
	const counters = { loads: 0, merges: 0, hits: 0, failures: 0 };

	function bump(): number {
		revisionCounter += 1;
		return revisionCounter;
	}

	/** LRU：读到的 key 移到末尾，淘汰时从头部取最久未用。 */
	function touch(key: string, entry: Entry<T>): Entry<T> {
		entries.delete(key);
		entries.set(key, entry);
		while (entries.size > maxEntries) {
			const oldest = entries.keys().next();
			if (oldest.done === true) break;
			entries.delete(oldest.value);
		}
		return entry;
	}

	function snapshotOf(key: string): FactSnapshot<T> | undefined {
		const entry = entries.get(key);
		if (entry === undefined || entry.value === undefined) return undefined;
		touch(key, entry);
		return { ok: true, value: entry.value, revision: entry.revision, stale: entry.stale };
	}

	async function startLoad(key: string): Promise<FactSnapshot<T>> {
		counters.loads += 1;
		const pending = load(key)
			.then((result): FactSnapshot<T> => {
				const existing = entries.get(key);
				if (result.ok) {
					// 值被替换才涨 revision：同值重载不该让下游重渲染。
					const revision = bump();
					touch(key, { value: result.value, revision, stale: false });
					return { ok: true, value: result.value, revision, stale: false };
				}
				counters.failures += 1;
				// 失败不涨 revision、也不保留「有个新值」的假象：旧值仍在，只是确认它仍然是旧的。
				const revision = existing?.revision ?? bump();
				if (existing !== undefined) touch(key, { ...existing, stale: true });
				return { ...opFail(result.code, result.outcome), revision };
			})
			.finally(() => {
				inflight.delete(key);
			});
		inflight.set(key, pending);
		return await pending;
	}

	async function ensureLoaded(key: string, force: boolean): Promise<FactSnapshot<T>> {
		const entry = entries.get(key);
		if (!force && entry !== undefined && entry.value !== undefined && !entry.stale) {
			counters.hits += 1;
			// 命中也是「用过」：不 touch 的话 LRU 会按写入顺序淘汰，热 key 反被踢掉。
			touch(key, entry);
			return { ok: true, value: entry.value, revision: entry.revision, stale: false };
		}
		const running = inflight.get(key);
		if (running !== undefined) {
			counters.merges += 1;
			return await running;
		}
		return await startLoad(key);
	}

	function invalidateKey(key: string): void {
		const entry = entries.get(key);
		if (entry === undefined) {
			// 没有现值也要记账：否则「先失效、后读取」会读到一个看起来「没被失效过」的新值。
			touch(key, { value: undefined, revision: bump(), stale: true });
			return;
		}
		if (entry.stale) return;
		touch(key, { ...entry, revision: bump(), stale: true });
	}

	return {
		read: (key) => ensureLoaded(key, false),
		refresh: (key) => ensureLoaded(key, true),
		peek: (key) => snapshotOf(key),
		invalidate: invalidateKey,
		invalidateWhere(matches: (key: string) => boolean): void {
			for (const key of [...entries.keys()]) if (matches(key)) invalidateKey(key);
		},
		stats: () => ({ ...counters, inflight: inflight.size, entries: entries.size }),
		clear(): void {
			// 在途装载不取消：它 settle 时会把结果写回，调用方（host 断开后的下一次读取）再自行决定是否采用。
			entries.clear();
		},
		clearWhere(matches: (key: string) => boolean): void {
			for (const key of [...entries.keys()]) if (matches(key)) entries.delete(key);
		},
	};
}
