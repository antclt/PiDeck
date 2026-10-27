import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * F1（连接层）：取消属于某一次 attempt，而不是排在它后面。
 *
 * 真机行为不在这里：本文件只用注入的 ports 与真实 `RemoteHostConnectionService`，检验「取消立即结算、
 * 迟到的 attempt 不发布任何东西、A 主机的取消不影响 B」这三个可离线判定的性质。
 */
const { createRemoteHostConnectionService } = loadTsCommonJs("src/main/remote/RemoteHostConnectionService.ts");
const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");

const HOST_ID = "b145de8c-6330-45be-8752-f20e8e270150";
const OTHER_HOST_ID = "0e0f18ba-6f0e-4bd8-9f6c-1c8f6f2a7d31";
const CLIENT = { sshPath: "/usr/bin/ssh", scpPath: "/usr/bin/scp", env: { PATH: "/usr/bin" }, run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };

function profile(hostId) {
	const at = "2026-01-01T00:00:00.000Z";
	return { id: hostId, label: `host ${hostId.slice(0, 8)}`, sshHost: "10.81.2.15", user: "deploy", port: 22, connectTimeoutMs: 10_000, createdAt: at, updatedAt: at };
}

async function writeStore(userDataDir, revision, entries = []) {
	await writeFile(join(userDataDir, "remote-hosts.json"), JSON.stringify({ schemaVersion: 1, revision, profiles: entries.map(profile), retiredHostIds: [] }));
	const state = (await RemoteHostStore.open(userDataDir)).getSnapshot();
	assert.deepEqual({ revision: state.revision, status: state.status }, { revision, status: "ready" }, "the fixture store must be accepted");
}

async function withUserData(run) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-remote-cancel-"));
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Ports with a controllable bootstrap; every other port keeps the production shape minus real I/O. */
function fakePorts(bootstrap) {
	const calls = { bootstrap: [], createManager: [], manager: [] };
	const ports = {
		calls,
		bootstrap: async (input) => {
			calls.bootstrap.push(input);
			return bootstrap(input);
		},
		resolveNode: async () => ({ nodePath: "/usr/bin/node", version: "v22.0.0", probed: 1 }),
		createSentinel: () => "sentinel00000001",
		createNonce: () => `nonce-${String(calls.bootstrap.length + 1).padStart(12, "0")}`,
		createManager: (input) => {
			calls.createManager.push(input);
			const manager = {
				state: "disconnected",
				latched: false,
				connected: [],
				getState(hostId) {
					return { hostId, generation: 1, state: manager.state, attempts: 0, lastCode: "SSH_CONNECTION_READY", latched: manager.latched };
				},
				getHome: () => "/home/remote",
				async connect(hostId) {
					manager.connected.push(hostId);
					manager.state = "ready";
					return manager.getState(hostId);
				},
				async retry(hostId) {
					manager.state = "ready";
					return manager.getState(hostId);
				},
				async disconnect(hostId) {
					manager.state = "disconnected";
					void hostId;
				},
				async dispose() {},
				listDiagnostics: () => [],
			};
			calls.manager.push(manager);
			return manager;
		},
		verifyRoot: async ({ userPath }) => ({ canonicalPath: userPath }),
		deployExtensions: async () => assert.fail("no extension deployment in these cases"),
	};
	return ports;
}

const RESULT = { bundleSha256: "a".repeat(64), deployRoot: "/home/remote/.pideck/remote-host", active: `/home/remote/.pideck/remote-host/bundles/${"a".repeat(64)}` };

test("a disconnect cancels an in-flight bootstrap instead of waiting for its budget", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 3, [HOST_ID]);
		let aborted = false;
		let bootstrapSettled = false;
		const ports = fakePorts((input) =>
			new Promise((resolve, reject) => {
				// The production bootstrap observes the same signal: an abort settles ready/upload/finalize.
				input.signal?.addEventListener(
					"abort",
					() => {
						aborted = true;
						assert.equal(bootstrapSettled, false, "the cancel must land before the bootstrap finished");
						reject(new Error("BOOTSTRAP_ABORTED"));
					},
					{ once: true },
				);
				void resolve;
			}).finally(() => {
				bootstrapSettled = true;
			}),
		);
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });
		try {
			const connecting = service.connect(HOST_ID);
			// Let the attempt reach the bootstrap before the user cancels.
			while (ports.calls.bootstrap.length === 0) await new Promise((resolve) => setImmediate(resolve));
			assert.equal(aborted, false);
			await service.disconnect(HOST_ID, "shutdown");
			assert.deepEqual(JSON.parse(JSON.stringify(await connecting)), { ok: false, hostId: HOST_ID, code: "SSH_HOST_DISCONNECTED" });
			assert.equal(aborted, true, "disconnect must abort the attempt that owns the host lock");
			assert.equal(ports.calls.createManager.length, 0, "a cancelled attempt must not build a session");
		} finally {
			await service.dispose();
		}
	});
});

