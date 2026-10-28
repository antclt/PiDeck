import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteWorkspaceView, parentDirOf } = loadTsCommonJs("src/main/remote/RemoteWorkspaceView.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));

function harness(listDirImpl) {
	const calls = { dirs: [], repos: [], status: [] };
	const view = createRemoteWorkspaceView({
		listDir: async (projectId, path) => {
			calls.dirs.push(`${projectId}|${path}`);
			return listDirImpl === undefined ? { ok: true, value: { path, entries: [] } } : await listDirImpl(projectId, path);
		},
		listRepos: async (projectId) => {
			calls.repos.push(projectId);
			return { ok: true, value: { repos: ["/repo"] } };
		},
		status: async (projectId, repoPath) => {
			calls.status.push(`${projectId}|${repoPath}`);
			return { ok: true, value: { repoPath, changed: [] } };
		},
	});
	return { calls, view };
}

/**
 * 事实层（v5 §3）要回答的是「一次内容变化到底问远端几次」。
 * 这里钉三件事：同一个事实只有一个装载、失效矩阵不漏不多、失败不产生假值。
 */
test("同一个事实只装载一次：树和面板读到的是同一个 revision", async () => {
	const { calls, view } = harness();
	const tree = await view.dir("p1", "src");
	const panel = await view.dir("p1", "src");
	assert.deepEqual(calls.dirs, ["p1|src"]);
	assert.equal(panel.revision, tree.revision);
	assert.equal(view.stats().loads, 1);
	assert.equal(view.stats().hits, 1);
});

test("写后失效矩阵：所在目录 + 祖父目录 + 该仓库状态 + 仓库列表，各一次装载", async () => {
	const { calls, view } = harness();
	await view.dir("p1", "src");
	await view.dir("p1", "");
	await view.status("p1", "/repo");
	await view.repos("p1");
	calls.dirs.length = 0;
	calls.repos.length = 0;
	calls.status.length = 0;

	view.afterWrite("p1", { paths: ["src/a.ts"], repoPath: "/repo" });

	// 失效只标脏：写本身不产生任何往返。
	assert.deepEqual(calls, { dirs: [], repos: [], status: [] });

	await view.dir("p1", "src");
	await view.dir("p1", "");
	await view.status("p1", "/repo");
	await view.repos("p1");
	assert.deepEqual(calls.dirs.sort(), ["p1|", "p1|src"]);
	assert.deepEqual(calls.status, ["p1|/repo"]);
	assert.deepEqual(calls.repos, ["p1"]);

	// 再读一遍不应该再问远端（合并/命中的意义就在这里）。
	calls.dirs.length = 0;
	calls.repos.length = 0;
	calls.status.length = 0;
	await view.dir("p1", "src");
	await view.dir("p1", "");
	await view.status("p1", "/repo");
	await view.repos("p1");
	assert.deepEqual(calls, { dirs: [], repos: [], status: [] });
});

test("一次内容变化的往返总量 = 事实个数（不重复、不广播）", async () => {
	const { view } = harness();
	view.afterWrite("p1", { paths: ["src/a.ts", "src/b.ts"], repoPath: "/repo" });
	const before = view.stats().loads;
	await Promise.all([view.repos("p1"), view.dir("p1", "src"), view.dir("p1", ""), view.status("p1", "/repo")]);
	assert.equal(view.stats().loads - before, 4, "4 个不同事实 = 4 次装载；同一目录下的两个文件不额外计费");
});

test("项目隔离：clearProject 只丢自己那份事实", async () => {
	const { calls, view } = harness();
	await view.dir("p1", "src");
	await view.dir("p2", "src");
	calls.dirs.length = 0;
	view.clearProject("p1");
	await view.dir("p2", "src");
	assert.deepEqual(calls.dirs, [], "p2 的事实不受 p1 关闭影响");
	await view.dir("p1", "src");
	assert.deepEqual(calls.dirs, ["p1|src"], "p1 重新装载");
});

test("装载失败如实透传 outcome，不制造空事实", async () => {
	const { view } = harness(async () => ({ ok: false, code: "REMOTE_FILE_RESULT_UNCONFIRMED", outcome: "unknown" }));
	const failed = await view.dir("p1", "gone");
	assert.deepEqual(plain(failed), { ok: false, code: "REMOTE_FILE_RESULT_UNCONFIRMED", outcome: "unknown", revision: failed.revision });
	assert.equal(failed.ok, false);
	// 失败不被当成事实缓住：下一次读取会真的重试（不把「没拿到」伪装成稳定的空值）。
	const again = await view.dir("p1", "gone");
	assert.equal(again.ok, false);
	assert.equal(view.stats().loads, 2);
	assert.equal(view.stats().failures, 2);
});

test("parentDirOf 只做所在目录判定（不做路径规范化）", () => {
	assert.equal(parentDirOf("a/b/c.txt"), "a/b");
	assert.equal(parentDirOf("a.txt"), "");
	assert.equal(parentDirOf("src"), "");
	assert.equal(parentDirOf("./a"), ".");
});
