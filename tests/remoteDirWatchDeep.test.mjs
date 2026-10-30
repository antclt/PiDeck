import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * P0-4：深层目录订阅（helper 非递归 fs.watch）。
 *
 * 旧实现只在根目录读到时 ensure(paths: [""])，深层目录永远监听不到。而 helper 的预算是
 * 4 watcher × 32 路径，且 `ensure` 只能为「未被任何 watcher 覆盖的路径」新建 watcher——逐目录
 * ensure 会在第 4 次后静默触顶。正确形状：按 (host, project) 维护**期望路径集**，合并窗口后
 * 一次性 ensure/rewatch；超限留可断言的降级状态，不静默假装覆盖。
 *
 * 这里钉：分片、第 5 个 watcher 拒绝并降级、逐目录读取不产生每目录一个 watcher、换会话不认旧
 * watchId、迟到 watchId 不登记到新会话、项目关闭只退订该项目。
 */
const { createDirWatchRegistry, DIR_WATCH_LIMITS } = loadTsCommonJs("src/main/remote/RemoteDirWatchRegistry.ts");
const { createDeepDirWatch } = loadTsCommonJs("src/main/remote/RemoteDeepDirWatch.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

const HOST = "11111111-1111-4111-8111-111111111111";
const PROJECT = "project-remote-1";
const PROJECT_2 = "project-remote-2";
const plain = (value) => JSON.parse(JSON.stringify(value));

function fakeTimer() {
	const timers = [];
	const cleared = new Set();
	return {
		timers,
		set(callback, intervalMs) {
			timers.push({ callback, intervalMs, cleared: false });
			return timers.length - 1;
		},
		clear(handle) {
			cleared.add(handle);
			if (timers[handle] !== undefined) timers[handle].cleared = true;
		},
		/** 触发所有未清理的窗口（模拟合并窗口到期）。 */
		fire() {
			for (const timer of timers) if (!timer.cleared) timer.callback();
		},
	};
}

function sessionHarness(connectionId, calls) {
	const state = { seq: 0 };
	return {
		connectionId,
		async request(method, params) {
			if (method === "fs.watch") {
				state.seq += 1;
				const watchId = "w-" + connectionId + "-" + state.seq;
				calls.push({ kind: "watch", paths: [...params.paths], connectionId, watchId });
				return { watchId };
			}
			if (method === "fs.unwatch") {
				calls.push({ kind: "unwatch", watchId: params.watchId });
				return { ok: true };
			}
			throw new Error("UNEXPECTED_METHOD");
		},
	};
}

function planner(options = {}) {
	const registry = createDirWatchRegistry();
	const timer = fakeTimer();
	const logs = [];
	const watch = createDeepDirWatch({ registry, timer, log: (degraded) => logs.push(degraded), ...options });
	const calls = [];
	return { registry, timer, logs, watch, calls, session: (connectionId) => sessionHarness(connectionId, calls) };
}
const watchesOf = (calls) => calls.filter((call) => call.kind === "watch");

test("33 条路径按 32 分片成两个 watcher，一次全量 ensure 而不是逐目录", async () => {
	const p = planner();
	const session = p.session("conn-1");
	await p.watch.record(PROJECT, HOST, "", session);
	assert.deepEqual(
		watchesOf(p.calls).map((call) => call.paths),
		[[""]],
		"根目录读到就订阅（与旧时机一致）",
	);
	for (let index = 0; index < 32; index += 1) p.watch.record(PROJECT, HOST, "dir" + index, session);
	assert.equal(watchesOf(p.calls).length, 1, "合并窗口内不逐目录发请求");
	await p.watch.flush();
	const requests = watchesOf(p.calls).map((call) => call.paths);
	assert.equal(requests.length, 3, "一次 rewatch：32 + 1 两片");
	assert.equal(requests[1].length, DIR_WATCH_LIMITS.pathsPerWatcher);
	assert.equal(requests[2].length, 1);
	assert.equal(p.registry.sizeOf(HOST), 2, "33 条路径两个 watcher");
	assert.deepEqual(plain(p.watch.status(PROJECT).covered).sort(), ["", ...Array.from({ length: 32 }, (_, index) => "dir" + index)].sort());
	assert.equal(p.watch.status(PROJECT).degraded, undefined);
});

test("第 5 个 watcher 被拒绝，并留下可断言的降级状态（不偷超限）", async () => {
	const p = planner();
	// 别的项目先占满 4 个 watcher。
	for (let index = 0; index < DIR_WATCH_LIMITS.watchersPerHost; index += 1) await p.registry.ensure(HOST, "conn-1", "other-" + index, async () => "x" + index, { paths: [""] });
	assert.equal(p.registry.sizeOf(HOST), DIR_WATCH_LIMITS.watchersPerHost);

	await p.watch.record(PROJECT, HOST, "", p.session("conn-1"));
	assert.equal(p.registry.sizeOf(HOST), DIR_WATCH_LIMITS.watchersPerHost, "超限拒绝，不挤掉别人的 watcher");
	const status = p.watch.status(PROJECT);
	assert.equal(status.degraded?.reason, "watcher-capacity");
	assert.deepEqual(plain(status.covered), []);
	assert.equal(p.logs.length, 1, "降级必须有结构化日志");
	assert.equal(p.logs[0].reason, "watcher-capacity");
	assert.equal(p.logs[0].desired, 1);
});

test("超过 128 条路径：只覆盖上限内的路径并明确降级（paths-over-limit）", async () => {
	const p = planner();
	const session = p.session("conn-1");
	await p.watch.record(PROJECT, HOST, "", session);
	for (let index = 0; index < 128; index += 1) p.watch.record(PROJECT, HOST, "d" + index, session);
	await p.watch.flush();
	const status = p.watch.status(PROJECT);
	assert.equal(status.degraded?.reason, "paths-over-limit");
	assert.equal(status.desired.length, 129);
	assert.equal(status.covered.length, DIR_WATCH_LIMITS.watchersPerHost * DIR_WATCH_LIMITS.pathsPerWatcher);
	assert.equal(status.degraded.dropped, 1);
	assert.equal(p.registry.sizeOf(HOST), DIR_WATCH_LIMITS.watchersPerHost);
});

test("逐目录读取合并成一个 watcher；重复登记不重复订阅", async () => {
	const p = planner();
	const session = p.session("conn-1");
	await p.watch.record(PROJECT, HOST, "", session);
	for (const dir of ["a", "b", "c", "d", "e"]) {
		p.watch.record(PROJECT, HOST, dir, session);
		p.watch.record(PROJECT, HOST, dir, session);
	}
	await p.watch.flush();
	const requests = watchesOf(p.calls).map((call) => call.paths);
	assert.equal(requests.length, 2, "根一次 + 一次全量 ensure");
	assert.deepEqual(requests[1], ["", "a", "b", "c", "d", "e"]);
	assert.equal(p.registry.sizeOf(HOST), 1, "5 个目录不产生 5 个 watcher");
	// 已覆盖的重复登记不再发请求。
	await p.watch.record(PROJECT, HOST, "a", session);
	await p.watch.flush();
	assert.equal(watchesOf(p.calls).length, 2);
});

test("换会话：旧 watchId 不再认，期望路径集在新代重新订阅", async () => {
	const p = planner();
	const first = p.session("conn-1");
	await p.watch.record(PROJECT, HOST, "", first);
	p.watch.record(PROJECT, HOST, "src", first);
	await p.watch.flush();
	const oldIds = p.registry.watchIdsOf(HOST);
	assert.equal(oldIds.length, 1);

	const second = p.session("conn-2");
	await p.watch.record(PROJECT, HOST, "", second);
	for (const watchId of oldIds) assert.equal(p.registry.scopesForEvent(HOST, watchId), undefined, "旧 helper 的 watcher 已随会话死亡");
	const fresh = p.registry.watchIdsOf(HOST);
	assert.equal(fresh.length, 1);
	assert.deepEqual(plain(p.registry.scopesForEvent(HOST, fresh[0])), [{ projectId: PROJECT, paths: ["", "src"] }], "新代覆盖全部期望路径");
	assert.deepEqual(plain(p.watch.status(PROJECT).covered).sort(), ["", "src"]);
});

test("迟到 watchId 不会登记到新会话", async () => {
	const p = planner();
	let release;
	const gated = {
		connectionId: "conn-2",
		async request(method, params) {
			if (method !== "fs.watch") return { ok: true };
			p.calls.push({ kind: "watch", paths: [...params.paths], connectionId: "conn-2", watchId: "w-late" });
			await new Promise((resolve) => {
				release = resolve;
			});
			return { watchId: "w-late" };
		},
	};
	const pendingFirst = p.watch.record(PROJECT, HOST, "", gated);
	// 让第一个冲刷真正进入 fs.watch（冲刷链在微任务里启动）。
	await new Promise((resolve) => setImmediate(resolve));
	const pendingSecond = p.watch.record(PROJECT, HOST, "", p.session("conn-3"));
	await new Promise((resolve) => setImmediate(resolve));
	release();
	await pendingFirst;
	await pendingSecond;
	assert.equal(p.registry.scopesForEvent(HOST, "w-late"), undefined, "迟到的旧代 watchId 不得登记");
	const current = p.registry.watchIdsOf(HOST);
	assert.equal(current.length, 1);
	assert.equal(plain(p.registry.scopesForEvent(HOST, current[0]))[0].projectId, PROJECT);
});

test("项目关闭只退订该项目；迟到的冲刷不得把它订回来", async () => {
	const p = planner();
	const session = p.session("conn-1");
	await p.watch.record(PROJECT, HOST, "", session);
	await p.watch.record(PROJECT_2, HOST, "", session);
	const [firstId, secondId] = p.registry.watchIdsOf(HOST);
	p.watch.forgetProject(PROJECT);
	await p.registry.closeProject(PROJECT);
	assert.deepEqual(
		p.calls.filter((call) => call.kind === "unwatch").map((call) => call.watchId),
		[firstId],
		"只退订关闭的项目",
	);
	assert.deepEqual(plain(p.registry.scopesForEvent(HOST, secondId))[0].projectId, PROJECT_2);
	await p.watch.flush();
	assert.equal(p.registry.sizeOf(HOST), 1, "迟到的冲刷不能把关闭的项目订回来");
	assert.deepEqual(plain(p.watch.status(PROJECT)), { desired: [], covered: [] });
});

test("断连后忘记该主机：待冲刷的窗口不再发请求", async () => {
	const p = planner();
	const session = p.session("conn-1");
	await p.watch.record(PROJECT, HOST, "", session);
	p.watch.record(PROJECT, HOST, "src", session);
	const before = watchesOf(p.calls).length;
	p.watch.forgetHost(HOST);
	p.timer.fire();
	await p.watch.flush();
	assert.equal(watchesOf(p.calls).length, before, "断连后不再发订阅请求");
	assert.deepEqual(plain(p.watch.status(PROJECT)), { desired: [], covered: [] });
});

/* ---------------------------------------------------- 生产接线（remoteProjectIpc） */

function ipcHarness() {
	const calls = { list: [], watches: [], unwatches: [] };
	const handlers = new Map();
	const state = { connectionId: "conn-1", seq: 0 };
	const { registerRemoteProjectIpc } = loadTsCommonJs("src/main/ipc/remoteProjectIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
			"../remote/RemoteBrowseRoot": {
				async resolveRemoteBrowseRoot() {
					return { canonicalPath: "/srv/app" };
				},
			},
			"../remote/RemoteSearchReader": {
				REMOTE_SEARCH_READER_CODES: { queryInvalid: "QUERY_INVALID", requestFailed: "REMOTE_WORKSPACE_REQUEST_FAILED", optionsInvalid: "REMOTE_WORKSPACE_READER_OPTIONS_INVALID" },
				createRemoteSearchReader: () => ({
					async search() {
						return { entries: [], scanned: 0, truncated: false };
					},
				}),
			},
			"../remote/RemoteWorkspaceReader": {
				createRemoteWorkspaceReader: () => ({
					async list(_hostId, path) {
						calls.list.push(path);
						return { entries: [{ name: "src", kind: "directory" }] };
					},
					async readFile() {
						return { content: Buffer.from("x"), bytes: 1, mtimeMs: 1 };
					},
				}),
			},
		},
	});
	const facts = registerRemoteProjectIpc({
		enabled: true,
		userDataDir: "/tmp/unused",
		service: async () => ({
			withProjectSession: async (_hostId, _root, task) => ({
				ok: true,
				value: await task({
					connectionId: state.connectionId,
					request: async (method, params) => {
						if (method === "fs.watch") {
							state.seq += 1;
							calls.watches.push({ paths: [...params.paths], connectionId: state.connectionId });
							return { watchId: "w" + state.seq };
						}
						if (method === "fs.unwatch") {
							calls.unwatches.push(params.watchId);
							return { ok: true };
						}
						throw new Error("UNEXPECTED_METHOD");
					},
					cancel: async () => undefined,
				}),
			}),
		}),
		projects: {
			enroll: async () => ({ projectId: PROJECT }),
			locator: (projectId) => ([PROJECT, PROJECT_2].includes(projectId) ? { kind: "ssh", hostId: HOST, remotePath: "/srv/app" } : undefined),
		},
	});
	const list = (projectId, path) => handlers.get(ipcChannels.remoteProjectList)({}, projectId, path);
	return { calls, state, facts, list };
}

