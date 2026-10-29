import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createSnapshotFactsCache } = loadTsCommonJs("src/main/git/RemoteGitSnapshotFacts.ts");

function deferred() {
	let resolve;
	const promise = new Promise((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/**
 * W4 前置（v5「读事实 / 签授权拆分」）的验收点：
 * 同一次内容变化里，同一个仓库状态只读一次；写之后下一次读会重新装载。
 * 安全边界不在这里——写动词自带 `expectedRevision`，旧事实写不穿。
 */
test("同一个仓库读两次：只装载一次，revision 相同", async () => {
	let loads = 0;
	const cache = createSnapshotFactsCache();
	const first = await cache.read("p1", "", async () => ++loads);
	const second = await cache.read("p1", "", async () => ++loads);
	assert.equal(loads, 1, "第二次读必须命中事实");
	assert.equal(first.revision, second.revision);
	assert.equal(second.cached, true);
	assert.equal(cache.stats().hits, 1);
});

test("并发读同一个仓库只装载一次（树着色与面板同时要状态）", async () => {
	const gate = deferred();
	let loads = 0;
	const cache = createSnapshotFactsCache();
	const a = cache.read("p1", "sub/repo", async () => {
		loads += 1;
		return await gate.promise;
	});
	const b = cache.read("p1", "sub/repo", async () => {
		loads += 1;
		return await gate.promise;
	});
	gate.resolve({ head: "abc" });
	const [first, second] = await Promise.all([a, b]);
	assert.equal(loads, 1);
	assert.equal(cache.stats().merges, 1);
	assert.deepEqual(first.facts, second.facts);
	assert.equal(first.revision, second.revision);
});

test("不同仓库 / 不同项目各自一份事实", async () => {
	const seen = [];
	const cache = createSnapshotFactsCache();
	await cache.read("p1", "", async () => seen.push("p1:"));
	await cache.read("p1", "sub", async () => seen.push("p1:sub"));
	await cache.read("p2", "", async () => seen.push("p2:"));
	assert.deepEqual(seen, ["p1:", "p1:sub", "p2:"]);
});

test("写后标脏：下一次读重新装载且 revision 前进；标脏本身不装载", async () => {
	let loads = 0;
	const cache = createSnapshotFactsCache();
	const before = await cache.read("p1", "", async () => ++loads);
	cache.invalidate("p1", "");
	assert.equal(loads, 1, "标脏不得触发装载");
	const after = await cache.read("p1", "", async () => ++loads);
	assert.equal(loads, 2);
	assert.ok(after.revision > before.revision, "值被替换后 revision 必须变");
});

test("invalidateProject 只标脏本项目；别的项目仍然命中", async () => {
	let loads = 0;
	const cache = createSnapshotFactsCache();
	await cache.read("p1", "", async () => ++loads);
	await cache.read("p1", "sub", async () => ++loads);
	await cache.read("p2", "", async () => ++loads);
	cache.invalidateProject("p1");
	await cache.read("p2", "", async () => ++loads);
	assert.equal(loads, 3, "p2 不受 p1 影响");
	await cache.read("p1", "", async () => ++loads);
	await cache.read("p1", "sub", async () => ++loads);
	assert.equal(loads, 5, "p1 的两个仓库都要重新装载");
});

test("装载失败不留事实：异常照常抛出，下一次读会重试", async () => {
	const cache = createSnapshotFactsCache();
	await assert.rejects(cache.read("p1", "", async () => {
		throw new Error("GIT_RESULT_INVALID");
	}), /GIT_RESULT_INVALID/);
	let loads = 0;
	await cache.read("p1", "", async () => ++loads);
	assert.equal(loads, 1, "失败一次不得让后续读命中空事实");
});

test("单项目仓库数有上限：淘汰最久未用的键（内存不随异常输入增长）", async () => {
	const cache = createSnapshotFactsCache({ maxReposPerProject: 2 });
	let loads = 0;
	await cache.read("p1", "a", async () => ++loads);
	await cache.read("p1", "b", async () => ++loads);
	await cache.read("p1", "a", async () => ++loads); // a 变成最近使用
	await cache.read("p1", "c", async () => ++loads); // 淘汰 b
	assert.equal(cache.stats().entries, 2);
	const before = loads;
	await cache.read("p1", "a", async () => ++loads);
	assert.equal(loads, before, "仍在缓存里就不该重新装载");
	await cache.read("p1", "b", async () => ++loads);
	assert.equal(loads, before + 1, "被淘汰的键要重新装载");
});
