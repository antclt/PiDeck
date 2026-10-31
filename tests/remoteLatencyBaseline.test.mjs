import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * F0 基线（docs/remote-functional-optimization-plan.md §3 F0 / §7.1）：把「一次远端往返」固定成 100 ms，
 * 用**实际工作量**（请求数、上传字节数）当硬判据，墙钟耗时只做同条件对照。
 *
 * 为什么用注入延迟而不是真机：真机网络不可重复，100 ms 是把两边拉到同一条件下的手段；真机证据仍归
 * F5（§7.2 未验证项），本文件不声称任何真实网络结论。
 */
const { createRemoteSessionScanner } = loadTsCommonJs("src/main/sessions/RemoteSessionScanner.ts");
const { createRemoteWorkspaceReader } = loadTsCommonJs("src/main/remote/RemoteWorkspaceReader.ts");
const { deployPreparedBundle } = loadTsCommonJs("src/main/remote/RemoteBootstrapDeployment.ts");
const { buildBundleManifest, observeBundleFiles } = loadTsCommonJs("src/main/remote/RemoteBootstrapUpload.ts");

const HOST = "b145de8c-6330-45be-8752-f20e8e270150";
const RTT_MS = 100;
const plain = (value) => JSON.parse(JSON.stringify(value));

function sessionName(index) {
	return `2026-01-01T00-00-00_id${String(index).padStart(4, "0")}.jsonl`;
}

/**
 * A remote whose every request costs one RTT. The shape is the helper's: `fs.list`, `fs.stat` and the
 * batched `fs.statMany`, with the default session root being the only directory that has entries.
 */
function latencyRemote({ count, rttMs = RTT_MS }) {
	const listing = Array.from({ length: count }, (_, index) => ({ name: sessionName(index), kind: "file", bytes: index }));
	const requests = [];
	let inflight = 0;
	let peak = 0;
	const describe = (path) => {
		const entry = listing.find((candidate) => candidate.name === path);
		if (entry === undefined) throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
		return { path, kind: "file", bytes: entry.bytes, mtimeMs: 1_700_000_000_000 + entry.bytes };
	};
	const session = {
		async request(method, params) {
			requests.push({ method, params });
			inflight += 1;
			peak = Math.max(peak, inflight);
			try {
				await new Promise((resolve) => setTimeout(resolve, rttMs));
				if (method === "fs.list") return { entries: params.path === "." ? listing : [] };
				if (method === "fs.statMany") return { entries: params.paths.map((path) => describe(path)) };
				if (method === "fs.stat") {
					const { kind, bytes, mtimeMs } = describe(params.path);
					return { kind, bytes, mtimeMs };
				}
				throw Object.assign(new Error("METHOD_NOT_FOUND"), { code: "METHOD_NOT_FOUND" });
			} finally {
				inflight -= 1;
			}
		},
		async cancel() {
			return { cancelled: true };
		},
	};
	const port = {
		remoteHome: async () => "/home/dev",
		withProjectSession: async (_hostId, _root, task) => ({ ok: true, value: await task(session) }),
	};
	const readerPort = { request: (_hostId, method, params) => session.request(method, params), cancel: () => session.cancel() };
	return { port, readerPort, requests, peak: () => peak };
}

const batchesOf = (requests) => requests.filter((request) => request.method === "fs.statMany");

test(`100ms RTT：2000 个会话文件的元数据只需 ≤32 次批量请求（helper 1.22.0）`, { timeout: 60_000 }, async () => {
	const remote = latencyRemote({ count: 2000 });
	const started = Date.now();
	const result = await createRemoteSessionScanner({ port: remote.port }).scan(HOST);
	const elapsed = Date.now() - started;
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.entries.length, 2000);
	assert.ok(batchesOf(remote.requests).length <= 32, `metadata requests: ${batchesOf(remote.requests).length}`);
	assert.ok(remote.requests.length <= 34, `one config probe + one listing + at most 32 metadata requests, saw ${remote.requests.length}`);
	for (const batch of batchesOf(remote.requests)) assert.ok(batch.params.paths.length <= 64, `batch of ${batch.params.paths.length}`);
	// 34 requests at concurrency 4 = 9 sequential round trips; allow generous slack for a loaded CI machine.
	assert.ok(elapsed < 5000, `wall clock ${elapsed}ms`);
	console.log(`[baseline] F4 2000 文件 / 100ms RTT: requests=${remote.requests.length} batches=${batchesOf(remote.requests).length} peak=${remote.peak()} elapsedMs=${elapsed}`);
});

