import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * P0-3：远端 Git 面板的 5 秒静默 status 轮询。
 *
 * 本机面板早就有 5 秒 status 轮询，远端只在挂载时读一次、之后靠写面通知；远程终端/Agent 里
 * commit/checkout 后一直不刷新。这里的规则：
 * - 只在 document 可见、hostReady、非变更中、非读中时跑；
 * - 静默：不置 loading、不清掉用户打开的 diff/history/refs/选中行、不 bump 那些 epoch；
 * - 单飞：一次只发一个请求；隐藏/卸载立即停止，停止后在途结果不得发布；
 * - 不 fetch（fetch 是用户动作，轮询只读 status 事实）。
 */
const { REMOTE_GIT_STATUS_POLL_INTERVAL_MS, remoteGitStatusPollingEnabled, startRemoteGitStatusPolling } = loadTsCommonJs("src/renderer/src/utils/remoteGitStatusPolling.ts");
const { createRemoteGitViewController } = loadTsCommonJs("src/renderer/src/utils/remoteGitViewState.ts");

const projectId = "project";
const target = { projectId, relativePath: "file.txt" };
const oid = (char) => char.repeat(40);
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((accept) => setImmediate(accept));

const baseSnapshot = { head: oid("a"), branch: "main", groups: { merge: [], index: [], workingTree: [], untracked: [] } };
const historyRow = (value, subject) => ({ oid: value, parents: [oid("2")], authorName: "A", authorEmail: "a@e.invalid", authorTimeSec: 1700000000, subject });
const detailFor = (value) => ({ oid: value, parents: [oid("2")], authorName: "A", authorEmail: "a@e.invalid", authorTimeSec: 1700000000, committerName: "A", committerEmail: "a@e.invalid", committerTimeSec: 1700000000, subject: "s", message: "s\n", files: [{ status: "M", path: "file.txt" }] });
const diffFor = () => ({ target, path: "file.txt", displayPath: "file.txt", originalContent: "old", modifiedContent: "new" });

/** 确定性定时器：测试决定何时 tick，并能观察到 stop 清掉的句柄。 */
function fakeTimer() {
	const timers = [];
	const cleared = [];
	return {
		timers,
		cleared,
		set(callback, intervalMs) {
			timers.push({ callback, intervalMs });
			return timers.length - 1;
		},
		clear(handle) {
			cleared.push(handle);
		},
		tick() {
			timers[timers.length - 1].callback();
		},
	};
}

function poller(poll) {
	const timer = fakeTimer();
	const gates = { pageVisible: true, hostReady: true, mutating: false, loading: false, diffLoading: false };
	const calls = [];
	const stop = startRemoteGitStatusPolling({
		isEnabled: () => remoteGitStatusPollingEnabled(gates),
		poll: () => {
			calls.push(calls.length + 1);
			return poll ? poll() : Promise.resolve();
		},
		timer,
	});
	return { timer, gates, calls, stop };
}

function fixture(api = {}) {
	const states = [];
	const reads = createRemoteGitViewController(
		projectId,
		"identity",
		{
			cancelRemoteReads: async () => {},
			remoteSnapshot: async () => ({ ok: true, snapshot: baseSnapshot }),
			workspaceFileDiff: async () => diffFor(),
			remoteLog: async () => ({ ok: true, page: { commits: [historyRow(oid("1"), "first")], hasMore: false } }),
			remoteRefs: async () => ({ ok: true, refs: { head: oid("1"), branch: "main", refs: [] } }),
			remoteCommitDetail: async (_id, value) => ({ ok: true, detail: detailFor(value) }),
			...api,
		},
		(state) => states.push(state),
	);
	return { reads, states, current: () => states.at(-1) };
}

