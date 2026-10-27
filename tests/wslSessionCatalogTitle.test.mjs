import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
	stubs: { "../logging/sharedLogger": { getAppLogger: () => null } },
});

function summary(overrides = {}) {
	return {
		id: "/home/wsl/.pi/agent/sessions/--home-wsl--/a.jsonl",
		filePath: "/home/wsl/.pi/agent/sessions/--home-wsl--/a.jsonl",
		name: "",
		preview: "",
		updatedAt: 100,
		messageCount: 1,
		source: "pi",
		wsl: true,
		...overrides,
	};
}

test("WSL catalog title reads carry the project distro/user to the fetch port", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-wsl-catalog-title-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const calls = [];
	const catalog = new SessionCatalog(join(dir, "session-catalog.json"), {}, undefined, async (filePath, options) => {
		calls.push({ filePath, options });
		return { name: "WSL title", valid: true };
	});
	await catalog.load();
	const records = await catalog.mergeScanned("project-wsl", [summary()], { wslDistro: "Ubuntu-26.04", wslUser: "wsl" });
	assert.equal(records.length, 1);
	assert.equal(records[0].title, "WSL title");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].filePath, "/home/wsl/.pi/agent/sessions/--home-wsl--/a.jsonl");
	assert.equal(calls[0].options.wslDistro, "Ubuntu-26.04");
	assert.equal(calls[0].options.wslUser, "wsl");
});
