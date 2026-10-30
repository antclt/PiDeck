import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { readRemoteDirectoryPageWithRetry } = loadTsCommonJs("src/renderer/src/utils/remoteDirectoryPageRetry.ts");

test("切换项目的瞬态未就绪会退避后重读，成功后返回目录页", async () => {
	const results = [
		{ ok: false, code: "SSH_HOST_NOT_READY" },
		{ ok: false, code: "SSH_HOST_CONNECTION_FAILED" },
		{ ok: true, value: { entries: [] } },
	];
	const sleeps = [];
	const value = await readRemoteDirectoryPageWithRetry(async () => results.shift(), { attempts: 5, sleep: async (attempt) => sleeps.push(attempt) });
	assert.equal(value.ok, true);
	assert.deepEqual(sleeps, [1, 2]);
});

test("真实断连/非瞬态错误立即返回，不做无意义重试", async () => {
	let calls = 0;
	const value = await readRemoteDirectoryPageWithRetry(
		async () => {
			calls += 1;
			return { ok: false, code: "SSH_HOST_DISCONNECTED" };
		},
		{ attempts: 5, sleep: async () => undefined },
	);
	assert.equal(value.code, "SSH_HOST_DISCONNECTED");
	assert.equal(calls, 1);
});

test("重试有界：持续瞬态时返回最后一次结果", async () => {
	let calls = 0;
	const value = await readRemoteDirectoryPageWithRetry(
		async () => {
			calls += 1;
			return { ok: false, code: "SSH_HOST_NOT_READY" };
		},
		{ attempts: 3, sleep: async () => undefined },
	);
	assert.equal(value.code, "SSH_HOST_NOT_READY");
	assert.equal(calls, 3);
});
