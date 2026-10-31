import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * F3（main 侧）：复用**已安装且逐文件复验过**的 bundle，而不是每次切项目/重连都重传。
 *
 * 真实冻结入口的一致性在 tests/remoteBootstrapContract.test.mjs 里跑；这里检验 main 如何消费
 * `verified` / `verify-miss`，以及它怎样把不合法或冲突的答案一律当失败处理（不降级成"再传一遍"）。
 */
const { deployPreparedBundle } = loadTsCommonJs("src/main/remote/RemoteBootstrapDeployment.ts");
const { buildBundleManifest, observeBundleFiles } = loadTsCommonJs("src/main/remote/RemoteBootstrapUpload.ts");
const { runBootstrapVerify } = loadTsCommonJs("src/main/remote/RemoteBootstrapTransfer.ts");

const HOST_ID = "b145de8c-6330-45be-8752-f20e8e270150";
const NONCE = "abc12345678901234567";
const CONNECTION = { executable: "/usr/bin/scp", destination: "pideck-verified-host", args: ["-o", "BatchMode=yes"], env: { PATH: "/usr/bin" }, openSshVersion: "OpenSSH_9.5p1" };

async function prepared(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-reuse-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, "entry.mjs"), "original bytes\n");
	const manifest = buildBundleManifest(await observeBundleFiles(directory, ["entry.mjs"]));
	return {
		directory,
		manifest,
		ready: { op: "ready", protocolVersion: 1, bundleSha256: manifest.bundleSha256, nonce: NONCE, deployRoot: "/home/test/.pideck/remote-host", staging: `.staging-${NONCE}`, stagingMode: "0700" },
	};
}

/**
 * A bootstrap entry that answers by op. `verify` answers `finalize-verify`; `commit` answers the commit
 * (omitted = never answers, which is what the reuse cases need).
 */
function session(manifest, answers = {}) {
	const listeners = new Set();
	const exitListeners = new Set();
	const writes = [];
	const reply = (frame) => {
		for (const listener of [...listeners]) listener(JSON.stringify({ v: 1, ...frame }));
	};
	return {
		writes,
		write(line) {
			const frame = JSON.parse(line);
			writes.push(frame);
			if (frame.op === "finalize-verify" && answers.verify !== undefined) queueMicrotask(() => reply(answers.verify));
			if (frame.op === "finalize-commit" && answers.commit !== undefined) queueMicrotask(() => reply(answers.commit));
		},
		onStdoutLine(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onExit(listener) {
			exitListeners.add(listener);
			return () => exitListeners.delete(listener);
		},
		emitExit() {
			for (const listener of [...exitListeners]) listener({ kind: "exited", code: 1, signal: null });
		},
	};
}

/** Bounded poll with a wall-clock deadline (turn counts are not a time bound in a parallel test run). */
async function waitFor(predicate, message) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail(message);
}

function unreachableLauncher(label) {
	return {
		async start() {
			assert.fail(label);
		},
	};
}

