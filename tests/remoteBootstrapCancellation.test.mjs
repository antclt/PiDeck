import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * F1：取消必须真正到达部署与进程边界（docs/remote-functional-optimization-plan.md §3 F1）。
 *
 * 这些用例只用真实生产模块 + 注入的 launcher/session，不启动 ssh：它们检验的是「取消后等待立即结束、
 * 不再进入后续阶段、进程被停止」这条边界，而不检验真机行为（真机由 e2e 与 F5 台账负责）。
 */
const { runPreparedBootstrap } = loadTsCommonJs("src/main/remote/RemoteBootstrapSession.ts");
const { deployPreparedBundle, frozenHelperBundleManifest } = loadTsCommonJs("src/main/remote/RemoteBootstrapDeployment.ts");
const { buildBundleManifest, observeBundleFiles } = loadTsCommonJs("src/main/remote/RemoteBootstrapUpload.ts");

const HOST_ID = "b145de8c-6330-45be-8752-f20e8e270150";
const NONCE = "abc12345678901234567";
const SSH = { executable: "/usr/bin/ssh", args: ["-o", `HostKeyAlias=pideck-${HOST_ID}`, "-o", "BatchMode=yes"], env: { PATH: "/usr/bin" }, destination: "10.81.2.15", openSshVersion: "OpenSSH_9.5p1" };
const SCP = { ...SSH, executable: "/usr/bin/scp" };
const CONNECTION = { executable: SCP.executable, destination: SSH.destination, args: SCP.args, env: SCP.env, openSshVersion: SCP.openSshVersion };

/** A bootstrap entry session: frames are only emitted when a test asks for them. */
function session({ answerReady = true, bundleSha256, finalize = "silent" } = {}) {
	const stdout = new Set();
	const exits = new Set();
	const written = [];
	const stopped = [];
	const emit = (frame) => {
		for (const listener of [...stdout]) listener(JSON.stringify({ v: 1, ...frame }));
	};
	const readyFrame = { op: "ready", protocolVersion: 1, bundleSha256, nonce: NONCE, deployRoot: "/home/test/.pideck/remote-host", staging: `.staging-${NONCE}`, stagingMode: "0700" };
	return {
		written,
		stopped,
		emit,
		onStdoutLine(listener) {
			stdout.add(listener);
			if (answerReady)
				queueMicrotask(() => {
					if (stdout.has(listener)) emit(readyFrame);
				});
			return () => stdout.delete(listener);
		},
		onExit(listener) {
			exits.add(listener);
			return () => exits.delete(listener);
		},
		write(line) {
			const frame = JSON.parse(line);
			written.push(frame);
			// The reuse check (F3) is asked before any upload; these cases model a host without the bundle.
			if (frame.op === "finalize-verify") queueMicrotask(() => emit({ op: "verify-miss", reason: "absent" }));
			if (finalize === "succeed" && frame.op === "finalize-commit") queueMicrotask(() => emit({ op: "finalized", active: `./bundles/${bundleSha256}`, files: frameCount(written) }));
		},
		async stop(reason) {
			stopped.push(reason);
		},
	};
}

function frameCount(written) {
	const begin = written.find((frame) => frame.op === "finalize-begin");
	return begin === undefined ? 0 : written.filter((frame) => frame.op === "finalize-file").length;
}

/** An scp process that never reports exit until the test stops it, which is what a slow upload looks like. */
function hangingUpload() {
	const exits = new Set();
	return {
		pid: 4321,
		stopped: [],
		onExit(listener) {
			exits.add(listener);
			return () => exits.delete(listener);
		},
		onStdoutLine: () => () => {},
		onStderrLine: () => () => {},
		write() {
			assert.fail("scp must not receive stdin");
		},
		stop(reason) {
			this.stopped.push(reason);
			for (const listener of [...exits]) listener({ kind: "stopped", code: null, signal: null });
			return Promise.resolve();
		},
	};
}

function prepareInput(overrides = {}) {
	const manifest = frozenHelperBundleManifest();
	const entry = session({ bundleSha256: manifest.bundleSha256, ...overrides.session });
	const starts = [];
	const launcher = {
		async start(request) {
			starts.push(request);
			return request.invocation.executable === SCP.executable ? (overrides.upload ?? hangingUpload()) : entry;
		},
	};
	const input = {
		hostId: HOST_ID,
		generation: 1,
		nonce: NONCE,
		expectedBundleSha256: manifest.bundleSha256,
		sshConnection: SSH,
		scpConnection: SCP,
		launcher,
		...overrides.input,
	};
	return { manifest, entry, starts, input, launcher };
}

test("a cancel while ready is pending settles without waiting for the entry deadline", async () => {
	const { entry, starts, input } = prepareInput({ session: { answerReady: false } });
	const controller = new AbortController();
	const pending = runPreparedBootstrap({ ...input, signal: controller.signal });
	controller.abort();
	await assert.rejects(pending, /BOOTSTRAP_ABORTED/);
	assert.deepEqual(entry.stopped, ["abort"], "the entry process must be stopped on cancel");
	assert.equal(starts.length, 1, "no upload may start after a cancel");
	assert.deepEqual(entry.written, [], "nothing may be finalized after a cancel");
});

