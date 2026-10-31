import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createLazyDirTreeController, lazyDirTreeInitialState } = loadTsCommonJs("src/renderer/src/utils/lazyDirTree.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function file(name) {
	return { name, path: name, relativePath: name, type: "file" };
}
function dir(name, hasChildren = true) {
	return { name, path: name, relativePath: name, type: "directory", hasChildren };
}
function page(nodes, { revision = 1, generation = "g1" } = {}) {
	return { ok: true, page: { nodes, revision, generation } };
}
function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function harness(responses = {}) {
	const calls = [];
	const pending = [];
	const loader = (dir, force) => {
		calls.push({ dir, force });
		if (Object.hasOwn(responses, dir)) {
			const value = responses[dir];
			return Promise.resolve(typeof value === "function" ? value(force) : value);
		}
		const request = deferred();
		pending.push({ dir, force, request });
		return request.promise;
	};
	return { loader, calls, pending };
}

test("迟到的旧目录结果不会盖掉新结果，加载集合按代次收敛", async () => {
	const testHarness = harness();
	const controller = createLazyDirTreeController(testHarness.loader);
	const root = controller.load("");
	testHarness.pending[0].request.resolve(page([dir("a"), file("b")]));
	assert.equal(await root, true);
	assert.deepEqual(
		controller.getState().nodes.map((node) => node.name),
		["a", "b"],
	);

	controller.toggle("a");
	const second = controller.load("a");
	const newest = testHarness.pending[2];
	newest.request.resolve(page([file("new")], { revision: 2 }));
	assert.equal(await second, true);
	testHarness.pending[1].request.resolve(page([file("old")], { revision: 1 }));
	await tick();

	const state = controller.getState();
	assert.deepEqual(
		state.nodes[0].children.map((node) => node.name),
		["new"],
	);
	assert.deepEqual([...state.loadingDirs], []);
});

test("读失败清空该层并保留稳定码；重试成功才恢复 listed", async () => {
	const controller = createLazyDirTreeController(async () => ({ ok: false, code: "SSH_HOST_DISCONNECTED" }));
	assert.equal(await controller.load(""), false);
	const state = controller.getState();
	assert.equal(state.listed, false);
	assert.equal(state.error, "SSH_HOST_DISCONNECTED");
	assert.equal(state.nodes.length, 0);

	const retry = createLazyDirTreeController(async () => page([file("a")]));
	assert.equal(await retry.load(""), true);
	const recovered = retry.getState();
	assert.equal(recovered.listed, true);
	assert.equal(recovered.error, null);
	assert.deepEqual(
		recovered.nodes.map((node) => node.name),
		["a"],
	);
});

test("展开只读一次；收起再展开不重复请求，加载中不并发重复", async () => {
	const testHarness = harness();
	const controller = createLazyDirTreeController(testHarness.loader);
	const root = controller.load("");
	testHarness.pending[0].request.resolve(page([dir("a")]));
	await root;

	controller.toggle("a");
	assert.equal(testHarness.calls.filter((call) => call.dir === "a").length, 1);
	controller.toggle("a"); // 收起
	controller.toggle("a"); // 再次展开，仍在途
	assert.equal(testHarness.calls.filter((call) => call.dir === "a").length, 1);
	testHarness.pending[1].request.resolve(page([file("x")]));
	await tick();
	controller.toggle("a"); // 收起
	controller.toggle("a"); // 已加载：不再读
	assert.equal(testHarness.calls.filter((call) => call.dir === "a").length, 1);
	assert.equal(controller.getState().currentDir, "a");
});

test("显式刷新只重读根层与已加载目录，并带 force", async () => {
	const testHarness = harness();
	const controller = createLazyDirTreeController(testHarness.loader);
	const root = controller.load("");
	testHarness.pending[0].request.resolve(page([dir("a"), dir("b")]));
	await root;
	controller.toggle("a");
	testHarness.pending[1].request.resolve(page([]));
	await tick();
	testHarness.calls.length = 0;
	testHarness.pending.length = 0;

	const refresh = controller.refresh();
	const refreshed = testHarness.pending.map((entry) => entry.dir).sort();
	assert.deepEqual(refreshed, ["", "a"]);
	assert.ok(testHarness.calls.every((call) => call.force === true));
	for (const request of testHarness.pending) request.request.resolve(page([]));
	await refresh;
});