test("轮询节奏固定 5 秒；闸门逐项可判定（隐藏/离线/变更中/读中都不跑）", () => {
	assert.equal(REMOTE_GIT_STATUS_POLL_INTERVAL_MS, 5_000);
	const open = { pageVisible: true, hostReady: true, mutating: false, loading: false, diffLoading: false };
	assert.equal(remoteGitStatusPollingEnabled(open), true);
	assert.equal(remoteGitStatusPollingEnabled({ ...open, pageVisible: false }), false, "document 隐藏时不轮询");
	assert.equal(remoteGitStatusPollingEnabled({ ...open, hostReady: false }), false, "host 非 ready 时不轮询");
	assert.equal(remoteGitStatusPollingEnabled({ ...open, mutating: true }), false, "变更中不轮询");
	assert.equal(remoteGitStatusPollingEnabled({ ...open, loading: true }), false, "正在读 facts 时不叠加");
	assert.equal(remoteGitStatusPollingEnabled({ ...open, diffLoading: true }), false, "diff 在途时不轮询");
	assert.equal(poller().timer.timers[0].intervalMs, 5_000, "定时器按 5 秒注册");
});

test("可见且 ready 时触发；闸门关闭的 tick 不发起读", async () => {
	const f = poller();
	f.timer.tick();
	await flush();
	assert.equal(f.calls.length, 1);
	f.gates.pageVisible = false;
	f.timer.tick();
	await flush();
	assert.equal(f.calls.length, 1, "隐藏窗口的 tick 不得发起读");
	f.gates.pageVisible = true;
	f.gates.hostReady = false;
	f.timer.tick();
	await flush();
	assert.equal(f.calls.length, 1, "离线时不发起读");
	f.gates.hostReady = true;
	f.gates.mutating = true;
	f.timer.tick();
	await flush();
	assert.equal(f.calls.length, 1, "变更中不发起读");
	f.gates.mutating = false;
	f.gates.diffLoading = true;
	f.timer.tick();
	await flush();
	assert.equal(f.calls.length, 1, "diff 在途时不发起读");
	f.gates.diffLoading = false;
	f.timer.tick();
	await flush();
	assert.equal(f.calls.length, 2);
	f.stop();
});

test("单飞：上一次未结束不叠加；停止后不再触发", async () => {
	let resolve;
	const pending = new Promise((accept) => {
		resolve = accept;
	});
	const f = poller(() => pending);
	f.timer.tick();
	f.timer.tick();
	f.timer.tick();
	assert.equal(f.calls.length, 1, "在途 tick 不得叠加");
	resolve();
	await flush();
	f.timer.tick();
	assert.equal(f.calls.length, 2, "上一次结束后下一个 tick 才发起");
	f.stop();
	assert.deepEqual(f.timer.cleared, [0], "停止会清掉定时器");
	f.timer.tick();
	await flush();
	assert.equal(f.calls.length, 2, "停止（隐藏/卸载）后不再触发");
});

test("静默刷新只换 snapshot/errorCode：不置 loading、不清 diff/history/refs/选中行", async () => {
	let branch = "main";
	const fetches = [];
	const f = fixture({
		remoteSnapshot: async () => ({ ok: true, snapshot: { ...baseSnapshot, branch } }),
		fetchRemote: async (...args) => {
			fetches.push(args);
			return { ok: true, outcome: { upToDate: true, updated: [] } };
		},
	});
	await f.reads.refresh();
	await f.reads.loadHistory();
	await f.reads.loadRefs();
	await f.reads.openCommitDetail(oid("1"));
	await f.reads.openDiff("index", target);
	const before = f.current();
	assert.ok(before.history && before.refs && before.detail && before.diff, "前提：面板已打开各分区");

	branch = "feature";
	await f.reads.refreshStatus();
	const after = f.current();
	assert.equal(after.snapshot.branch, "feature", "新 status 必须落地（外部 commit/checkout 可见）");
	assert.equal(after.loading, false, "静默刷新不置 loading");
	assert.equal(after.diffLoading, false);
	assert.deepEqual(plain(after.history), plain(before.history), "history 不清空");
	assert.deepEqual(plain(after.refs), plain(before.refs), "refs 不清空");
	assert.equal(after.detailOid, oid("1"), "选中行保留");
	assert.deepEqual(plain(after.diff), plain(before.diff), "打开的 diff 保留");
	assert.deepEqual(fetches, [], "轮询绝不 fetch");
});