/** Bounded poll with a wall-clock deadline (turn counts are not a time bound in a parallel test run). */
async function waitFor(predicate, message) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail(message);
}

test("a cancel during the upload stops that scp process and never runs finalize", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-cancel-deploy-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, "entry.mjs"), "original bytes\n");
	const manifest = buildBundleManifest(await observeBundleFiles(directory, ["entry.mjs"]));
	const entry = session({ bundleSha256: manifest.bundleSha256 });
	const upload = hangingUpload();
	const controller = new AbortController();
	let started = false;
	let snapshotDirectory;
	const launcher = {
		async start(request) {
			started = true;
			snapshotDirectory = request.invocation.cwd;
			return upload;
		},
	};
	const ready = { op: "ready", protocolVersion: 1, bundleSha256: manifest.bundleSha256, nonce: NONCE, deployRoot: "/home/test/.pideck/remote-host", staging: `.staging-${NONCE}`, stagingMode: "0700" };
	const pending = deployPreparedBundle({ directory, names: ["entry.mjs"], connection: CONNECTION, ready, launcher, session: entry, hostId: HOST_ID, generation: 1, signal: controller.signal });
	await waitFor(() => started, "the upload must start before the cancel is observable");
	controller.abort();
	await assert.rejects(pending, /BOOTSTRAP_ABORTED/);
	assert.deepEqual(upload.stopped, ["abort"], "the upload process belongs to this attempt and must be stopped");
	// The verify round (and its `absent` answer) ran before the upload; no commit may follow the cancelled transfer.
	assert.equal(
		entry.written.some((frame) => frame.op === "finalize-commit"),
		false,
		"no finalize frame may follow a cancelled upload",
	);
	assert.equal(entry.written.at(-1).op, "abort", "only the staging cleanup frame follows a cancelled upload");
	await assert.rejects(lstat(snapshotDirectory), { code: "ENOENT" });
});

test("a cancel after the finalize commit reports unconfirmed instead of claiming a rollback", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-cancel-finalize-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, "entry.mjs"), "original bytes\n");
	const manifest = buildBundleManifest(await observeBundleFiles(directory, ["entry.mjs"]));
	const entry = session({ bundleSha256: manifest.bundleSha256 });
	const controller = new AbortController();
	const launcher = {
		async start() {
			const exits = new Set();
			const handle = {
				pid: 55,
				onExit(listener) {
					exits.add(listener);
					queueMicrotask(() => listener({ kind: "exited", code: 0, signal: null }));
					return () => exits.delete(listener);
				},
				onStdoutLine: () => () => {},
				onStderrLine: () => () => {},
				write() {},
				async stop() {},
			};
			return handle;
		},
	};
	const ready = { op: "ready", protocolVersion: 1, bundleSha256: manifest.bundleSha256, nonce: NONCE, deployRoot: "/home/test/.pideck/remote-host", staging: `.staging-${NONCE}`, stagingMode: "0700" };
	const pending = deployPreparedBundle({ directory, names: ["entry.mjs"], connection: CONNECTION, ready, launcher, session: entry, hostId: HOST_ID, generation: 1, signal: controller.signal });
	// Let the upload exit and every finalize frame (commit included) leave before the cancel lands.
	await waitFor(() => entry.written.some((frame) => frame.op === "finalize-commit"), "the commit must already be on the wire");
	controller.abort();
	await assert.rejects(pending, /BOOTSTRAP_FINALIZE_UNCONFIRMED/);
	assert.equal(entry.written.at(-1).op, "abort", "a cleanup request may follow, but never a claim that the commit was undone");
});

test("a cancel before the entry starts never spawns a process", async () => {
	const { starts, input } = prepareInput();
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(runPreparedBootstrap({ ...input, signal: controller.signal }), /BOOTSTRAP_ABORTED/);
	assert.equal(starts.length, 0);
});

test("an aborted node discovery stops probing further PATH candidates", async () => {
	const controller = new AbortController();
	const probes = [];
	const client = {
		sshPath: SSH.executable,
		scpPath: SCP.executable,
		env: SSH.env,
		async run() {
			probes.push("run");
			// The PATH probe is the only remote command of a cancelled attempt.
			controller.abort();
			return { exitCode: 0, stdout: "candidate-a\ncandidate-b\n" };
		},
	};
	const module = loadTsCommonJs("src/main/remote/RemoteBootstrapSession.ts", {
		stubs: {
			"./SshVerifiedConnection": {
				async buildPinnedSshInvocation() {
					return SSH;
				},
			},
		},
	});
	await assert.rejects(module.resolveRemoteNodeExecutable({ userDataDir: "/ignored", hostId: HOST_ID, client, sentinel: "sentinel", signal: controller.signal }), /BOOTSTRAP_ABORTED/);
	assert.deepEqual(probes, ["run"], "the cancelled attempt may not spend one probe per PATH candidate");
});