test("a late bootstrap continuation of a cancelled attempt publishes nothing", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 3, [HOST_ID]);
		let finishBootstrap;
		let attempts = 0;
		const ports = fakePorts(() => {
			attempts += 1;
			// The first attempt is suspended on purpose (worst case: the transport answers after the cancel);
			// the retry after the disconnect is an ordinary, immediately successful bootstrap.
			if (attempts > 1) return Promise.resolve(RESULT);
			return new Promise((resolve) => {
				finishBootstrap = () => resolve(RESULT);
			});
		});
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });
		try {
			const connecting = service.connect(HOST_ID);
			while (ports.calls.bootstrap.length === 0) await new Promise((resolve) => setImmediate(resolve));
			const disconnecting = service.disconnect(HOST_ID, "shutdown");
			finishBootstrap();
			const [result] = await Promise.all([connecting, disconnecting]);
			assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, hostId: HOST_ID, code: "SSH_HOST_DISCONNECTED" });
			assert.equal(ports.calls.createManager.length, 0, "a cancelled attempt must never publish a manager");
			// The next explicit connect starts a fresh attempt with a fresh bootstrap and nonce.
			const reconnected = await service.connect(HOST_ID);
			assert.equal(reconnected.ok, true, JSON.stringify(reconnected));
			assert.equal(ports.calls.bootstrap.length, 2);
			assert.notEqual(ports.calls.bootstrap[0].nonce, ports.calls.bootstrap[1].nonce);
			assert.deepEqual(
				ports.calls.bootstrap.map((call) => call.generation),
				[1, 2],
			);
		} finally {
			await service.dispose();
		}
	});
});

test("cancelling one host never touches another host's attempt", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 3, [HOST_ID, OTHER_HOST_ID]);
		const releases = new Map();
		const ports = fakePorts(
			(input) =>
				new Promise((resolve, reject) => {
					releases.set(input.hostId, () => resolve(RESULT));
					input.signal?.addEventListener("abort", () => reject(new Error("BOOTSTRAP_ABORTED")), { once: true });
				}),
		);
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });
		try {
			const first = service.connect(HOST_ID);
			const second = service.connect(OTHER_HOST_ID);
			while (!releases.has(HOST_ID) || !releases.has(OTHER_HOST_ID)) await new Promise((resolve) => setImmediate(resolve));
			await service.disconnect(HOST_ID, "shutdown");
			releases.get(OTHER_HOST_ID)();
			const [cancelled, survivor] = await Promise.all([first, second]);
			assert.equal(cancelled.ok, false);
			assert.equal(cancelled.code, "SSH_HOST_DISCONNECTED");
			assert.equal(survivor.ok, true, JSON.stringify(survivor));
			assert.equal(ports.calls.createManager.length, 1);
			assert.equal(ports.calls.createManager[0].helperSession.deployRoot, RESULT.deployRoot);
		} finally {
			await service.dispose();
		}
	});
});

test("dispose aborts an in-flight bootstrap instead of waiting for it", async () => {
	await withUserData(async (userDataDir) => {
		await writeStore(userDataDir, 3, [HOST_ID]);
		const ports = fakePorts(
			(input) =>
				new Promise((_resolve, reject) => {
					input.signal?.addEventListener("abort", () => reject(new Error("BOOTSTRAP_ABORTED")), { once: true });
				}),
		);
		const service = createRemoteHostConnectionService({ userDataDir, client: CLIENT, nodePath: "/usr/bin/node", ports });
		const connecting = service.connect(HOST_ID);
		while (ports.calls.bootstrap.length === 0) await new Promise((resolve) => setImmediate(resolve));
		await service.dispose();
		const result = await connecting;
		assert.equal(result.ok, false);
		assert.equal(result.code, "REMOTE_CONNECTION_SERVICE_DISPOSED");
		assert.equal(ports.calls.createManager.length, 0);
	});
});
