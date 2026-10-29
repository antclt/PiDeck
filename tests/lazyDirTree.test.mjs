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
