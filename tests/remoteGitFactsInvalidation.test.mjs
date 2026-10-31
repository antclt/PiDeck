import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * P0-2：文件写成功后 Git 面板必须失效。
 *
 * 文件写走的是 `remoteProjectIpc.afterWrite`（目录域），Git 快照事实缓存不知道这件事，
 * 于是面板继续显示旧状态，直到用户点一次强制刷新。这里钉住新出口：
 * - `registerRemoteGitReadIpc` 返回 `invalidateProject(projectId)`：失效该项目**全部已缓存仓库**；
 * - 逐仓发布 `{kind:"status", repoPath}`，活跃面板按自己的 repoPath 精确匹配后重读；
 * - 无缓存仓库时不发通知（不制造空事件），也不碰别的项目。
 */
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const { createSnapshotFactsCache } = loadTsCommonJs("src/main/git/RemoteGitSnapshotFacts.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const PROJECT = "remote-project";
const OTHER = "remote-project-2";
const HOST = "remote-host";
const oid = (char) => char.repeat(40);

function fixture() {
	const handlers = new Map();
	const published = [];
	const calls = [];
	const { registerRemoteGitReadIpc } = loadTsCommonJs("src/main/ipc/remoteGitReadIpc.ts", { stubs: { electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } } } });
	const sender = new EventEmitter();
	sender.id = 1;
	sender.isDestroyed = () => false;
	const session = {
		request: async (method, params, options) => {
			calls.push({ method, ...(options?.repo === undefined ? {} : { repo: options.repo }) });
			options?.onRequestId?.("request-id");
			if (method === "hello") return { protocolVersion: 1, root: "/workspace/project", capabilities: ["git.status"] };
			if (method === "git.status") return { status: Buffer.from("").toString("base64"), head: oid("a"), branch: "main" };
			throw new Error("UNEXPECTED_METHOD");
		},
		cancel: async () => undefined,
	};
	const port = registerRemoteGitReadIpc({
		enabled: true,
		locator: (id) => ([PROJECT, OTHER].includes(id) ? { kind: "ssh", hostId: HOST, remotePath: "/workspace/project" } : undefined),
		trusted: async () => true,
		service: async () => ({
			connectionFacts: () => ({ connectionId: "conn-1", state: "ready" }),
			withProjectSession: async (_hostId, _root, work) => ({ ok: true, value: await work(session) }),
		}),
		factsEvents: { publish: (change) => published.push(change) },
	});
	const snapshot = async (projectId = PROJECT, repo) => {
		const result = await handlers.get(ipcChannels.gitRemoteSnapshot)({ sender }, projectId, repo);
		assert.equal(result.ok, true, "snapshot must succeed: " + JSON.stringify(result));
		return result;
	};
	const statusCalls = () => calls.filter((call) => call.method === "git.status").length;
	return { port, published, calls, snapshot, statusCalls };
}

test("文件写后：status 事实被标脏，下一次读重新装载（不主动装载）", async () => {
	const f = fixture();
	await f.snapshot(PROJECT);
	assert.equal(f.statusCalls(), 1);
	f.port.invalidateProject(PROJECT);
	await tick();
	assert.equal(f.statusCalls(), 1, "失效只标脏，不读远端");
	assert.equal(f.published.length, 1, "活跃面板需要一次 status 通知");
	assert.equal(f.published[0].projectId, PROJECT);
	assert.deepEqual(plain(f.published[0].scopes), [{ kind: "status", repoPath: "" }]);
	await f.snapshot(PROJECT);
	assert.equal(f.statusCalls(), 2, "下一次读才付往返");
});

test("多个仓库：逐仓失效并逐仓通知（每个 repoPath 一次）", async () => {
	const f = fixture();
	await f.snapshot(PROJECT, "packages/a");
	await f.snapshot(PROJECT);
	assert.equal(f.statusCalls(), 2);
	f.port.invalidateProject(PROJECT);
	await tick();
	assert.equal(f.published.length, 2, "两个仓库各一条通知");
	const repoPaths = f.published.map((change) => plain(change.scopes)[0].repoPath).sort();
	assert.deepEqual(repoPaths, ["", "packages/a"]);
	assert.ok(
		f.published.every((change) => plain(change.scopes).every((scope) => scope.kind === "status")),
		"文件写只影响 status，不冒充 tree",
	);
	await f.snapshot(PROJECT, "packages/a");
	await f.snapshot(PROJECT);
	assert.equal(f.statusCalls(), 4, "两个仓库都重新装载");
});

test("无缓存仓库：不发通知、不装载（不制造空事件）", async () => {
	const f = fixture();
	f.port.invalidateProject(PROJECT);
	await tick();
	assert.deepEqual(f.published, []);
	assert.equal(f.calls.length, 0);
});

test("只失效该项目：别的项目的暖事实仍然命中", async () => {
	const f = fixture();
	await f.snapshot(OTHER);
	assert.equal(f.statusCalls(), 1);
	f.port.invalidateProject(PROJECT);
	await tick();
	assert.deepEqual(f.published, [], "没有缓存的项目不发通知");
	await f.snapshot(OTHER);
	assert.equal(f.statusCalls(), 1, "别的项目不受影响");
});

test("reposOf 只报有缓存值的仓库；只有占位标脏的键不算仓库", async () => {
	const cache = createSnapshotFactsCache();
	assert.deepEqual(plain(cache.reposOf("p1")), []);
	await cache.read("p1", "", async () => "root");
	await cache.read("p1", "packages/a", async () => "nested");
	await cache.read("p2", "", async () => "other-project");
	assert.deepEqual(plain(cache.reposOf("p1")).sort(), ["", "packages/a"]);
	assert.deepEqual(plain(cache.reposOf("p2")), [""]);
	// invalidate 会给「没有现值」的键建占位：它不是已缓存事实，不该被当成仓库通知出去。
	cache.invalidate("p1", "ghost");
	assert.deepEqual(plain(cache.reposOf("p1")).sort(), ["", "packages/a"]);
	cache.clear();
	assert.deepEqual(plain(cache.reposOf("p1")), []);
});
