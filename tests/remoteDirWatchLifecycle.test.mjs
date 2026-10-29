import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createDirWatchRegistry, DIR_WATCH_LIMITS, dirKeysAfterWrite } = loadTsCommonJs("src/main/remote/RemoteDirWatchRegistry.ts");

const HOST = "11111111-1111-4111-8111-111111111111";
const PROJECT = "project-remote-1";
const PROJECT_2 = "project-remote-2";

const plain = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
	let resolve;
	const promise = new Promise((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/**
 * T2（v5 §10.3）：目录订阅的身份必须来自真实 helper 生命周期，而不是每次读新建的 session 包装对象。
 *
 * 旧实现的洞（F6）：`ensure(host, session, ...)` 把包装对象本身当会话身份。`establishProjectSession`
 * 每次读都返回新对象，于是同一 helper 的根目录重读被当成「换了会话」，反复 `fs.watch`；helper 只有
 * 4 个 watcher，第 5 次申请被拒后登记表已被清，后续事件全部失效。
 *
 * 这里同时钉登记表本身（身份换代/并发合并/迟到订阅/拒绝超限/成对退订）和生产接线
 * （新包装、同 connectionId 只订阅一次；换 connectionId 才换订阅）。
 */
test("同 key 并发 ensure 只发一次订阅；路径去重后不重复订阅", async () => {
	const registry = createDirWatchRegistry();
	const gate = deferred();
	let subscriptions = 0;
	const subscribe = async () => {
		subscriptions += 1;
		return await gate.promise;
	};
	const first = registry.ensure(HOST, "conn-1", PROJECT, subscribe);
	const second = registry.ensure(HOST, "conn-1", PROJECT, subscribe);
	assert.equal(subscriptions, 1, "同 (连接, 项目) 的并发 ensure 必须合并成一次请求");
	gate.resolve("w1");
	await Promise.all([first, second]);
	await registry.ensure(HOST, "conn-1", PROJECT, subscribe);
	assert.equal(subscriptions, 1, "已登记的项目不重复订阅");
	assert.deepEqual(plain(registry.scopesForEvent(HOST, "w1")), [{ projectId: PROJECT, paths: [""] }]);
});

test("换代：旧 watchId 立刻失效并在新代重新订阅；旧代迟到的订阅不得登记", async () => {
	const registry = createDirWatchRegistry();
	const gate = deferred();
	await registry.ensure(HOST, "conn-1", PROJECT, async () => "w1");

	// 旧代发起、换代后才完成的订阅：结果必须丢弃，不能出现在新代登记里。
	const late = registry.ensure(HOST, "conn-1", PROJECT_2, async () => await gate.promise);
	await registry.ensure(HOST, "conn-2", PROJECT, async () => "w2");
	gate.resolve("w-late");
	await late;

	assert.deepEqual(plain(registry.scopesForEvent(HOST, "w2")), [{ projectId: PROJECT, paths: [""] }]);
	assert.equal(registry.scopesForEvent(HOST, "w1"), undefined, "旧 helper 的 watcher 已死");
	assert.equal(registry.scopesForEvent(HOST, "w-late"), undefined, "迟到的旧代订阅不得登记到新代");
	assert.equal(registry.sizeOf(HOST), 1);
});

test("清理不跨代：旧代的 releaseHost 不得关闭新代的 watcher", async () => {
	const registry = createDirWatchRegistry();
	const unwatched = [];
	const unwatch = async (watchId) => {
		unwatched.push(watchId);
	};
	await registry.ensure(HOST, "conn-1", PROJECT, async () => "w1", { unwatch });
	await registry.ensure(HOST, "conn-2", PROJECT, async () => "w2", { unwatch });

	await registry.releaseHost(HOST, "conn-1");
	assert.deepEqual(unwatched, [], "旧代早已随会话死亡，不能再去关闭新代的 watcher");
	assert.deepEqual(plain(registry.scopesForEvent(HOST, "w2")), [{ projectId: PROJECT, paths: [""] }]);

	await registry.releaseHost(HOST, "conn-2");
	assert.deepEqual(unwatched, ["w2"], "当前代释放时要成对退订");
	assert.equal(registry.sizeOf(HOST), 0);
});

test("releaseProject / closeProject 只退订对应项目；clearHost 丢弃但不发退订", async () => {
	const registry = createDirWatchRegistry();
	const unwatched = [];
	const unwatch = async (watchId) => {
		unwatched.push(watchId);
	};
	await registry.ensure(HOST, "conn-1", PROJECT, async () => "w1", { unwatch });
	await registry.ensure(HOST, "conn-1", PROJECT_2, async () => "w2", { unwatch });

	await registry.releaseProject(HOST, PROJECT);
	assert.deepEqual(unwatched, ["w1"]);
	assert.equal(registry.scopesForEvent(HOST, "w1"), undefined);
	assert.deepEqual(plain(registry.scopesForEvent(HOST, "w2")), [{ projectId: PROJECT_2, paths: [""] }]);

	registry.clearHost(HOST);
	assert.equal(registry.sizeOf(HOST), 0, "断连后登记直接丢弃");
	assert.deepEqual(unwatched, ["w1"], "helper 已死时不再发退订");
});

test("超限拒绝而不是排队：最多 4 个 watcher，每个最多 32 条路径（33 条拆成两个）", async () => {
	const registry = createDirWatchRegistry();
	const requests = [];
	let seq = 0;
	const subscribe = async (paths) => {
		seq += 1;
		requests.push([...paths]);
		return `w${seq}`;
	};
	const paths = Array.from({ length: 33 }, (_, index) => `dir${index}`);
	await registry.ensure(HOST, "conn-1", PROJECT, subscribe, { paths: ["root", ...paths] });
	assert.equal(requests.length, 2, "34 条路径 = 32 + 2，两次请求，每次都不超 32");
	assert.equal(requests[0].length, DIR_WATCH_LIMITS.pathsPerWatcher);
	assert.equal(requests[1].length, 2);

	// 到上限后再要新的项目：不发请求、不登记（订阅是降级能力，不能假装成功）。
	for (let index = 0; index < 4; index += 1) await registry.ensure(HOST, "conn-1", `extra-${index}`, subscribe);
	assert.equal(registry.sizeOf(HOST), DIR_WATCH_LIMITS.watchersPerHost);
	const before = requests.length;
	await registry.ensure(HOST, "conn-1", "one-more", subscribe);
	assert.equal(requests.length, before, "第 5 个 watcher 必须是拒绝，不是排队");
	assert.equal(registry.sizeOf(HOST), DIR_WATCH_LIMITS.watchersPerHost);
});

test("dirKeysAfterWrite 仍用项目与目录的真实键（NUL 分隔），不退回空格", () => {
	const key = (path) => `${PROJECT}${String.fromCharCode(0)}${path}`;
	assert.deepEqual(plain(dirKeysAfterWrite(PROJECT, ["src/a.ts"])).sort(), [key(""), key("src")].sort());
});

/* ---------------------------------------------------------------- 生产接线 */

function ipcHarness() {
	const calls = { list: [], watches: [], unwatches: [] };
	const handlers = new Map();
	const state = { connectionId: "conn-1", seq: 0, watchFails: false, watchGate: undefined };
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
				// 真实服务每次读都返回一个新的 session 包装；身份只由 connectionId 表达。
				value: await task({
					connectionId: state.connectionId,
					request: async (method, params) => {
						if (method === "fs.watch") {
							calls.watches.push({ paths: [...params.paths], connectionId: state.connectionId });
							if (state.watchFails) throw new Error("REMOTE_WORKSPACE_UNSUPPORTED");
							if (state.watchGate !== undefined) await state.watchGate.promise;
							state.seq += 1;
							return { watchId: `w${state.seq}` };
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

	const list = (projectId, path) => handlers.get("remote:project-list")({}, projectId, path);
	return { calls, state, facts, list };
}

test("同 connectionId 的新 session 包装只订阅一次（F6：不再被 4 watcher 上限打成失效）", async () => {
	const h = ipcHarness();
	await h.list(PROJECT, "");
	assert.equal(h.calls.watches.length, 1, "根目录第一次读到就订阅");
	assert.deepEqual(h.calls.watches[0].paths, [""]);

	// 每次重读都是一个新包装对象：这正是旧实现误判为“换了会话”的地方。
	for (let index = 0; index < 4; index += 1) {
		h.facts.afterWrite(PROJECT, ["src/a.ts"]);
		await h.list(PROJECT, "");
	}
	assert.equal(h.calls.list.length, 5);
	assert.equal(h.calls.watches.length, 1, "同一 helper 会话只允许一个 watcher，不能被包装对象骗出 5 个");
});

test("换 connectionId 才重新订阅；旧 watchId 的事件不再影响事实", async () => {
	const h = ipcHarness();
	await h.list(PROJECT, "");
	assert.equal(h.calls.watches.length, 1);

	h.state.connectionId = "conn-2";
	h.facts.afterWrite(PROJECT, ["src/a.ts"]);
	await h.list(PROJECT, "");
	assert.equal(h.calls.watches.length, 2, "重连/换代后要在新 helper 上重新订阅");

	const listCalls = h.calls.list.length;
	h.facts.onHelperEvent({ hostId: HOST, watchId: "w1", paths: [""] });
	await h.list(PROJECT, "");
	assert.equal(h.calls.list.length, listCalls, "旧代的 watchId 必须被忽略，不能标脏新代事实");

	h.facts.onHelperEvent({ hostId: HOST, watchId: "w2", paths: [""] });
	await h.list(PROJECT, "");
	assert.equal(h.calls.list.length, listCalls + 1, "新代事件只标脏，下一次读才装载");
});

test("dispose 成对退订；onHostDisconnected 丢弃登记且不发退订", async () => {
	const h = ipcHarness();
	await h.list(PROJECT, "");
	await h.facts.dispose();
	assert.deepEqual(h.calls.unwatches, ["w1"], "进程退出前退订已登记的 watcher");

	const second = ipcHarness();
	await second.list(PROJECT, "");
	second.facts.onHostDisconnected(HOST);
	assert.deepEqual(second.calls.unwatches, [], "helper 已死时不能把退订发给新会话");
	second.facts.afterWrite(PROJECT, ["src/a.ts"]);
	await second.list(PROJECT, "");
	assert.equal(second.calls.watches.length, 2, "断连后下一次读重新订阅");
});

test("closeProject 只退订该项目；订阅失败不把目录读取变成失败", async () => {
	const h = ipcHarness();
	await h.list(PROJECT, "");
	await h.list(PROJECT_2, "");
	const [first, second] = h.calls.watches.map((watch) => watch.connectionId);
	assert.equal(first, second);
	await h.facts.closeProject(PROJECT);
	assert.deepEqual(h.calls.unwatches, ["w1"]);
	assert.equal(h.facts.dirLoads(), 2);

	const failing = ipcHarness();
	failing.state.watchFails = true;
	const listed = await failing.list(PROJECT, "");
	assert.equal(listed.ok, true, "订阅不是读的前置条件：helper 不支持 watch 时列表仍然成功");
	assert.equal(failing.calls.watches.length, 1, "订阅请求发过一次");
	assert.deepEqual(failing.calls.unwatches, [], "没有 watchId 就不登记、也不退订");
});
