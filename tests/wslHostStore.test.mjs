import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createWslHostStore, WSL_HOST_CODES } = loadTsCommonJs("src/main/wsl/WslHostStore.ts");
const emptyRefs = { referencedHostIds: async () => new Set() };

async function withStore(fn, references = emptyRefs) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-wsl-store-"));
	try {
		const store = await createWslHostStore(dir, { references });
		await fn(store, dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("add, edit and remove a WSL profile", async () => {
	await withStore(async (store, dir) => {
		const added = await store.add({ label: "Ubuntu", distro: "Ubuntu", user: "dev" });
		assert.deepEqual({ ...added }, { id: added.id, label: "Ubuntu", distro: "Ubuntu", user: "dev" });
		assert.equal((await store.list()).length, 1);

		const updated = await store.update(added.id, { label: "Ubuntu 24.04", user: "ops" });
		assert.equal(updated.label, "Ubuntu 24.04");
		assert.equal(updated.user, "ops");

		await store.remove(added.id);
		assert.equal((await store.list()).length, 0);
		const snapshot = JSON.parse(await readFile(join(dir, "wsl-hosts.json"), "utf8"));
		assert.deepEqual(snapshot.retiredHostIds, [added.id]);
	});
});

test("invalid profiles are refused", async () => {
	await withStore(async (store) => {
		for (const input of [
			{ label: "", distro: "Ubuntu", user: "dev" },
			{ label: "bad\u0007", distro: "Ubuntu", user: "dev" },
			{ label: "Ubuntu", distro: "Ubuntu 24", user: "dev" },
			{ label: "Ubuntu", distro: "Ubuntu", user: "1dev" },
		])
			assert.equal(
				await store.add(input).then(
					() => null,
					(error) => error.message,
				),
				WSL_HOST_CODES.invalid,
				JSON.stringify(input),
			);
		const added = await store.add({ label: "Ubuntu", distro: "Ubuntu", user: "dev" });
		await assert.rejects(() => store.add({ label: "Ubuntu", distro: "Debian", user: "dev" }), /WSL_HOST_LABEL_TAKEN/);
		await assert.rejects(() => store.update(added.id, { distro: "../etc" }), /WSL_HOST_INVALID/);
		await assert.rejects(() => store.update(added.id, {}), /WSL_HOST_INVALID/);
	});
});

test("a referenced profile cannot be removed; missing scans refuse removal", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-wsl-refs-"));
	try {
		const store = await createWslHostStore(dir, { references: { referencedHostIds: async () => new Set() } });
		const profile = await store.add({ label: "Ubuntu", distro: "Ubuntu", user: "dev" });
		const referenced = await createWslHostStore(dir, { references: { referencedHostIds: async () => new Set([profile.id]) } });
		await assert.rejects(() => referenced.remove(profile.id), /WSL_HOST_REFERENCED/);
		assert.equal((await referenced.list()).length, 1);

		const unscanned = await createWslHostStore(dir, {});
		await assert.rejects(() => unscanned.remove(profile.id), /WSL_HOST_REFERENCE_SCAN_INCOMPLETE/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("corrupt primary falls back to the last backup; both invalid fails closed", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-wsl-recover-"));
	try {
		const store = await createWslHostStore(dir, { references: emptyRefs });
		await store.add({ label: "Ubuntu", distro: "Ubuntu", user: "dev" });
		await store.add({ label: "Debian", distro: "Debian", user: "dev" });
		await writeFile(join(dir, "wsl-hosts.json"), "{ broken", "utf8");
		// 第二次写已生成备份：恢复后至少能看到上一份有效档案。
		assert.equal((await store.list()).length, 1);
		await writeFile(join(dir, "wsl-hosts.json.bak"), "{ also broken", "utf8");
		const broken = await createWslHostStore(dir, { references: emptyRefs });
		await assert.rejects(() => broken.list(), /WSL_HOST_STORE_INVALID/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
