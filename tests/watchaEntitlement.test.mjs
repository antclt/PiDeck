/**
 * 爱猹收打赏主进程侧：响应解析、请求形状、失败关闭。
 *
 * 平台真实响应形状取自 2026-10-29 正式环境实测：
 *   /access → { access: "purchase_required", remaining: 0, purchaseUrl: "alipays://...", qrCodeUrl: "https://..." }
 * 全部用例注入假传输层，不触真实网络。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const mod = loadTsCommonJs("src/main/config/watchaEntitlement.ts");
const { WatchaEntitlementStore, parseWatchaAccessBody } = mod;

const USER_ID = "e2f1c0de-0000-4000-8000-000000000001";

/** 跨 realm（vm 转译）比较前把值转成本 realm 的普通对象。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function makeRequest({ status = 200, body = {}, error } = {}) {
	const calls = [];
	const request = async (url, init) => {
		calls.push({ url, init });
		if (error) return { error };
		return { status, raw: JSON.stringify(body) };
	};
	return { request, calls };
}

function makeStore(request) {
	return new WatchaEntitlementStore({ resolveUserId: async () => USER_ID, request, baseUrl: "https://edge.test" });
}

test("access：granted 解析出累计支持次数", async () => {
	const { request, calls } = makeRequest({ body: { access: "granted", remaining: 7 } });
	const result = await makeStore(request).access();
	assert.deepEqual(plain(result), { ok: true, snapshot: { access: "granted", remaining: 7 } });
	assert.equal(calls[0].url, "https://edge.test/access");
	assert.equal(calls[0].init.method, "POST");
	assert.deepEqual(JSON.parse(calls[0].init.body), { user_id: USER_ID });
	assert.equal(calls[0].init.timeoutMs, 20_000);
});

test("access：purchase_required 透传深链与二维码地址", async () => {
	const { request } = makeRequest({ body: { access: "purchase_required", remaining: 0, purchaseUrl: "alipays://platformapi/startapp?x=1", qrCodeUrl: "https://pay.example/q" } });
	const result = await makeStore(request).access();
	assert.equal(result.ok, true);
	assert.equal(result.snapshot.access, "purchase_required");
	assert.equal(result.snapshot.purchaseUrl, "alipays://platformapi/startapp?x=1");
	assert.equal(result.snapshot.qrCodeUrl, "https://pay.example/q");
});

test("access：未知状态按 bad-response 失败关闭", async () => {
	const { request } = makeRequest({ body: { access: "maybe", remaining: 3 } });
	assert.deepEqual(plain(await makeStore(request).access()), { ok: false, code: "bad-response" });
});

test("access：非 200 透传状态码，不猜成功", async () => {
	const { request } = makeRequest({ status: 502, body: { error: "upstream" } });
	assert.deepEqual(plain(await makeStore(request).access()), { ok: false, code: "http", detail: "502" });
});

test("access：传输层超时/断网原样上报", async () => {
	for (const error of ["timeout", "network"]) {
		const { request } = makeRequest({ error });
		assert.deepEqual(plain(await makeStore(request).access()), { ok: false, code: error });
	}
});

test("access：响应体不是 JSON 时按 bad-response", async () => {
	const request = async () => ({ status: 200, raw: "<html>" });
	assert.deepEqual(plain(await makeStore(request).access()), { ok: false, code: "bad-response" });
});

test("缓存：60s 内复用同一份快照，只打一次代理", async () => {
	let clock = 1_000;
	const store = new WatchaEntitlementStore({ resolveUserId: async () => USER_ID, request: makeRequest({ body: { access: "granted", remaining: 5 } }).request, baseUrl: "https://edge.test", now: () => clock });
	const first = await store.access();
	clock += 30_000;
	const second = await store.access();
	assert.deepEqual(plain(second), plain(first));
});

test("缓存：超过 TTL 或关闭缓存时重新请求", async () => {
	let clock = 0;
	const { request, calls } = makeRequest({ body: { access: "granted", remaining: 5 } });
	const store = new WatchaEntitlementStore({ resolveUserId: async () => USER_ID, request, baseUrl: "https://edge.test", now: () => clock, cacheTtlMs: 60_000 });
	await store.access();
	clock += 61_000;
	await store.access();
	assert.equal(calls.length, 2);

	const noCache = new WatchaEntitlementStore({ resolveUserId: async () => USER_ID, request, baseUrl: "https://edge.test", cacheTtlMs: 0 });
	await noCache.access();
	await noCache.access();
	assert.equal(calls.length, 4);
});

test("缓存：force=true 绕过缓存（到账轮询用）", async () => {
	const { request, calls } = makeRequest({ body: { access: "granted", remaining: 5 } });
	const store = new WatchaEntitlementStore({ resolveUserId: async () => USER_ID, request, baseUrl: "https://edge.test" });
	await store.access();
	await store.access();
	assert.equal(calls.length, 1);
	await store.access({ force: true });
	assert.equal(calls.length, 2);
});

test("解析：负数/小数归一化为非负整数，非对象返回 null", () => {
	assert.deepEqual(plain(parseWatchaAccessBody({ access: "granted", remaining: -3 })), { access: "granted", remaining: 0 });
	assert.deepEqual(plain(parseWatchaAccessBody({ access: "granted", remaining: 2.9 })), { access: "granted", remaining: 2 });
	assert.equal(parseWatchaAccessBody(null), null);
	assert.deepEqual(plain(parseWatchaAccessBody({ access: "granted" })), { access: "granted", remaining: 0 });
});
