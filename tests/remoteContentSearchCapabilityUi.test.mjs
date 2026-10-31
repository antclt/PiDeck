import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远端内容搜索的渲染层能力判定（W2）。
 *
 * 唯一判据是连接 hello 的 capabilities：新 helper 声明 fs.searchContent 才显示内容分区；旧 helper 或缺省
 * 一律判为不支持并继续"仅文件名"提示。WSL 走宿主 UNC、索引根为空，永远不支持；本机保持既有行为。
 */

const { projectSupportsContentSearch, remoteCapabilitiesAllowContentSearch, shouldRunRemoteContentSearch, shouldShowFileNameOnlyHint, REMOTE_CONTENT_SEARCH_CAPABILITY } = loadTsCommonJs("src/renderer/src/utils/fileSearchCapability.ts");
const { readRootStatusResponse } = loadTsCommonJs("src/renderer/src/components/sidebar/remoteProjectStatusState.ts");

const REMOTE_PROJECT = { id: "r", name: "R", lastOpenedAt: 1, locator: { kind: "ssh", hostId: "11111111-1111-4111-8111-111111111111", remotePath: "/srv/app" } };
const WSL_PROJECT = { id: "w", name: "W", lastOpenedAt: 1, path: "/home/u/w", environment: "wsl" };
const LOCAL_PROJECT = { id: "l", name: "L", lastOpenedAt: 1, path: "D:/p", environment: "windows" };

test("the capability name is the helper wire vocabulary", () => {
	assert.equal(REMOTE_CONTENT_SEARCH_CAPABILITY, "fs.searchContent");
});

test("a remote project supports content search only when hello declared fs.searchContent", () => {
	assert.equal(projectSupportsContentSearch(REMOTE_PROJECT, ["fs.stat", "fs.searchContent"]), true);
	assert.equal(projectSupportsContentSearch(REMOTE_PROJECT, ["fs.stat"]), false, "an old helper must not be reported as capable");
	assert.equal(projectSupportsContentSearch(REMOTE_PROJECT), false, "absent capabilities mean unknown/unsupported");
	assert.equal(projectSupportsContentSearch(REMOTE_PROJECT, null), false);
	assert.equal(projectSupportsContentSearch(REMOTE_PROJECT, []), false);
	// A near-miss name never counts: the check is exact.
	assert.equal(remoteCapabilitiesAllowContentSearch(["fs.searchContent2", "searchContent"]), false);
});

test("local and WSL keep their existing capability boundary", () => {
	assert.equal(projectSupportsContentSearch(LOCAL_PROJECT, ["fs.searchContent"]), true);
	assert.equal(projectSupportsContentSearch(WSL_PROJECT, ["fs.searchContent"]), false, "WSL content index roots are intentionally empty");
	assert.equal(projectSupportsContentSearch(undefined, ["fs.searchContent"]), true, "no project info keeps the previous behaviour");
});

test("the name-only hint needs both an unsupported location and a non-empty query", () => {
	assert.equal(shouldShowFileNameOnlyHint({ contentSearchSupported: false, query: "needle" }), true);
	assert.equal(shouldShowFileNameOnlyHint({ contentSearchSupported: false, query: "   " }), false);
	assert.equal(shouldShowFileNameOnlyHint({ contentSearchSupported: true, query: "needle" }), false);
});

test("no content-search IPC is attempted for an old helper or a too-short query", () => {
	// The fallback asserted here is the renderer half of the old-helper path: unsupported means no call at all,
	// not a call that is expected to fail.
	assert.equal(shouldRunRemoteContentSearch(false, "needle"), false);
	assert.equal(shouldRunRemoteContentSearch(false, "a"), false);
	assert.equal(shouldRunRemoteContentSearch(true, "a"), false, "one character is below the shared minimum length");
	assert.equal(shouldRunRemoteContentSearch(true, "  needle  "), true);
});

test("rootStatus carries the hello capability list and rejects malformed lists as unknown", () => {
	const capable = readRootStatusResponse({ ok: true, status: "ok", helperCapabilities: ["echo", "fs.searchContent"] });
	assert.deepEqual(plain(capable.helperCapabilities), ["echo", "fs.searchContent"]);
	assert.equal(remoteCapabilitiesAllowContentSearch(capable.helperCapabilities), true);

	const oldHelper = readRootStatusResponse({ ok: true, status: "ok", helperCapabilities: ["echo", "fs.stat"] });
	assert.equal(remoteCapabilitiesAllowContentSearch(oldHelper.helperCapabilities), false);

	const absent = readRootStatusResponse({ ok: true, status: "ok" });
	assert.equal(absent.helperCapabilities, null, "absent capabilities are unknown, never guessed");

	const malformed = readRootStatusResponse({ ok: true, status: "ok", helperCapabilities: ["echo", 7] });
	assert.equal(malformed.helperCapabilities, null, "one malformed entry makes the whole list unknown");
	assert.equal(malformed.status, "ok", "the capability diagnostic never degrades the root status");

	const notArray = readRootStatusResponse({ ok: true, status: "needs-attention", code: "REMOTE_PROJECT_ROOT_DRIFTED", helperCapabilities: "fs.searchContent" });
	assert.equal(notArray.helperCapabilities, null);
	assert.equal(notArray.status, "needs-attention");
});

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}