test("reveal 逐层读取祖先并全部展开，当前目录切到目标", async () => {
	const testHarness = harness({
		"": page([dir("x")]),
		x: page([dir("y")]),
		"x/y": page([dir("z")]),
		"x/y/z": page([]),
	});
	const controller = createLazyDirTreeController(testHarness.loader);
	const root = controller.load("");
	await root;

	await controller.reveal("x/y/z");
	assert.deepEqual(
		testHarness.calls.map((call) => call.dir),
		["", "x", "x/y", "x/y/z"],
	);
	const state = controller.getState();
	assert.deepEqual([...state.expanded].sort(), ["x", "x/y", "x/y/z"]);
	assert.equal(state.currentDir, "x/y/z");
});

test("事实通知只重读已加载目录，未加载的 scope 不产生请求", async () => {
	const testHarness = harness();
	const controller = createLazyDirTreeController(testHarness.loader);
	const root = controller.load("");
	testHarness.pending[0].request.resolve(page([dir("a"), dir("b")]));
	await root;
	controller.toggle("a");
	testHarness.pending[1].request.resolve(page([]));
	await tick();
	testHarness.calls.length = 0;
	testHarness.pending.length = 0;

	controller.applyFactsChange({
		projectId: "p",
		generation: "g1",
		scopes: [
			{ kind: "dir", path: "a" },
			{ kind: "dir", path: "b" },
		],
	});
	assert.deepEqual(
		testHarness.calls.map((call) => [call.dir, call.force]),
		[["a", true]],
	);
	testHarness.pending[0].request.resolve(page([]));
});

test("连接换代丢弃旧树并重读根层与已加载目录", async () => {
	const testHarness = harness();
	const controller = createLazyDirTreeController(testHarness.loader);
	const root = controller.load("");
	testHarness.pending[0].request.resolve(page([dir("a")], { generation: "g1" }));
	await root;
	controller.toggle("a");
	testHarness.pending[1].request.resolve(page([file("x")], { generation: "g1" }));
	await tick();
	testHarness.calls.length = 0;
	testHarness.pending.length = 0;

	controller.applyFactsChange({ projectId: "p", generation: "g2", scopes: [] });
	assert.equal(controller.getState().nodes.length, 0);
	assert.deepEqual(testHarness.calls.map((call) => [call.dir, call.force]).sort(), [
		["", true],
		["a", true],
	]);
	for (const request of testHarness.pending) request.request.resolve(page([file("fresh")], { generation: "g2" }));
	await tick();
	assert.equal(controller.getState().listed, true);
});

test("dispose 之后迟到结果不再落地", async () => {
	const testHarness = harness();
	const controller = createLazyDirTreeController(testHarness.loader);
	const load = controller.load("");
	controller.dispose();
	testHarness.pending[0].request.resolve(page([file("a")]));
	assert.equal(await load, false);
	assert.equal(controller.getState().listed, false);
	assert.equal(controller.getState().nodes.length, 0);
	assert.deepEqual(plain(controller.getState()), plain(lazyDirTreeInitialState()));
});

test("截断标记随页面显式保存，重读不截断时清除", async () => {
	let truncated = true;
	const controller = createLazyDirTreeController(async () => ({ ok: true, page: { nodes: [file("a")], truncated } }));
	await controller.load("");
	assert.deepEqual([...controller.getState().truncatedDirs], [""]);
	truncated = false;
	await controller.load("", true);
	assert.deepEqual([...controller.getState().truncatedDirs], []);
});

test("加载态/错误的 publish 复用同一 nodes 引用，避免文件树内容代次空转", async () => {
	const testHarness = harness();
	const controller = createLazyDirTreeController(testHarness.loader);
	const before = controller.getState().nodes;
	const root = controller.load("");
	assert.equal(controller.getState().nodes, before, "loading 开始不应重建 nodes");
	testHarness.pending[0].request.resolve(page([file("a")]));
	await root;
	const after = controller.getState().nodes;
	assert.notEqual(after, before, "子项落地必须重建 nodes");
	controller.setCurrentDir("x");
	assert.equal(controller.getState().nodes, after, "currentDir 变化不应重建 nodes");
});

test("hydrate 先读根层，再按深度逐层读取并展开持久化目录", async () => {
	const testHarness = harness({
		"": page([dir("a")]),
		a: page([dir("a/b")]),
		"a/b": page([file("x")]),
	});
	const controller = createLazyDirTreeController(testHarness.loader);
	await controller.hydrate(["a/b", "a"]);
	assert.deepEqual(
		testHarness.calls.map((call) => call.dir),
		["", "a", "a/b"],
	);
	assert.deepEqual([...controller.getState().expanded].sort(), ["a", "a/b"]);
	assert.equal(controller.getState().nodes[0].children[0].children[0].name, "x");
});