test(`100ms RTT：同一份 200 文件夹具，逐条 fs.stat（旧行为）与 fs.statMany（现行为）结果一致、请求数 201→6`, { timeout: 120_000 }, async () => {
	const count = 200;
	const perFileRemote = latencyRemote({ count });
	const reader = createRemoteWorkspaceReader({ port: perFileRemote.readerPort });
	const perFileStarted = Date.now();
	const listing = await reader.list(HOST, ".");
	const perFile = [];
	// The loop the scanner used before F4: one `fs.stat` per candidate at concurrency 4.
	let cursor = 0;
	const workers = Array.from({ length: 4 }, async () => {
		while (cursor < listing.entries.length) {
			const entry = listing.entries[cursor];
			cursor += 1;
			const stat = await reader.stat(HOST, entry.name);
			if (stat.kind === "file") perFile.push({ remoteSessionId: entry.name, size: stat.bytes, mtimeMs: stat.mtimeMs });
		}
	});
	await Promise.all(workers);
	const perFileElapsed = Date.now() - perFileStarted;

	const batchedRemote = latencyRemote({ count });
	const batchedStarted = Date.now();
	const result = await createRemoteSessionScanner({ port: batchedRemote.port }).scan(HOST);
	const batchedElapsed = Date.now() - batchedStarted;
	assert.equal(result.ok, true, JSON.stringify(result));

	// Same facts, field for field: the batch is not a cheaper description, it is the same one.
	const normalise = (entries) => entries.slice().sort((left, right) => (left.remoteSessionId < right.remoteSessionId ? -1 : left.remoteSessionId > right.remoteSessionId ? 1 : 0));
	assert.deepEqual(
		plain(normalise(result.entries)).map((entry) => [entry.remoteSessionId, entry.size, entry.mtimeMs]),
		plain(normalise(perFile)).map((entry) => [entry.remoteSessionId, entry.size, entry.mtimeMs]),
	);

	// Hard criterion: work, not wall clock. 201 requests (list + 200 stats) vs 6 (probe + list + 4 batches).
	assert.equal(perFileRemote.requests.length, 1 + count);
	assert.equal(batchedRemote.requests.length, 6);
	assert.ok(batchesOf(batchedRemote.requests).length === 4, `batches: ${batchesOf(batchedRemote.requests).length}`);
	// Same-condition wall clock, as a sanity band around the arithmetic model: 200/4 * RTT vs 4/4 * RTT.
	assert.ok(perFileElapsed > batchedElapsed * 10, `per-file ${perFileElapsed}ms vs batched ${batchedElapsed}ms`);
	console.log(`[baseline] F4 200 文件 / 100ms RTT: perFileRequests=${perFileRemote.requests.length} perFileMs=${perFileElapsed} batchedRequests=${batchedRemote.requests.length} batchedMs=${batchedElapsed}`);
});

test("bundle 复用命中：0 次 scp、0 字节上传、1 轮声明（F3）", { timeout: 60_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-baseline-reuse-"));
	const cleanup = () => rm(directory, { recursive: true, force: true });
	try {
		await writeFile(join(directory, "helper.mjs"), "// helper payload\n".repeat(64));
		await writeFile(join(directory, "runner.mjs"), "// runner payload\n".repeat(32));
		const manifest = buildBundleManifest(await observeBundleFiles(directory, ["helper.mjs", "runner.mjs"]));
		const bytesOnWire = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
		const connection = { executable: "/usr/bin/scp", destination: "pideck-verified-host", args: ["-o", "BatchMode=yes"], env: { PATH: "/usr/bin" }, openSshVersion: "OpenSSH_9.5p1" };
		const ready = { op: "ready", protocolVersion: 1, bundleSha256: manifest.bundleSha256, nonce: "abc12345678901234567", deployRoot: "/home/test/.pideck/remote-host", staging: ".staging-abc12345678901234567", stagingMode: "0700" };

		const entrySession = (answers) => {
			const listeners = new Set();
			const writes = [];
			return {
				writes,
				write(line) {
					const frame = JSON.parse(line);
					writes.push(frame);
					const answer = frame.op === "finalize-verify" ? answers.verify : frame.op === "finalize-commit" ? answers.commit : undefined;
					if (answer !== undefined)
						queueMicrotask(() => {
							for (const listener of [...listeners]) listener(JSON.stringify({ v: 1, ...answer }));
						});
				},
				onStdoutLine(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				onExit: () => () => {},
			};
		};
		let uploads = 0;
		const launcher = {
			async start() {
				uploads += 1;
				return {
					onExit(listener) {
						queueMicrotask(() => listener({ kind: "exited", code: 0, signal: null }));
						return () => {};
					},
					onStdoutLine: () => () => {},
					onStderrLine: () => () => {},
					write() {
						assert.fail("scp must not receive stdin");
					},
					async stop() {},
				};
			},
		};

		// 首次安装：absent → 一轮 verify 声明 + 一轮 finalize 声明 + 一次 scp。
		const first = entrySession({ verify: { op: "verify-miss", reason: "absent" }, commit: { op: "finalized", active: `./bundles/${manifest.bundleSha256}`, files: manifest.files.length } });
		const deployed = await deployPreparedBundle({ directory, names: ["helper.mjs", "runner.mjs"], connection, ready, launcher, session: first, hostId: HOST, generation: 1 });
		assert.equal(uploads, 1);
		assert.equal(deployed.reused, undefined, "a cold install is not a reuse");
		const coldDeclarations = first.writes.filter((frame) => frame.op === "finalize-begin").length;
		assert.equal(coldDeclarations, 2, "cold install: one verify round and one finalize round");

		// 第二次（切项目 / 重连）：verified → 一轮声明，0 次 scp，0 字节。
		const second = entrySession({ verify: { op: "verified", active: `./bundles/${manifest.bundleSha256}`, files: manifest.files.length } });
		const reused = await deployPreparedBundle({ directory, names: ["helper.mjs", "runner.mjs"], connection, ready, launcher, session: second, hostId: HOST, generation: 2 });
		assert.equal(uploads, 1, "a verified bundle must not start another scp");
		assert.equal(reused.reused, true);
		assert.equal(second.writes.filter((frame) => frame.op === "finalize-begin").length, 1);
		assert.equal(
			second.writes.some((frame) => frame.op === "finalize-commit"),
			false,
			"nothing is committed when nothing is uploaded",
		);
		console.log(`[baseline] F3 复用命中: bytesOnWire=${bytesOnWire} coldScp=1 coldRounds=${coldDeclarations} reusedScp=0 reusedRounds=1`);
	} finally {
		await cleanup();
	}
});
