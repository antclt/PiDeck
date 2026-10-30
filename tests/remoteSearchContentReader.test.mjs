import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端内容搜索 reader（helper 1.25.0）单测：窄 port 替身注入，不碰真实 SSH/子进程。
 *
 * 这里钉住的是「远端回答是远端数据」这条纪律：结果与命中字段集精确、逐字段重建、三项计数交叉一致、
 * 截断与 reason 必须成对且只从闭集取值、超过命中上限按 RESULT_TOO_LARGE 拒绝而不是悄悄截断；取消经由
 * port 的 cancel 转成 helper 的 REQUEST_CANCELLED，而不是等到时间预算耗尽。
 */

const contract = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const { createRemoteSearchReader, REMOTE_SEARCH_READER_CODES } = loadTsCommonJs("src/main/remote/RemoteSearchReader.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));
const HOST = "b145de8c-6330-45be-8752-f20e8e270150";

const match = (path, name, line, column, snippet = "needle here") => ({ path, name, line, column, snippet });
const answer = (matches, overrides = {}) => ({ matches, matchedFiles: new Set(matches.map((entry) => entry.path)).size, scannedFiles: matches.length, scannedBytes: 128, truncated: false, ...overrides });

function makeReader(result, calls, cancel) {
	return createRemoteSearchReader({
		port: {
			request: async (...args) => {
				calls?.push(args);
				return typeof result === "function" ? result(...args) : result;
			},
			...(cancel === undefined ? {} : { cancel }),
		},
	});
}

async function failureOf(promise) {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to reject");
}

test("a well-formed content answer is rebuilt field by field and sent with the frozen op name", async () => {
	const calls = [];
	const reader = makeReader(answer([match("src/main.ts", "main.ts", 2, 7, "needle here"), match("src/sub/a.ts", "a.ts", 1, 0, "needle")]), calls);
	const result = await reader.searchContent(HOST, ".", "needle");
	assert.deepEqual(plain(result), {
		matches: [
			{ path: "src/main.ts", name: "main.ts", line: 2, column: 7, snippet: "needle here" },
			{ path: "src/sub/a.ts", name: "a.ts", line: 1, column: 0, snippet: "needle" },
		],
		matchedFiles: 2,
		scannedFiles: 2,
		scannedBytes: 128,
		truncated: false,
	});
	assert.deepEqual(Object.keys(result), ["matches", "matchedFiles", "scannedFiles", "scannedBytes", "truncated"]);
	const [hostId, method, params, options] = calls[0];
	assert.equal(hostId, HOST);
	assert.equal(method, "fs.searchContent");
	assert.deepEqual(plain(params), { path: ".", query: "needle" });
	// No local deadline is invented: the transport default is used when the caller gives none, and the
	// request id is captured so an AbortSignal can withdraw this exact frame.
	assert.equal(options.timeoutMs, undefined);
	assert.equal(typeof options.onRequestId, "function");
});

test("truncated always carries its reason and a reason never travels without truncation", async () => {
	const truncated = await makeReader(answer([match("a.ts", "a.ts", 1, 0)], { truncated: true, reason: "matches", matchedFiles: 1 })).searchContent(HOST, ".", "needle");
	assert.equal(truncated.truncated, true);
	assert.equal(truncated.reason, "matches");
	const noReason = await failureOf(makeReader(answer([], { truncated: true })).searchContent(HOST, ".", "needle"));
	assert.equal(noReason.code, "PROTOCOL_INVALID");
	const strayReason = await failureOf(makeReader(answer([], { truncated: false, reason: "time" })).searchContent(HOST, ".", "needle"));
	assert.equal(strayReason.code, "PROTOCOL_INVALID");
	const unknownReason = await failureOf(makeReader(answer([], { truncated: true, reason: "cursor" })).searchContent(HOST, ".", "needle"));
	assert.equal(unknownReason.code, "PROTOCOL_INVALID");
});

test("an over-limit match list is refused as RESULT_TOO_LARGE, never silently truncated", async () => {
	const matches = Array.from({ length: contract.REMOTE_HELPER_MAX_CONTENT_MATCHES + 1 }, (_value, index) => match("f" + index + ".ts", "f" + index + ".ts", 1, 0));
	const error = await failureOf(makeReader(answer(matches)).searchContent(HOST, ".", "needle"));
	assert.equal(error.code, "RESULT_TOO_LARGE");
	assert.equal(error.message, "RESULT_TOO_LARGE");
});

test("result shape and count invariants are PROTOCOL_INVALID", async () => {
	const cases = [
		["not a record", 42],
		["unknown result field", { ...answer([]), extra: true }],
		["matches not an array", { ...answer([]), matches: {} }],
		["match fields are exact", answer([{ path: "a.ts", name: "a.ts", line: 1, column: 0 }])],
		["match has extra field", answer([{ ...match("a.ts", "a.ts", 1, 0), bytes: 1 }])],
		["absolute match path", answer([match("/etc/passwd", "passwd", 1, 0)])],
		["name disagrees with path", answer([match("src/a.ts", "b.ts", 1, 0)])],
		["line is 1-based", answer([match("a.ts", "a.ts", 0, 0)])],
		["negative column", answer([match("a.ts", "a.ts", 1, -1)])],
		["snippet over the ceiling", answer([match("a.ts", "a.ts", 1, 0, "x".repeat(contract.REMOTE_HELPER_MAX_CONTENT_SNIPPET_LENGTH + 1))])],
		["snippet with a newline", answer([match("a.ts", "a.ts", 1, 0, "needle\nbody")])],
		["matchedFiles above match count", answer([match("a.ts", "a.ts", 1, 0)], { matchedFiles: 2 })],
		["matchedFiles above scannedFiles", answer([match("a.ts", "a.ts", 1, 0)], { scannedFiles: 0 })],
		["scannedFiles over the ceiling", answer([], { scannedFiles: contract.REMOTE_HELPER_MAX_CONTENT_SCANNED_FILES + 1 })],
		["scannedBytes over the ceiling", answer([], { scannedBytes: contract.REMOTE_HELPER_MAX_CONTENT_SCANNED_BYTES + 1 })],
		["negative count", answer([], { scannedBytes: -1 })],
		["truncated not boolean", answer([], { truncated: "yes" })],
	];
	for (const [label, value] of cases) {
		const error = await failureOf(makeReader(value).searchContent(HOST, ".", "needle"));
		assert.equal(error.code, "PROTOCOL_INVALID", label + ": " + JSON.stringify(value));
	}
});

test("bad host, path and query are refused before any frame is written", async () => {
	const calls = [];
	const reader = makeReader(answer([]), calls);
	for (const [host, path, query, code] of [
		["", ".", "needle", "PROTOCOL_INVALID"],
		[HOST, "", "needle", "PROTOCOL_INVALID"],
		[HOST, ".", "", REMOTE_SEARCH_READER_CODES.queryInvalid],
		[HOST, ".", "x".repeat(contract.REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH + 1), REMOTE_SEARCH_READER_CODES.queryInvalid],
	]) {
		const error = await failureOf(reader.searchContent(host, path, query));
		assert.equal(error.code, code, JSON.stringify({ host, path, query }));
	}
	assert.equal(calls.length, 0, "an invalid call must not reach the transport");
});

test("maxMatches is clamped to the content ceiling and a nonsensical value is refused", async () => {
	const calls = [];
	const reader = makeReader(answer([]), calls);
	await reader.searchContent(HOST, ".", "needle", { maxMatches: 1_000_000 });
	assert.equal(JSON.parse(JSON.stringify(calls[0][2])).maxMatches, contract.REMOTE_HELPER_MAX_CONTENT_MATCHES);
	await reader.searchContent(HOST, ".", "needle", { maxMatches: 7 });
	assert.equal(JSON.parse(JSON.stringify(calls[1][2])).maxMatches, 7);
	const refused = await failureOf(reader.searchContent(HOST, ".", "needle", { maxMatches: 0 }));
	assert.equal(refused.code, "PROTOCOL_INVALID");
	assert.equal(calls.length, 2);
});

test("an AbortSignal cancels the running request by id and answers REQUEST_CANCELLED", async () => {
	let rejectRequest;
	let cancelled = null;
	const reader = createRemoteSearchReader({
		port: {
			request: (_hostId, _method, _params, options) => {
				options.onRequestId("req-content-1");
				return new Promise((_resolve, reject) => {
					rejectRequest = reject;
				});
			},
			cancel: async (hostId, requestId) => {
				cancelled = { hostId, requestId };
				return { cancelled: true };
			},
		},
	});
	const controller = new AbortController();
	const pending = failureOf(reader.searchContent(HOST, ".", "needle", { signal: controller.signal }));
	controller.abort();
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(cancelled, { hostId: HOST, requestId: "req-content-1" }, "abort must withdraw the exact request id");
	const transportError = Object.assign(new Error("REQUEST_CANCELLED"), { code: "REQUEST_CANCELLED" });
	rejectRequest(transportError);
	const error = await pending;
	assert.equal(error.code, "REQUEST_CANCELLED");
	// The local cancel outcome is stable and non-retryable, and it is reported once.
	assert.equal(error.retryable, false);
});

test("an already-aborted signal never writes a frame", async () => {
	const calls = [];
	const reader = makeReader(answer([]), calls);
	const controller = new AbortController();
	controller.abort();
	const error = await failureOf(reader.searchContent(HOST, ".", "needle", { signal: controller.signal }));
	assert.equal(error.code, "REQUEST_CANCELLED");
	assert.equal(calls.length, 0);
});

test("transport failures relay a stable code and fold free text", async () => {
	const stable = await failureOf(makeReader(async () => Promise.reject(Object.assign(new Error("REQUEST_TIMEOUT"), { code: "REQUEST_TIMEOUT", retryable: true }))).searchContent(HOST, ".", "needle"));
	assert.equal(stable.code, "REQUEST_TIMEOUT");
	assert.equal(stable.retryable, true);
	const noisy = await failureOf(makeReader(async () => Promise.reject(new Error("ssh: connect to /home/secret failed"))).searchContent(HOST, ".", "needle"));
	assert.equal(noisy.code, REMOTE_SEARCH_READER_CODES.requestFailed);
	assert.equal(noisy.message, REMOTE_SEARCH_READER_CODES.requestFailed);
});