test("loadMissing 只补读未加载目录；drill 沿单子目录链展开到链尾", async () => {
	const testHarness = harness({
		"": page([dir("a")]),
		a: page([dir("a/b")]),
		"a/b": page([dir("a/b/c")]),
		"a/b/c": page([file("leaf")]),
	});
	const controller = createLazyDirTreeController(testHarness.loader);
	await controller.load("");
	assert.equal(controller.hasLoaded("a"), false);
	assert.equal(await controller.loadMissing(["a", "a"]), true);
	assert.equal(controller.hasLoaded("a"), true);
	assert.equal(await controller.loadMissing(["a"]), false);

	await controller.drill("a", (entries) => (entries.length === 1 && entries[0].type === "directory" ? entries[0].relativePath : null));
	assert.deepEqual([...controller.getState().expanded].sort(), ["a", "a/b", "a/b/c"]);
	assert.equal(controller.getState().currentDir, "a/b/c");
});

test("展开未加载目录不重建 nodes；已加载目录的展开/收起才重建", async () => {
	const testHarness = harness({
		"": page([dir("a")]),
		a: page([file("x")]),
	});
	const controller = createLazyDirTreeController(testHarness.loader);
	await controller.load("");
	const rootNodes = controller.getState().nodes;
	controller.toggle("a"); // 尚未加载：nodes 不变
	assert.equal(controller.getState().nodes, rootNodes);
	await tick();
	const loadedNodes = controller.getState().nodes;
	assert.notEqual(loadedNodes, rootNodes);
	controller.toggle("a"); // 收起已加载目录：子节点消失，必须重建
	assert.notEqual(controller.getState().nodes, loadedNodes);
	assert.equal(controller.getState().nodes[0].children, undefined);
});

test("失败目录标 hasChildren=false、hasLoaded=false，重试成功后可恢复", async () => {
	let fail = true;
	const calls = [];
	const loader = (path, force) => {
		calls.push({ dir: path, force });
		if (path === "a" && fail) return Promise.resolve({ ok: false, code: "REMOTE_FILE_REQUEST_FAILED" });
		if (path === "a") return Promise.resolve(page([file("x")]));
		return Promise.resolve(page([dir("a")]));
	};
	const controller = createLazyDirTreeController(loader);
	await controller.load("");
	controller.toggle("a");
	await tick();
	assert.equal(controller.getState().nodes[0].hasChildren, false, "失败档不得留下永久加载占位");
	assert.equal(controller.hasLoaded("a"), false);
	fail = false;
	controller.toggle("a"); // 收起
	controller.toggle("a"); // 重新展开：失败档必须能重试
	await tick();
	assert.equal(controller.hasLoaded("a"), true);
	assert.equal(controller.getState().nodes[0].hasChildren, true);
	assert.equal(controller.getState().nodes[0].children[0].name, "x");
});

test("目录页的 watch 降级状态随页面落入树状态，恢复后清空", async () => {
	const degraded = { degraded: true, reason: "watcher-capacity", desired: 40, covered: 32, dropped: 8 };
	let pageWatch = degraded;
	const controller = createLazyDirTreeController(async () => ({ ok: true, page: { nodes: [file("a")], ...(pageWatch === null ? {} : { dirWatch: pageWatch }) } }));
	await controller.load("");
	assert.deepEqual(plain(controller.getState().dirWatch), degraded);
	pageWatch = null;
	await controller.load("", true);
	assert.equal(controller.getState().dirWatch, null, "重读不再降级时必须清掉提示，不能显示过期缺口");
});

test("连接换代时丢弃旧的 watch 降级状态", async () => {
	let rootLoads = 0;
	const loader = async (path) => {
		if (path === "") {
			rootLoads += 1;
			return rootLoads === 1 ? { ok: true, page: { nodes: [dir("a")], generation: "g1", dirWatch: { degraded: true, reason: "paths-over-limit", desired: 40, covered: 32, dropped: 8 } } } : { ok: true, page: { nodes: [dir("a")], generation: "g2" } };
		}
		return { ok: true, page: { nodes: [], generation: "g2" } };
	};
	const controller = createLazyDirTreeController(loader);
	await controller.load("");
	assert.notEqual(controller.getState().dirWatch, null);
	controller.applyFactsChange({ projectId: "p", generation: "g2", scopes: [] });
	assert.equal(controller.getState().dirWatch, null);
	await tick();
	assert.equal(controller.getState().dirWatch, null, "新代页面未降级时不得保留旧代提示");
});