test("静默刷新单飞：在途时不叠加请求", async () => {
	let resolveFirst;
	let calls = 0;
	const f = fixture({
		remoteSnapshot: async () => {
			calls += 1;
			if (calls === 1)
				return await new Promise((accept) => {
					resolveFirst = accept;
				});
			return { ok: true, snapshot: baseSnapshot };
		},
	});
	const first = f.reads.refreshStatus();
	await f.reads.refreshStatus();
	assert.equal(calls, 1, "一次只发一个 status 请求");
	resolveFirst({ ok: true, snapshot: baseSnapshot });
	await first;
	await f.reads.refreshStatus();
	assert.equal(calls, 2, "结束后才允许下一次");
});

test("静默刷新失败只报稳定码，不抹掉现有事实；成功会解除错误码", async () => {
	let result = { ok: true, snapshot: baseSnapshot };
	const f = fixture({ remoteSnapshot: async () => result });
	await f.reads.refresh();
	const facts = f.current().snapshot;
	result = { ok: false, code: "SSH_HOST_DISCONNECTED" };
	await f.reads.refreshStatus();
	assert.equal(f.current().errorCode, "SSH_HOST_DISCONNECTED");
	assert.deepEqual(plain(f.current().snapshot), plain(facts), "失败不把面板清空");
	result = { ok: true, snapshot: { ...baseSnapshot, branch: "next" } };
	await f.reads.refreshStatus();
	assert.equal(f.current().errorCode, undefined, "一次新事实解除错误码");
	assert.equal(f.current().snapshot.branch, "next");
});

test("连接失效后暂停自动轮询：多次 tick 不读，直到一次成功的显式刷新", async () => {
	let result = { ok: true, snapshot: baseSnapshot };
	let reads = 0;
	const f = fixture({
		remoteSnapshot: async () => {
			reads += 1;
			return result;
		},
	});
	const timer = fakeTimer();
	const gates = { pageVisible: true, hostReady: true, mutating: false, loading: false, diffLoading: false };
	const stop = startRemoteGitStatusPolling({ isEnabled: () => remoteGitStatusPollingEnabled(gates), poll: () => f.reads.refreshStatus(), timer });
	await f.reads.refresh();
	assert.equal(reads, 1);

	// 断开：显式重连本身绝不重放一次读（host 重新 ready 后的 tick 也不能读）。
	f.reads.invalidateConnection();
	for (let tick = 0; tick < 3; tick += 1) {
		timer.tick();
		await flush();
	}
	assert.equal(reads, 1, "断开之后自动轮询不得再读");

	// 失败的显式刷新不解除暂停：语义是「直到一次成功的显式刷新才恢复」。
	result = { ok: false, code: "SSH_HOST_DISCONNECTED" };
	await f.reads.refresh();
	assert.equal(reads, 2);
	timer.tick();
	await flush();
	assert.equal(reads, 2, "失败的显式刷新不解除暂停");

	// 成功的显式刷新解除暂停，下一个 tick 恢复读。
	result = { ok: true, snapshot: { ...baseSnapshot, branch: "feature" } };
	await f.reads.refresh();
	assert.equal(reads, 3);
	timer.tick();
	await flush();
	assert.equal(reads, 4, "成功刷新后轮询恢复");
	assert.equal(f.current().snapshot.branch, "feature");
	stop();
});

test("停止轮询后，迟到的静默结果不再发布", async () => {
	let resolve;
	const f = fixture({
		remoteSnapshot: async () =>
			await new Promise((accept) => {
				resolve = accept;
			}),
	});
	const pending = f.reads.refreshStatus();
	f.reads.stopStatusPolling();
	resolve({ ok: true, snapshot: { ...baseSnapshot, branch: "late" } });
	await pending;
	assert.equal(f.current(), undefined, "被停止的 tick 不得发布任何状态");
});
