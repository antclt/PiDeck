import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createFactCache } = loadTsCommonJs("src/main/remote/RemoteFactCache.ts");
const { createSnapshotFactsCache } = loadTsCommonJs("src/main/git/RemoteGitSnapshotFacts.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((settle, fail) => {
		resolve = settle;
		reject = fail;
	});
	return { promise, resolve, reject };
}

/** 让已经挂起的 promise 链跑完（旧 flight 的 then/finally 都在微任务里）。 */
const settle = async () => {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

/**
 * T1（v5 §10.3）：失效必须**退休**在途装载，而不只是给缓存值打 stale 标记。
 *
 * 旧实现的两个洞：
 * - 只有缓存值被标脏；在途请求仍然可以被下一次读合并，于是失效之后读到的还是写前的旧事实；
 * - 旧请求 settle 时的 `finally` 无条件 `inflight.delete(key)`，会把**新** flight 从登记表里删掉，
 *   第三个读于是再发一次装载（或者更糟：旧结果写回缓存）。
 *
 * 这里用假装载端口把两个洞都变成可重复断言，不需要 SSH。
 */
test("R1：invalidate 退休在途读；旧读取消、不发布、不删新 flight，第三个读与 B 合并", async () => {
	const gateA = deferred();
	const gateB = deferred();
	let loads = 0;
	const cache = createFactCache(async () => {
		loads += 1;
		return await (loads === 1 ? gateA.promise : gateB.promise);
	});

	const a = cache.read("dir:/a");
	assert.equal(loads, 1);
	cache.invalidate("dir:/a");
	const b = cache.read("dir:/a");
	assert.equal(loads, 2, "失效之后必须能建立新 flight，不得合并到已退休的读");

	gateA.resolve({ ok: true, value: "old" });
	const retired = await a;
	assert.equal(retired.ok, false, "退休读不得发布旧成功");
	assert.equal(retired.code, "REQUEST_CANCELLED");

	// A 的 finally 不能把 B 从登记表里删掉；否则这里会多一次装载。
	const c = cache.read("dir:/a");
	gateB.resolve({ ok: true, value: "new" });
	const [first, second] = await Promise.all([b, c]);
	assert.equal(loads, 2, "第三个读必须与 B 合并，不因 A.finally 多打一次远端");
	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.equal(first.value, "new");
	assert.equal(second.value, "new");
	assert.equal(second.revision, first.revision);
	assert.equal(cache.stats().merges, 1);
	assert.deepEqual(plain(cache.peek("dir:/a")), { ok: true, value: "new", revision: first.revision, stale: false });
});

test("R1：退休读的失败也不得覆盖新 flight（成功/失败两条路径都取消）", async () => {
	const gateA = deferred();
	const gateB = deferred();
	let loads = 0;
	const cache = createFactCache(async () => {
		loads += 1;
		return await (loads === 1 ? gateA.promise : gateB.promise);
	});

	const a = cache.read("status:/a");
	cache.invalidate("status:/a");
	const b = cache.read("status:/a");
	gateA.resolve({ ok: false, code: "REMOTE_FILE_RESULT_UNCONFIRMED", outcome: "unknown" });
	const retired = await a;
	assert.equal(retired.code, "REQUEST_CANCELLED", "退休读不得把旧失败当成这次失效的事实");
	gateB.resolve({ ok: true, value: "fresh" });
	const fresh = await b;
	assert.equal(fresh.ok, true);
	assert.equal(fresh.value, "fresh");
	assert.equal(loads, 2);
	assert.equal(cache.stats().failures, 0, "退休读不计失败次数");
});

test("R1：旧装载器抛异常时，退休读仍以 REQUEST_CANCELLED 结束，不删新 flight", async () => {
	const gateA = deferred();
	const gateB = deferred();
	let loads = 0;
	const cache = createFactCache(async () => {
		loads += 1;
		if (loads === 1) {
			await gateA.promise;
			throw new Error("REMOTE_CONNECTION_LOST");
		}
		return await gateB.promise;
	});

	const a = cache.read("dir:/a");
	cache.invalidate("dir:/a");
	const b = cache.read("dir:/a");
	gateA.reject(new Error("REMOTE_CONNECTION_LOST"));
	const retired = await a;
	assert.equal(retired.ok, false, "退休读统一以取消结束，不把旧异常当成本次结果");
	assert.equal(retired.code, "REQUEST_CANCELLED");
	gateB.resolve({ ok: true, value: "fresh" });
	assert.equal((await b).value, "fresh");
	assert.equal(loads, 2);
});

test("R2：clear / clearWhere 退休在途读；旧值不重新入缓存，下一次读装载新值", async () => {
	const gateA = deferred();
	let loads = 0;
	const cache = createFactCache(async () => {
		loads += 1;
		if (loads === 1) return await gateA.promise;
		return { ok: true, value: "fresh" };
	});

	const a = cache.read("dir:/a");
	cache.clear();
	gateA.resolve({ ok: true, value: "old" });
	assert.equal((await a).code, "REQUEST_CANCELLED");
	assert.equal(cache.peek("dir:/a"), undefined, "clear 之后旧 flight 不得把值写回缓存");

	const again = await cache.read("dir:/a");
	assert.equal(loads, 2);
	assert.deepEqual(plain(again), { ok: true, value: "fresh", revision: again.revision, stale: false });
});

test("R2：clearWhere 只退休匹配的键，别的项目在途读照常完成", async () => {
	const gateKeep = deferred();
	const gateGone = deferred();
	let loads = 0;
	const cache = createFactCache(async (key) => {
		loads += 1;
		return await (key.startsWith("p1|") ? gateGone.promise : gateKeep.promise);
	});

	const keep = cache.read("p2|dir:/");
	const gone = cache.read("p1|dir:/");
	cache.clearWhere((key) => key.startsWith("p1|"));
	gateGone.resolve({ ok: true, value: "p1-old" });
	gateKeep.resolve({ ok: true, value: "p2" });

	assert.equal((await gone).code, "REQUEST_CANCELLED");
	assert.equal((await keep).value, "p2", "别的项目的在途读不受影响");
	assert.equal(loads, 2, "两个在途装载各自只发一次；退休不额外引入装载");
});

test("R3：只有挂起 load、还没有缓存值时，invalidateWhere 仍能退休它", async () => {
	const gateA = deferred();
	let loads = 0;
	const cache = createFactCache(async () => {
		loads += 1;
		if (loads === 1) return await gateA.promise;
		return { ok: true, value: "fresh" };
	});

	const a = cache.read("status:/repo");
	assert.equal(cache.peek("status:/repo"), undefined, "此时只有在途请求，没有缓存值");
	cache.invalidateWhere((key) => key.startsWith("status:"));
	const b = cache.read("status:/repo");
	assert.equal(loads, 2, "entries 为空不能漏掉在途请求");
	gateA.resolve({ ok: true, value: "stale" });
	assert.equal((await a).code, "REQUEST_CANCELLED");
	assert.equal((await b).value, "fresh");
});

test("R3：snapshot 只有挂起 load 时，invalidate / invalidateProject / clear 也退休它", async () => {
	const gateA = deferred();
	const gateB = deferred();
	const gateC = deferred();
	let loads = 0;
	const cache = createSnapshotFactsCache();
	const loader = async (gate, value) => {
		loads += 1;
		return await gate.promise;
	};

	const a = cache.read("p1", "", () => loader(gateA, "old"));
	cache.invalidateProject("p1");
	const b = cache.read("p1", "", () => loader(gateB, "new"));
	assert.equal(loads, 2);
	gateA.resolve("old");
	await assert.rejects(a, /REQUEST_CANCELLED/);
	gateB.resolve("new");
	assert.equal((await b).facts, "new");

	// invalidate(project, repo) 同样要覆盖“只有在途、没有缓存值”的 key。
	const c = cache.read("p1", "sub", () => loader(gateC, "old-sub"));
	cache.invalidate("p1", "sub");
	const d = cache.read("p1", "sub", async () => "new-sub");
	gateC.resolve("old-sub");
	await assert.rejects(c, /REQUEST_CANCELLED/);
	assert.equal((await d).facts, "new-sub");
	assert.equal(loads, 3);
});

test("R3：snapshot clear 退休全部在途读，旧结果不写回", async () => {
	const gate = deferred();
	const cache = createSnapshotFactsCache();
	const a = cache.read("p1", "", async () => await gate.promise);
	cache.clear();
	gate.resolve("old");
	await assert.rejects(a, /REQUEST_CANCELLED/);
	assert.equal(cache.stats().entries, 0);
	assert.equal((await cache.read("p1", "", async () => "fresh")).facts, "fresh");
});

test("R4：重复失效不涨 revision、不装载；不同项目互不影响；失败与 LRU 语义保持", async () => {
	let loads = 0;
	const cache = createFactCache(async () => ({ ok: true, value: (loads += 1) }));
	const first = await cache.read("dir:/");
	cache.invalidate("dir:/");
	const once = cache.peek("dir:/").revision;
	cache.invalidate("dir:/");
	cache.invalidate("dir:/");
	assert.equal(cache.peek("dir:/").revision, once, "重复失效不得反复涨 revision");
	assert.equal(loads, 1, "失效本身不装载");
	assert.ok(once > first.revision);

	// 别的项目的在途读不被 clearWhere/invalidateWhere 退休。
	const gateKeep = deferred();
	const scoped = createFactCache(async () => await gateKeep.promise);
	const keep = scoped.read("p2|dir:/");
	scoped.invalidateWhere((key) => key.startsWith("p1|"));
	gateKeep.resolve({ ok: true, value: "p2" });
	assert.equal((await keep).value, "p2");

	// 非退休的装载失败仍然照常抛出（既有行为不回退）。
	const throwing = createFactCache(async () => {
		throw new Error("REMOTE_CONNECTION_LOST");
	});
	await assert.rejects(throwing.read("dir:/"), /REMOTE_CONNECTION_LOST/);

	// LRU 上限仍然生效：失效不制造额外条目。
	const bounded = createFactCache(async (key) => ({ ok: true, value: key }), { maxEntries: 2 });
	await bounded.read("a");
	await bounded.read("b");
	bounded.invalidate("a");
	await bounded.read("c");
	assert.equal(bounded.stats().entries, 2);
	assert.equal(bounded.peek("b"), undefined, "最久未用的键照常被淘汰");

	// snapshot 的重复失效同样不涨 revision、不装载。
	let snapshotLoads = 0;
	const facts = createSnapshotFactsCache();
	const before = await facts.read("p1", "", async () => (snapshotLoads += 1));
	facts.invalidate("p1", "");
	const snapshotOnce = facts.stats();
	facts.invalidate("p1", "");
	assert.equal(snapshotLoads, 1);
	const after = await facts.read("p1", "", async () => (snapshotLoads += 1));
	assert.equal(snapshotLoads, 2);
	assert.ok(after.revision > before.revision);
	assert.equal(facts.stats().entries, snapshotOnce.entries);
});
