/**
 * 远端 helper 调用计量（W0 基线，见 docs/remote-file-tree-and-git-unification-plan.md §4）。
 *
 * 为什么计在 helper 的 `request` 而不是各 IPC 通道：**一次 request = 一次 SSH 往返**，这是唯一的
 * 成本单位；通道层会随着统一改造（单通道族 / 事实层）不断变化，计在通道上得到的是"改动量"，
 * 计在 request 上得到的是"用户的真实开销"。W3 的预算门禁（一次内容变化 `listRepos ≤1`、
 * 每仓 `status ≤1`）就直接读这里的数字，不再靠人工统计。
 *
 * 刻意保持的能力边界：
 * - 内存 only、无 IPC、无新通道（不违反"不加第二条 pi↔PiDeck 通道"的纪律）；
 * - 有界（不同 (hostId, method) 键上限，超出折进 `__other__`），不因为异常输入涨内存；
 * - 默认静默；只在 `PIDECK_REMOTE_METER=1` 时低频打印一行汇总，供基线采样。
 */
export type RemoteCallCount = { hostId: string; method: string; calls: number };

/** 计数端口：注入到 `RemoteControlClient`，测试可替换。 */
export type RemoteCallMeterPort = { record(hostId: string, method: string): void };

export const REMOTE_CALL_METER_OVERFLOW_METHOD = "__other__";
const DEFAULT_MAX_KEYS = 256;
const DEFAULT_LOG_INTERVAL_MS = 5_000;

export type RemoteCallMeter = {
	record(hostId: string, method: string): void;
	/** 按调用次数降序的快照（拷贝，调用方可随意保留）。 */
	snapshot(): RemoteCallCount[];
	total(): number;
	reset(): void;
};

/** 一行汇总：`remote-meter total=42 unique=5 git.status×20 …`。只在诊断时用，不面向用户。 */
export function formatRemoteCallMeter(counts: readonly RemoteCallCount[], total: number, limit = 8): string {
	const head = `remote-meter total=${total} unique=${counts.length}`;
	if (counts.length === 0) return head;
	const parts = counts.slice(0, Math.max(1, limit)).map((entry) => `${entry.hostId.slice(0, 8)}:${entry.method}×${entry.calls}`);
	return `${head} ${parts.join(" ")}`;
}

export function createRemoteCallMeter(
	options: {
		/** 不同 (hostId, method) 键上限；超出后折进 `__other__`（腾位时淘汰调用次数最少的键）。 */
		maxKeys?: number;
		now?: () => number;
		/** 汇总输出口；`null` = 完全不打印。 */
		log?: ((line: string) => void) | null;
		logIntervalMs?: number;
		/** 是否打印：默认只看 `PIDECK_REMOTE_METER=1`。 */
		enabled?: () => boolean;
	} = {},
): RemoteCallMeter {
	const maxKeys = Math.max(2, Math.trunc(options.maxKeys ?? DEFAULT_MAX_KEYS));
	const now = options.now ?? Date.now;
	const log = options.log === undefined ? null : options.log;
	const logIntervalMs = Math.max(0, options.logIntervalMs ?? DEFAULT_LOG_INTERVAL_MS);
	const enabled = options.enabled ?? (() => process.env.PIDECK_REMOTE_METER === "1");
	const counts = new Map<string, RemoteCallCount>();
	let total = 0;
	let lastLogAt = Number.NEGATIVE_INFINITY;

	function foldIntoOverflow(hostId: string): void {
		const overflowKey = `${hostId}\u0000${REMOTE_CALL_METER_OVERFLOW_METHOD}`;
		const overflow = counts.get(overflowKey);
		if (overflow) {
			overflow.calls += 1;
			return;
		}
		// 已到上限：淘汰调用次数最少的键腾一格，保证键数恒有界。
		if (counts.size >= maxKeys) {
			let victimKey: string | undefined;
			let victimCalls = Number.POSITIVE_INFINITY;
			for (const [key, entry] of counts) {
				if (entry.calls < victimCalls) {
					victimCalls = entry.calls;
					victimKey = key;
				}
			}
			if (victimKey !== undefined) counts.delete(victimKey);
		}
		counts.set(overflowKey, { hostId, method: REMOTE_CALL_METER_OVERFLOW_METHOD, calls: 1 });
	}

	function maybeLog(): void {
		if (log === null || !enabled()) return;
		const at = now();
		if (at - lastLogAt < logIntervalMs) return;
		lastLogAt = at;
		log(formatRemoteCallMeter(snapshot(), total));
	}

	function snapshot(): RemoteCallCount[] {
		return [...counts.values()].map((entry) => ({ ...entry })).sort((left, right) => right.calls - left.calls || left.hostId.localeCompare(right.hostId) || left.method.localeCompare(right.method));
	}

	return {
		record(hostId: string, method: string): void {
			if (typeof hostId !== "string" || typeof method !== "string") return;
			total += 1;
			const key = `${hostId}\u0000${method}`;
			const existing = counts.get(key);
			if (existing !== undefined) existing.calls += 1;
			else if (counts.size < maxKeys) counts.set(key, { hostId, method, calls: 1 });
			else foldIntoOverflow(hostId);
			maybeLog();
		},
		snapshot,
		total: () => total,
		reset(): void {
			counts.clear();
			total = 0;
			lastLogAt = Number.NEGATIVE_INFINITY;
		},
	};
}

/** 进程级单例：`RemoteControlClient` 默认写入这里。 */
export const remoteCallMeter: RemoteCallMeter = createRemoteCallMeter({ log: (line) => console.info(line) });
