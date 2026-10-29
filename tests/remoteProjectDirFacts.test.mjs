import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * W3 接线的验收点（计划 §3「事实层」）：**同一个目录在一次内容变化里只装载一次**。
 *
 * 用法与 remoteHostIpc.test.mjs 同一套：真的加载 `remoteProjectIpc`，只把 reader 换成会记账的假端口。
 * 断言的是行为（reader 被调用几次），不是实现细节——所以搬文件、改内部结构都不会让这组用例失真。
 */
const HOST_ID = "6f1b7c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const PROJECT = "project-remote-1";

function harness(options = {}) {
	const calls = { list: [], watches: [] };
	const handlers = new Map();
	const { registerRemoteProjectIpc } = loadTsCommonJs("src/main/ipc/remoteProjectIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
			"../remote/RemoteBrowseRoot": { async resolveRemoteBrowseRoot() { return { canonicalPath: "/srv/app" }; } },
			"../remote/RemoteSearchReader": {
				REMOTE_SEARCH_READER_CODES: { queryInvalid: "QUERY_INVALID", requestFailed: "REMOTE_WORKSPACE_REQUEST_FAILED", optionsInvalid: "REMOTE_WORKSPACE_READER_OPTIONS_INVALID" },
				createRemoteSearchReader: () => ({ async search() { return { entries: [], scanned: 0, truncated: false }; } }),
			},
			"../remote/RemoteWorkspaceReader": {
				createRemoteWorkspaceReader: () => ({
					async list(_hostId, path) {
						calls.list.push(path);
						if (options.listFails) throw new Error("REMOTE_PROJECT_READ_FAILED");
						return { entries: options.entries ?? [{ name: "src", kind: "directory" }] };
					},
					async readFile() {
						return { content: Buffer.from("x"), bytes: 1, mtimeMs: 1 };
					},
				}),
			},
		},
	});
	let issuedWatchId = "w-unset";
	const facts = registerRemoteProjectIpc({
		enabled: true,
		userDataDir: "/tmp/unused",
		service: async () => ({
			withProjectSession: async (_hostId, _root, task) => ({
				ok: true,
				value: await task({
					// fs.watch 走同一条 request 通道：这里回答一个稳定的 watchId，其余方法不该被调用。
					request: async (method, params) => {
						if (method === "fs.watch") {
							calls.watches.push(JSON.parse(JSON.stringify(params)));
							return { watchId: issuedWatchId };
						}
						throw new Error("UNEXPECTED_METHOD");
					},
					cancel: async () => undefined,
				}),
			}),
		}),
		projects: {
			enroll: async () => ({ projectId: PROJECT }),
			locator: (projectId) => (projectId === PROJECT ? { kind: "ssh", hostId: HOST_ID, remotePath: "/srv/app" } : undefined),
		},
	});
	const list = (path) => handlers.get("remote:project-list")({}, PROJECT, path);
	const plain = (value) => JSON.parse(JSON.stringify(value));
	return { calls, list, facts, plain, watchId: (value) => { issuedWatchId = value; } };
}

test("同一个目录读两次：只装载一次，两次拿到同一个 revision", async () => {
	const h = harness();
	const first = await h.list("");
	const second = await h.list("");
	assert.equal(h.calls.list.length, 1, "第二次读必须命中事实，不再打一次远端");
	assert.equal(first.value.revision, second.value.revision);
	assert.deepEqual(h.plain(first.value.entries), h.plain(second.value.entries));
	assert.equal(h.facts.dirLoads(), 1);
});

test("不同目录各装载一次：事实按 (项目, 路径) 分开", async () => {
	const h = harness();
	await h.list("");
	await h.list("src");
	assert.deepEqual(h.calls.list, [".", "src"]);
	assert.equal(h.facts.dirLoads(), 2);
});

test("写后标脏：下一次读重新装载，revision 前进；标脏本身不产生往返", async () => {
	const h = harness();
	const before = await h.list("src");
	assert.equal(h.calls.list.length, 1);

	// 写 "src/a.ts"：只标脏 src 与它的父目录（根层），此时一条远端请求都不该发出。
	h.facts.afterWrite(PROJECT, ["src/a.ts"]);
	assert.equal(h.calls.list.length, 1, "失效只标脏，不装载");

	const after = await h.list("src");
	assert.equal(h.calls.list.length, 2, "下一次读才付那次往返");
	assert.ok(after.value.revision > before.value.revision, "值被替换后 revision 必须变");
	assert.equal(h.facts.dirLoads(), 2);
});

test("写后未受影响的目录仍是命中（失效矩阵不漏也不多）", async () => {
	const h = harness();
	await h.list("assets");
	await h.list("src");
	assert.equal(h.calls.list.length, 2);
	h.facts.afterWrite(PROJECT, ["src/a.ts"]);
	await h.list("assets");
	assert.equal(h.calls.list.length, 2, "assets 不在失效范围内，不该重新装载");
});

test("装载失败如实返回稳定码与 outcome，不缓存成空目录", async () => {
	const h = harness({ listFails: true });
	const failed = await h.list("");
	assert.equal(failed.ok, false);
	assert.equal(failed.code, "REMOTE_PROJECT_READ_FAILED");
	assert.equal(failed.outcome, "rejected");
	// 失败不被当成事实：下一次读取会真的重试。
	await h.list("");
	assert.equal(h.calls.list.length, 2);
});

test("helper 变更事件只标脏对应目录（事件 → 失效接线）", async () => {
	const h = harness();
	// 根目录装载成功时订阅一次，helper 回一个 watchId；事件回来时按这个 id 找项目。
	h.watchId("w1-req-1");
	const before = await h.list("");
	assert.equal(h.calls.list.length, 1);
	assert.deepEqual(h.calls.watches, [{ paths: [""] }], "根目录第一次读到就订阅（非递归，覆盖根层与 .git 变化）");

	h.facts.onHelperEvent({ hostId: HOST_ID, watchId: "w1-req-1", paths: [""] });
	assert.equal(h.calls.list.length, 1, "事件不装载，只标脏");

	const after = await h.list("");
	assert.equal(h.calls.list.length, 2, "下一次读才付往返");
	assert.ok(after.value.revision > before.value.revision);
});

test("未注册的 watchId、别的 host、别的路径都不影响事实", async () => {
	const h = harness();
	h.watchId("w1-req-1");
	await h.list("src");
	assert.equal(h.calls.list.length, 1);
	assert.deepEqual(h.calls.watches, [], "非根目录不订阅");
	h.facts.onHelperEvent({ hostId: HOST_ID, watchId: "nope", paths: ["src"] });
	h.facts.onHelperEvent({ hostId: "ffffffff-ffff-4fff-8fff-ffffffffffff", watchId: "w1-req-1", paths: ["src"] });
	await h.list("src");
	assert.equal(h.calls.list.length, 1, "只认登记过的 (host, watchId, 路径)");
});
