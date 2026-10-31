import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createWslHostReferenceRegistry } = loadTsCommonJs("src/main/wsl/WslHostReferences.ts");
const HOST = "0f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";

async function withFiles(fn) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-wsl-ref-"));
	const paths = { projectsFile: join(dir, "projects.json"), sessionCatalogFile: join(dir, "session-catalog.json") };
	try {
		await fn(paths);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("collects direct and locator wslHostId references", async () => {
	await withFiles(async (paths) => {
		await writeFile(paths.projectsFile, JSON.stringify({ projects: [{ wslHostId: HOST }, { locator: { wslHostId: HOST } }, {}] }));
		await writeFile(paths.sessionCatalogFile, JSON.stringify({ sessions: [{ wslHostId: HOST }] }));
		const ids = await createWslHostReferenceRegistry(paths).referencedHostIds();
		assert.deepEqual([...ids], [HOST]);
	});
});

test("missing files mean no references; malformed ones fail closed", async () => {
	await withFiles(async (paths) => {
		assert.equal((await createWslHostReferenceRegistry(paths).referencedHostIds()).size, 0);
		await writeFile(paths.projectsFile, JSON.stringify({ projects: [{ wslHostId: "not-a-uuid" }] }));
		await assert.rejects(() => createWslHostReferenceRegistry(paths).referencedHostIds(), /WSL_HOST_REFERENCE_SCAN_INCOMPLETE/);
		await writeFile(paths.projectsFile, "{ broken");
		await assert.rejects(() => createWslHostReferenceRegistry(paths).referencedHostIds(), /WSL_HOST_REFERENCE_SCAN_INCOMPLETE/);
	});
});
