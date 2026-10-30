import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * WSL 档案变更失效端口（task-14）：update/remove 成功后通知装配层失效资源管理器池。
 *
 * 为什么：池在每次请求时重读档案，但「档案被改名/移除」应该立刻生效，而不是等下一次访问；
 * 回调是副作用，失败不能把已成功的档案写入变成错误响应。
 */

function register(dir, hooks = {}) {
	const handlers = new Map();
	const { registerWslHostIpc } = loadTsCommonJs("src/main/ipc/wslHostIpc.ts", {
		stubs: {
			electron: {
				ipcMain: {
					handle(channel, handler) {
						handlers.set(channel, handler);
					},
				},
			},
		},
	});
	registerWslHostIpc({ userDataDir: dir, references: { referencedHostIds: async () => new Set() }, ...hooks });
	return handlers;
}

async function withTempStore(run) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-wsl-hook-"));
	try {
		await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("update 成功后回调收到 hostId；remove 成功后同样收到", async () => {
	await withTempStore(async (dir) => {
		const changed = [];
		const handlers = register(dir, { onProfileChanged: (hostId) => changed.push(hostId) });
		const added = await handlers.get("remote:wsl-hosts-add")({}, { label: "Ubuntu", distro: "Ubuntu", user: "dev" });
		assert.equal(added.ok, true);
		// add 不触发：新 id 不可能已有缓存（退役 id 永不复用）。
		assert.deepEqual(changed, []);

		const updated = await handlers.get("remote:wsl-hosts-update")({}, added.host.id, { distro: "Ubuntu-24.04" });
		assert.equal(updated.ok, true);
		assert.deepEqual(changed, [added.host.id]);

		const removed = await handlers.get("remote:wsl-hosts-remove")({}, added.host.id);
		assert.equal(removed.ok, true);
		assert.deepEqual(changed, [added.host.id, added.host.id]);
	});
});

test("回调抛错不影响成功的写入响应（失效通知是副作用，不是写入结果）", async () => {
	await withTempStore(async (dir) => {
		const handlers = register(dir, {
			onProfileChanged: () => {
				throw new Error("invalidate exploded");
			},
		});
		const added = await handlers.get("remote:wsl-hosts-add")({}, { label: "Ubuntu", distro: "Ubuntu", user: "dev" });
		const updated = await handlers.get("remote:wsl-hosts-update")({}, added.host.id, { label: "Renamed" });
		assert.deepEqual(JSON.parse(JSON.stringify(updated)), { ok: true, host: { id: added.host.id, label: "Renamed", distro: "Ubuntu", user: "dev" } });
		const removed = await handlers.get("remote:wsl-hosts-remove")({}, added.host.id);
		assert.equal(removed.ok, true);
	});
});

test("失败的 update（id 不存在）不触发回调", async () => {
	await withTempStore(async (dir) => {
		const changed = [];
		const handlers = register(dir, { onProfileChanged: (hostId) => changed.push(hostId) });
		const updated = await handlers.get("remote:wsl-hosts-update")({}, "11111111-1111-4111-8111-111111111111", { label: "Nope" });
		assert.equal(updated.ok, false);
		assert.deepEqual(changed, []);
	});
});
