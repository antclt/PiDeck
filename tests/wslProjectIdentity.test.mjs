import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 第 11 步：项目 locator 增加可选 wslHostId/wslUser，旧记录不受影响；native 带 WSL 字段必须拒绝。
const { readProjectLocator } = loadTsCommonJs("src/shared/projectLocation.ts");
const { projectLocatorFromLegacy, projectLocatorToLegacyFields } = loadTsCommonJs("src/shared/locationAdapters.ts");
const { decodeProjectStoreSnapshot, encodeProjectStoreSnapshot } = loadTsCommonJs("src/main/projects/projectStoreCodec.ts");

const HOST = "0f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";
const project = {
	id: "p1",
	name: "app",
	lastOpenedAt: 1,
	path: "\\wsl$\Ubuntu\home\dev\app",
	environment: "wsl",
	wslDistro: "Ubuntu",
	wslUser: "dev",
	wslHostId: HOST,
};

test("local locator carries the WSL profile identity", () => {
	const locator = readProjectLocator({ kind: "local", environment: "wsl", localPath: "/home/dev/app", wslDistro: "Ubuntu", wslUser: "dev", wslHostId: HOST });
	assert.equal(locator.wslHostId, HOST);
	assert.equal(locator.wslUser, "dev");
	assert.equal(locator.wslDistro, "Ubuntu");
});

test("WSL fields on a native project or with bad values are refused", () => {
	for (const value of [
		{ kind: "local", environment: "native", localPath: "/x", wslHostId: HOST },
		{ kind: "local", environment: "wsl", localPath: "/x", wslHostId: "not-a-uuid" },
		{ kind: "local", environment: "wsl", localPath: "/x", wslUser: "1bad" },
		{ kind: "local", environment: "wsl", localPath: "/x", wslUser: 7 },
	])
		assert.equal(readProjectLocator(value), undefined, JSON.stringify(value));
});

test("codec round-trips the identity and keeps legacy records valid", () => {
	const encoded = encodeProjectStoreSnapshot([project], 1);
	const entry = encoded.projects[0];
	assert.equal(entry.locator.wslHostId, HOST);
	assert.equal("path" in entry, false);
	assert.equal("wslHostId" in entry, false);

	const decoded = decodeProjectStoreSnapshot(encoded);
	assert.equal(decoded.projects[0].wslHostId, HOST);
	assert.equal(decoded.projects[0].wslUser, "dev");

	// 旧记录（无 wslHostId）仍然可读，不要求迁移后才能启动。
	const legacy = decodeProjectStoreSnapshot({ schemaVersion: 2, revision: 1, projects: [{ id: "p2", name: "old", lastOpenedAt: 1, locator: { kind: "local", environment: "wsl", localPath: "/home/dev/old", wslDistro: "Ubuntu" } }] });
	assert.equal(legacy.projects[0].wslHostId, undefined);
	assert.equal(legacy.projects[0].wslDistro, "Ubuntu");
});

test("legacy adapters keep the profile fields", () => {
	const locator = projectLocatorFromLegacy({ path: "/home/dev/app", environment: "wsl", wslDistro: "Ubuntu", wslUser: "dev", wslHostId: HOST });
	assert.equal(projectLocatorToLegacyFields(locator).wslHostId, HOST);
});