function successfulUpload(onStart) {
	return {
		async start() {
			onStart?.();
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
}

test("a verified answer reuses the installed bundle and never starts a transfer", async (t) => {
	const { directory, manifest, ready } = await prepared(t);
	const entry = session(manifest, { verify: { op: "verified", active: `./bundles/${manifest.bundleSha256}`, files: manifest.files.length } });
	const result = await deployPreparedBundle({
		directory,
		names: ["entry.mjs"],
		connection: CONNECTION,
		ready,
		launcher: unreachableLauncher("a verified bundle must not be uploaded again"),
		session: entry,
		hostId: HOST_ID,
		generation: 1,
	});
	assert.equal(result.bundleSha256, manifest.bundleSha256);
	assert.equal(result.active, `./bundles/${manifest.bundleSha256}`);
	assert.equal(result.reused, true);
	// The round is declaration + finalize-verify only: the content was proved without a commit.
	assert.deepEqual(
		entry.writes.map((frame) => frame.op),
		["finalize-begin", "finalize-file", "finalize-verify"],
	);
});

test("a verified answer naming another bundle address is refused", async (t) => {
	const { directory, manifest, ready } = await prepared(t);
	const entry = session(manifest, { verify: { op: "verified", active: `./bundles/${"c".repeat(64)}`, files: manifest.files.length } });
	await assert.rejects(deployPreparedBundle({ directory, names: ["entry.mjs"], connection: CONNECTION, ready, launcher: unreachableLauncher("a refused reuse must not upload"), session: entry, hostId: HOST_ID, generation: 1 }), /BOOTSTRAP_ACTIVE_CONFLICT/);
});

test("a conflict is fail-closed: no upload replaces the suspicious directory", async (t) => {
	const { directory, manifest, ready } = await prepared(t);
	const entry = session(manifest, { verify: { op: "verify-miss", reason: "conflict" } });
	await assert.rejects(deployPreparedBundle({ directory, names: ["entry.mjs"], connection: CONNECTION, ready, launcher: unreachableLauncher("a conflicting bundle must not be overwritten"), session: entry, hostId: HOST_ID, generation: 1 }), /BOOTSTRAP_ACTIVE_CONFLICT/);
	assert.equal(entry.writes.at(-1).op, "abort", "the entry is asked to clean its staging, not to install over the conflict");
});

test("an absent verdict falls through to the ordinary upload and commit", async (t) => {
	const { directory, manifest, ready } = await prepared(t);
	const entry = session(manifest, {
		verify: { op: "verify-miss", reason: "absent" },
		commit: { op: "finalized", active: `./bundles/${manifest.bundleSha256}`, files: manifest.files.length },
	});
	let uploads = 0;
	const result = await deployPreparedBundle({ directory, names: ["entry.mjs"], connection: CONNECTION, ready, launcher: successfulUpload(() => (uploads += 1)), session: entry, hostId: HOST_ID, generation: 1 });
	assert.equal(uploads, 1);
	assert.notEqual(result.reused, true);
	assert.equal(result.active, `./bundles/${manifest.bundleSha256}`);
});

test("a verify round that never answers fails as unconfirmed instead of uploading blindly", async (t) => {
	const { directory, manifest, ready } = await prepared(t);
	const entry = session(manifest);
	const pending = deployPreparedBundle({ directory, names: ["entry.mjs"], connection: CONNECTION, ready, launcher: unreachableLauncher("an unconfirmed verify must not upload"), session: entry, hostId: HOST_ID, generation: 1 });
	// The declaration must be on the wire before the entry dies, otherwise there is no round to answer.
	await waitFor(() => entry.writes.some((frame) => frame.op === "finalize-verify"), "the verify round must start");
	// The entry dies without a verdict: main has no proof the directory matches, so it must not transfer.
	entry.emitExit();
	await assert.rejects(pending, /BOOTSTRAP_FINALIZE_UNCONFIRMED/);
});

test("runBootstrapVerify releases its timer on an injected deadline and reports a timeout", async () => {
	const manifest = { schemaVersion: 1, bundleSha256: "a".repeat(64), files: [] };
	const timers = {
		pending: new Map(),
		setTimeout(handler, delay) {
			const handle = { handler, delay };
			this.pending.set(handle, handle);
			return handle;
		},
		clearTimeout(handle) {
			this.pending.delete(handle);
		},
	};
	const listeners = new Set();
	const session = {
		write() {},
		onStdoutLine(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onExit: () => () => {},
	};
	// An empty manifest is refused before any frame is sent, so this also proves the guard runs first.
	await assert.rejects(runBootstrapVerify(session, manifest, { timers, timeoutMs: 1_000 }), /BUNDLE_MANIFEST_INVALID/);
	assert.deepEqual(manifest.files, []);

	const usable = { schemaVersion: 1, bundleSha256: "b".repeat(64), files: [{ name: "entry.mjs", sha256: "c".repeat(64), bytes: 4 }] };
	const pending = runBootstrapVerify(session, usable, { timers, timeoutMs: 1_000 });
	assert.equal(timers.pending.size, 1);
	for (const handle of [...timers.pending.keys()]) {
		timers.pending.delete(handle);
		handle.handler();
	}
	assert.deepEqual(JSON.parse(JSON.stringify(await pending)), { status: "timeout" });
	assert.equal(timers.pending.size, 0);
});
