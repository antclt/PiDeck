import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createFactCache } = loadTsCommonJs("src/main/remote/RemoteFactCache.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));
function deferred() {
	let resolve;
	const promise = new Promise((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/**
 * 事实缓存（v5 §3）要同时解决两件事：**一次内容变化只问一次远端**（合并）和
 * **刷新的成本由读的人决定**（失效只标脏、不广播装载）。这组用例钉的就是这两条。
 */
test("两次读同一 key：只装载一次，revision 相同，第二次是命中", async () => {
	let calls = 0;
	const cache = createFactCache(async () => {
		calls += 1;
		return { ok: true, value: { entries: calls } };
	});
	const first = await cache.read("dir:/");
	const second = await cache.read("dir:/");
	assert.equal(calls, 1);
	assert.deepEqual(plain(first), { ok: true, value: { entries: 1 }, revision: first.revision, stale: false });
	assert.equal(second.revision, first.revision);
	assert.equal(cache.stats().hits, 1);
	assert.equal(cache.stats().loads, 1);
});

test("并发读同一个 key 只有一个装载，两个读者拿到同一个 revision（合并）", async () => {
	const gate = deferred();
	let calls = 0;
	const cache = createFactCache(async () => {
		calls += 1;
		return await gate.promise;
	});
	const a = cache.read("dir:/src");
	const b = cache.read("dir:/src");
	gate.resolve({ ok: true, value: "v" });
	const [first, second] = await Promise.all([a, b]);
	assert.equal(calls, 1, "同一个 key 不该发出第二次装载");
	assert.equal(cache.stats().merges, 1);
	assert.equal(first.revision, second.revision);
	assert.equal(first.value, "v");
});

test("invalidate 只标脏不装载；下一次读取才付往返，且 revision 递增", async () => {
	let calls = 0;
	const cache = createFactCache(async () => {
		calls += 1;
		return { ok: true, value: calls };
	});
	const before = await cache.read("status:/repo");
	assert.equal(calls, 1);

	cache.invalidate("status:/repo");
	assert.equal(calls, 1, "失效不得触发装载");
	// peek 能看到「旧的、已标脏」的现值：UI 可以先显示它，再决定何时刷新。
	const peeked = cache.peek("status:/repo");
	assert.deepEqual({ ...plain(peeked), revision: 0 }, { ok: true, value: 1, revision: 0, stale: true });
	assert.ok(peeked.revision > before.revision, "失效把 revision 推高一次");

	const after = await cache.read("status:/repo");
	assert.equal(calls, 2);
	assert.equal(after.value, 2);
	assert.ok(after.revision > before.revision, "值被替换后 revision 必须变");
	assert.equal(cache.peek("status:/repo").stale, false);
});

test("重复失效同一个 key 不额外涨 revision（避免风暴）", async () => {
	const cache = createFactCache(async () => ({ ok: true, value: 1 }));
	const first = await cache.read("dir:/");
	cache.invalidate("dir:/");
	const once = cache.peek("dir:/").revision;
	cache.invalidate("dir:/");
	cache.invalidate("dir:/");
	assert.equal(cache.peek("dir:/").revision, once);
	assert.ok(once > first.revision);
});

test("装载失败：如实返回稳定码与 outcome，旧值保留并标脏，不假装成功", async () => {
	let mode = "ok";
	const cache = createFactCache(async () => (mode === "ok" ? { ok: true, value: "old" } : { ok: false, code: "REMOTE_FILE_RESULT_UNCONFIRMED", outcome: "unknown" }));
	const first = await cache.read("dir:/a");
	mode = "fail";
	cache.invalidate("dir:/a");
	// 失效先把 revision 推高一次：之后的失败快照带的是这个 revision，不是「上次成功时的」。
	const invalidated = cache.peek("dir:/a");
	assert.ok(invalidated.revision > first.revision);
	const failed = await cache.read("dir:/a");
	assert.deepEqual(plain(failed), { ok: false, code: "REMOTE_FILE_RESULT_UNCONFIRMED", outcome: "unknown", revision: invalidated.revision });
	assert.equal(failed.ok, false);
	// 旧值还在（标脏），UI 可以继续显示它并给「未确认」提示。
	assert.deepEqual(plain(cache.peek("dir:/a")), { ok: true, value: "old", revision: invalidated.revision, stale: true });
	assert.equal(cache.stats().failures, 1);
	// 恢复后：装载成功、stale 清掉、revision 继续前进。
	mode = "ok";
	const recovered = await cache.read("dir:/a");
	assert.equal(recovered.ok, true);
	assert.ok(recovered.revision > invalidated.revision);
});

test("refresh 强制重新装载；invalidateWhere 按前缀批量标脏", async () => {
	let calls = 0;
	const cache = createFactCache(async () => {
		calls += 1;
		return { ok: true, value: calls };
	});
	await cache.read("dir:/a");
	await cache.read("status:/a");
	await cache.read("status:/b");
	assert.equal(calls, 3);

	await cache.refresh("dir:/a");
	assert.equal(calls, 4, "refresh 明说是刷新，必须真的装载");

	cache.invalidateWhere((key) => key.startsWith("status:"));
	assert.equal(cache.peek("status:/a").stale, true);
	assert.equal(cache.peek("status:/b").stale, true);
	assert.equal(cache.peek("dir:/a").stale, false);
});

test("缓存有上限：超出后淘汰最久未使用的 key（内存不随目录数增长）", async () => {
	let calls = 0;
	const cache = createFactCache(
		async (key) => {
			calls += 1;
			return { ok: true, value: key };
		},
		{ maxEntries: 2 },
	);
	await cache.read("a");
	await cache.read("b");
	await cache.read("a"); // a 变成最近使用
	await cache.read("c"); // 淘汰 b
	assert.equal(cache.stats().entries, 2);
	assert.equal(cache.peek("a").value, "a");
	assert.equal(cache.peek("b"), undefined);
	const before = calls;
	await cache.read("a");
	assert.equal(calls, before, "仍在缓存里就不该重新装载");
});
