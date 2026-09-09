import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AutomationStore } = loadTsCommonJs("src/main/automation/AutomationStore.ts");

function jsonClone(value) {
	return JSON.parse(JSON.stringify(value));
}

test("AutomationStore lifecycle: CRUD, recovery of interrupted runs, and snapshot", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-automation-store-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		const initialSnapshot = await store.load(1_000);
		assert.equal(initialSnapshot.tasks.length, 0);
		assert.equal(initialSnapshot.runs.length, 0);

		const task = await store.createTask({
			name: "Nightly Audit",
			projectId: "project-1",
			prompt: "Run project tests",
			schedule: { type: "cron", expression: "0 2 * * *" },
		}, 1_000);

		assert.equal(task.name, "Nightly Audit");
		assert.equal(task.enabled, true);

		const run = await store.createRun({
			task,
			trigger: "schedule",
			scheduledFor: 1_200,
			status: "running",
		}, 1_200);

		assert.equal(run.status, "running");

		// Simulate process restart while run is running
		const reloadedStore = new AutomationStore(storePath);
		const snapshotAfterRestart = await reloadedStore.load(2_000);
		assert.equal(snapshotAfterRestart.tasks.length, 1);
		assert.equal(snapshotAfterRestart.runs.length, 1);
		assert.equal(snapshotAfterRestart.runs[0].status, "interrupted");
		assert.match(snapshotAfterRestart.runs[0].error, /stopped before/);

		// Update task
		const updated = await reloadedStore.updateTask(task.id, {
			name: "Nightly Audit Updated",
			enabled: false,
		}, 2_500);
		assert.equal(updated.name, "Nightly Audit Updated");
		assert.equal(updated.enabled, false);

		// Delete task
		const deleted = await reloadedStore.deleteTask(task.id);
		assert.equal(deleted, true);
		assert.equal(reloadedStore.listTasks().length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
