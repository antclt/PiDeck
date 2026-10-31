/**
 * 深层目录订阅（P0-4）：helper 的 `fs.watch` 是非递归的，只订阅根目录时深层变化永远看不到。
 *
 * 为什么不能「每读到一个目录就 ensure 一次」：`RemoteDirWatchRegistry.ensure` 只能为**尚未被任何
 * watcher 覆盖**的路径新建 watcher，已有 watcher 的路径集不可扩展；helper 的预算是 4 watcher ×
 * 32 路径。逐目录 ensure 会在第 4 个目录后静默触顶，之后深层目录永远监听不到——而调用方看不出
 * 失败，会以为已经覆盖。
 *
 * 正确形状：
 * - 按 `(hostId, projectId)` 维护**期望路径集**（去重；根目录在前）；
 * - 目录读成功后登记，150–250ms 合并窗口后**一次性** ensure 全量；需要扩展时先成对退订本项目旧
 *   集合（rewatch），再按新全集分片（registry 负责 32 路径/片）；
 * - 超过 128 条路径或 watcher 预算被占满时**明确降级**：结构化日志 + 可断言状态，不假装覆盖；
 * - 换代（新 connectionId）时旧 watcher 已随会话死亡，只换代不发退订；项目关闭/断连/退出成对
 *   收尾；迟到的 watchId 由 registry 的代次判断拒绝登记到新会话。
 *
 * 本模块不碰事实缓存，也不依赖 IPC：只把「期望什么、实际覆盖什么」算清楚。
 */
import { getAppLogger } from "../logging/sharedLogger";
import { DIR_WATCH_LIMITS, type DirWatchRegistry } from "./RemoteDirWatchRegistry";

/** helper 会话的最小端口：一次目录读期间拿到的绑定会话（request 已绑定 manager）。 */
export type DeepDirWatchSession = {
	readonly connectionId: string;
	request(method: string, params?: unknown): Promise<unknown>;
};

/** 一次明确的降级：不是「订阅能力缺失」，而是预算不够，必须让用户/诊断看得到覆盖缺口。 */
export type DeepDirWatchDegraded = {
	projectId: string;
	hostId: string;
	reason: "paths-over-limit" | "watcher-capacity";
	/** 期望监听的路径数。 */
	desired: number;
	/** 真正被 watcher 覆盖的路径数。 */
	covered: number;
	/** 因为预算没有覆盖到的路径数。 */
	dropped: number;
};

export type DeepDirWatchStatus = {
	desired: readonly string[];
	covered: readonly string[];
	degraded?: DeepDirWatchDegraded;
};

export type DeepDirWatchTimer = {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
};

export type DeepDirWatchOptions = {
	registry: DirWatchRegistry;
	/** 单个项目最多监听多少条路径（4 watcher × 32 路径）。 */
	maxPaths?: number;
	/** 合并窗口：一次展开会连续读多层，窗口内只 rewatch 一次。 */
	windowMs?: number;
	/** 结构化降级日志（主进程 logger；测试注入收集器）。 */
	log?(degraded: DeepDirWatchDegraded): void;
	timer?: DeepDirWatchTimer;
};

export type DeepDirWatch = {
	/**
	 * 目录读成功后登记。根目录立即冲刷（与旧的根订阅时机一致），深层目录走合并窗口。
	 * 返回的 Promise 只覆盖「立即冲刷」那一次（深层目录返回已解决的 Promise）。
	 */
	record(projectId: string, hostId: string, path: string, session: DeepDirWatchSession): Promise<void>;
	/** 立即冲刷合并窗口（测试/诊断/关闭前）。 */
	flush(): Promise<void>;
	/** 可断言的覆盖/降级状态。 */
	status(projectId: string): DeepDirWatchStatus;
	/** 项目关闭：丢弃期望集合与待冲刷（退订由 registry.closeProject 负责）。 */
	forgetProject(projectId: string): void;
	/** 断连：丢弃该主机的全部期望集合（helper 已死，不发退订）。 */
	forgetHost(hostId: string): void;
	/** 进程退出：清空登记与待冲刷（退订由 registry 负责）。 */
	dispose(): void;
};

/** 默认定时器：只是合并窗口，不该把进程挂在这条待冲刷上。 */
function defaultTimer(): DeepDirWatchTimer {
	return {
		set(callback, ms) {
			const handle = setTimeout(callback, ms);
			handle.unref?.();
			return handle;
		},
		clear(handle) {
			clearTimeout(handle as ReturnType<typeof setTimeout>);
		},
	};
}

type ProjectWatch = {
	hostId: string;
	/** 期望监听的路径：根在前，其余按登记顺序（去重）。 */
	desired: string[];
	desiredSet: Set<string>;
	/** 最近一次读拿到的会话（冲刷时用它发 fs.watch/fs.unwatch）。 */
	session?: DeepDirWatchSession;
	/** 上一次冲刷用的连接代：换代时旧覆盖不算数（旧 helper 的 watcher 已死）。 */
	flushedSession?: string;
	/** 待冲刷的合并窗口句柄。 */
	handle?: unknown;
	/** 最近一次可断言的降级（成功后清除）。 */
	degraded?: DeepDirWatchDegraded;
};