test("生产接线：根读订阅、深层目录按窗口 rewatch 成一份全量；关闭项目只退订该项目", async () => {
	const h = ipcHarness();
	await h.list(PROJECT, "");
	assert.equal(h.calls.watches.length, 1, "根目录读到就订阅（旧行为保持）");
	assert.deepEqual(h.calls.watches[0].paths, [""]);

	await h.list(PROJECT, "src");
	await h.list(PROJECT, "src/deep");
	assert.equal(h.calls.watches.length, 1, "深层目录不逐个建 watcher（窗口内合并）");
	await h.facts.flushDirWatch();
	assert.equal(h.calls.watches.length, 2, "一次全量 ensure");
	assert.deepEqual(h.calls.watches[1].paths, ["", "src", "src/deep"]);
	assert.deepEqual(h.calls.unwatches, ["w1"], "rewatch 先成对退订旧集合");
	const status = h.facts.dirWatchStatus(PROJECT);
	assert.deepEqual(plain(status.desired), ["", "src", "src/deep"]);
	assert.equal(status.degraded, undefined);

	await h.list(PROJECT_2, "");
	assert.equal(h.calls.watches.length, 3);
	await h.facts.closeProject(PROJECT);
	assert.deepEqual(h.calls.unwatches, ["w1", "w2"], "只退订关闭的项目，另一个项目的 watcher 留着");
	assert.deepEqual(plain(h.facts.dirWatchStatus(PROJECT)), { desired: [], covered: [] });
});