export function createDeepDirWatch(options: DeepDirWatchOptions): DeepDirWatch {
	const registry = options.registry;
	const maxPaths = Math.max(1, Math.trunc(options.maxPaths ?? DIR_WATCH_LIMITS.watchersPerHost * DIR_WATCH_LIMITS.pathsPerWatcher));
	const windowMs = Math.max(1, Math.trunc(options.windowMs ?? 200));
	const log = options.log ?? ((degraded: DeepDirWatchDegraded) => getAppLogger()?.warn("remote-dir-watch", "deep dir watch degraded: " + degraded.reason, degraded));
	const timer = options.timer ?? defaultTimer();
	const projects = new Map<string, ProjectWatch>();
	/** 每个项目一条冲刷链：冲刷不叠跑，后到的登记排在后面。 */
	const chains = new Map<string, Promise<void>>();

	const subscribe =
		(session: DeepDirWatchSession) =>
		async (paths: readonly string[]): Promise<string | undefined> => {
			try {
				const result: unknown = await session.request("fs.watch", { paths: [...paths] });
				return typeof result === "object" && result !== null && typeof (result as { watchId?: unknown }).watchId === "string" ? (result as { watchId: string }).watchId : undefined;
			} catch {
				// 订阅不是读的前置条件：helper 不支持/会话已死都退回只读刷新，不向用户报错。
				return undefined;
			}
		};
	const unwatch =
		(session: DeepDirWatchSession) =>
		(watchId: string): Promise<unknown> =>
			session.request("fs.unwatch", { watchId });

	async function flushProject(projectId: string, state: ProjectWatch): Promise<void> {
		if (state.handle !== undefined) {
			timer.clear(state.handle);
			state.handle = undefined;
		}
		const session = state.session;
		if (session === undefined) return;
		const target = state.desired.slice(0, maxPaths);
		const sameGeneration = state.flushedSession === session.connectionId;
		state.flushedSession = session.connectionId;
		const coveredBefore = sameGeneration ? new Set(registry.pathsOf(state.hostId, projectId)) : new Set<string>();
		const missing = target.filter((path) => !coveredBefore.has(path));
		let rejected = 0;
		if (missing.length > 0) {
			// 已有 watcher 的路径集不可扩展：先成对退订本项目的旧集合，再按新全集分片。
			// 换代时旧 helper 的 watcher 已随会话死亡，不发退订（请求只会失败）。
			if (sameGeneration) await registry.releaseProject(state.hostId, projectId);
			rejected = (await registry.ensure(state.hostId, session.connectionId, projectId, subscribe(session), { paths: target, unwatch: unwatch(session) })).rejected;
			// 冲刷期间项目被关闭/主机断连：刚登记的订阅不属于任何活着的项目，成对收回。
			if (projects.get(projectId) !== state) {
				await registry.releaseProject(state.hostId, projectId);
				return;
			}
		}
		const covered = registry.pathsOf(state.hostId, projectId);
		const coveredSet = new Set(covered);
		const dropped = state.desired.filter((path) => !coveredSet.has(path)).length;
		const degraded: DeepDirWatchDegraded | undefined =
			state.desired.length > maxPaths
				? { projectId, hostId: state.hostId, reason: "paths-over-limit", desired: state.desired.length, covered: covered.length, dropped }
				: rejected > 0
					? { projectId, hostId: state.hostId, reason: "watcher-capacity", desired: state.desired.length, covered: covered.length, dropped }
					: undefined;
		const previous = state.degraded;
		state.degraded = degraded;
		if (degraded !== undefined && (previous === undefined || previous.reason !== degraded.reason || previous.covered !== degraded.covered)) log(degraded);
	}

	function schedule(projectId: string): void {
		const state = projects.get(projectId);
		if (state === undefined || state.handle !== undefined) return;
		state.handle = timer.set(() => {
			const current = projects.get(projectId);
			if (current !== undefined) current.handle = undefined;
			void enqueue(projectId);
		}, windowMs);
	}

	/** 冲刷入队：同一项目串行，后到的登记不丢。 */
	function enqueue(projectId: string): Promise<void> {
		const previous = chains.get(projectId) ?? Promise.resolve();
		const next = previous.then(async () => {
			const state = projects.get(projectId);
			if (state === undefined) return;
			await flushProject(projectId, state);
		});
		const settled = next.catch(() => undefined);
		chains.set(projectId, settled);
		void settled.finally(() => {
			if (chains.get(projectId) === settled) chains.delete(projectId);
		});
		return settled;
	}

	return {
		async record(projectId, hostId, path, session) {
			let state = projects.get(projectId);
			if (state === undefined) {
				state = { hostId, desired: [], desiredSet: new Set<string>() };
				projects.set(projectId, state);
			}
			state.session = session;
			const added = !state.desiredSet.has(path);
			if (added) {
				state.desiredSet.add(path);
				state.desired.push(path);
			}
			// 根目录读到就订阅（与旧的根订阅时机一致）：深层目录由它自己的登记进合并窗口。
			if (path === "") return enqueue(projectId);
			if (added) schedule(projectId);
		},
		async flush() {
			const pending = [...projects.keys()].filter((projectId) => projects.get(projectId)?.handle !== undefined);
			await Promise.all(pending.map((projectId) => enqueue(projectId)));
		},
		status(projectId) {
			const state = projects.get(projectId);
			if (state === undefined) return { desired: [], covered: [] };
			const covered = registry.pathsOf(state.hostId, projectId);
			return { desired: [...state.desired], covered, ...(state.degraded === undefined ? {} : { degraded: state.degraded }) };
		},
		forgetProject(projectId) {
			const state = projects.get(projectId);
			if (state === undefined) return;
			if (state.handle !== undefined) timer.clear(state.handle);
			projects.delete(projectId);
		},
		forgetHost(hostId) {
			for (const [projectId, state] of [...projects]) {
				if (state.hostId !== hostId) continue;
				if (state.handle !== undefined) timer.clear(state.handle);
				projects.delete(projectId);
			}
		},
		dispose() {
			for (const state of projects.values()) if (state.handle !== undefined) timer.clear(state.handle);
			projects.clear();
			chains.clear();
		},
	};
}
