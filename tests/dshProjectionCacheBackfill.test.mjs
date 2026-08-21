import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * dsh-web 冷列表只读 session_projcache。PiDeck host 必须挂官方
 * session-projection-cache，并用 coldSnapshot 回写缺标题行。
 * 禁止手写 session_projcache.json。
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(repoRoot, "package.json"));
const {
	isRootSessionMeta,
	shouldBackfillProjectionTitle,
	backfillMissingProjectionTitles,
	bindProjectionCacheBackfillDeps,
	previewMissingProjectionTitles,
} = loadTsCommonJs("src/main/dsh/dshProjectionCacheBackfill.ts");

test("package.json depends on session-projection-cache so electron-builder packs it", () => {
	const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	// Keep this assertion aligned with the exact dsh release line so the test
	// catches accidental mixing of rc.8 and rc.1 packages in the host bundle.
	assert.equal(
		pkg.dependencies["@deepseek-ai/dsh-session-projection-cache"],
		"0.1.1-rc.1",
	);
});

test("session-projection-cache is resolvable from the app root", () => {
	const resolved = require.resolve("@deepseek-ai/dsh-session-projection-cache");
	assert.ok(existsSync(resolved), `missing ${resolved}`);
	const pkg = JSON.parse(
		readFileSync(require.resolve("@deepseek-ai/dsh-session-projection-cache/package.json"), "utf8"),
	);
	assert.equal(pkg.name, "@deepseek-ai/dsh-session-projection-cache");
});

test("hostEntry mounts official session-projection-cache with dsh-web config", () => {
	const src = readFileSync(join(repoRoot, "src/main/dsh/hostEntry.ts"), "utf8");
	assert.match(src, /id:\s*"session-projection-cache"/);
	assert.match(src, /name:\s*"@deepseek-ai\/dsh-session-projection-cache"/);
	assert.match(src, /writeEveryEvents:\s*200/);
	assert.match(src, /writeIntervalMs:\s*5000/);
	assert.match(src, /backfillMissingProjectionTitles/);
	assert.match(src, /bindProjectionCacheBackfillDeps/);
	assert.doesNotMatch(src, /writeFileSync\([^)]*session_projcache/);
});

test("isRootSessionMeta skips subagent / parent / delegation", () => {
	assert.equal(isRootSessionMeta({ id: "session-a" }), true);
	assert.equal(isRootSessionMeta({ id: "session-a", origin: "subagent" }), false);
	assert.equal(isRootSessionMeta({ id: "session-a", parentSession: "session-b" }), false);
	assert.equal(isRootSessionMeta({ id: "session-a", delegationDepth: 1 }), false);
	assert.equal(isRootSessionMeta({ id: "" }), false);
});

test("shouldBackfillProjectionTitle is true only when cached title is missing", () => {
	assert.equal(shouldBackfillProjectionTitle(undefined), true);
	assert.equal(shouldBackfillProjectionTitle({}), true);
	assert.equal(shouldBackfillProjectionTitle({ values: {} }), true);
	assert.equal(shouldBackfillProjectionTitle({ values: { title: "" } }), true);
	assert.equal(shouldBackfillProjectionTitle({ values: { title: "   " } }), true);
	assert.equal(shouldBackfillProjectionTitle({ values: { title: "检查PiDeck#153是否修复" } }), false);
});

test("backfill only coldSnapshots untitled root sessions", async () => {
	const called = [];
	const result = await backfillMissingProjectionTitles({
		list: async () => [
			{ id: "session-titled" },
			{ id: "session-empty-title" },
			{ id: "session-missing" },
			{ id: "session-child", parentSession: "session-titled" },
			{ id: "session-sub", origin: "subagent" },
		],
		cachedSnapshot: (meta) => {
			if (meta.id === "session-titled") return { values: { title: "真实标题" } };
			if (meta.id === "session-empty-title") return { values: { title: "  " } };
			return undefined;
		},
		coldSnapshot: async (sessionId) => {
			called.push(sessionId);
		},
	});
	assert.deepEqual(called, ["session-empty-title", "session-missing"]);
	assert.equal(result.attempted, 2);
	assert.equal(result.failed, 0);
});

test("backfill counts a failed coldSnapshot and continues", async () => {
	const called = [];
	const logs = [];
	const result = await backfillMissingProjectionTitles({
		list: async () => [{ id: "session-bad" }, { id: "session-ok" }],
		cachedSnapshot: () => undefined,
		coldSnapshot: async (sessionId) => {
			called.push(sessionId);
			if (sessionId === "session-bad") throw new Error("decode failed");
		},
		log: (message) => logs.push(message),
	});
	assert.deepEqual(called, ["session-bad", "session-ok"]);
	assert.equal(result.attempted, 2);
	assert.equal(result.failed, 1);
	assert.equal(logs.length, 1);
	assert.match(logs[0], /session-bad/);
});

test("bindProjectionCacheBackfillDeps requires official services", () => {
	assert.equal(bindProjectionCacheBackfillDeps({}), undefined);
	assert.equal(
		bindProjectionCacheBackfillDeps({ sessionPersistence: { list: async () => [] } }),
		undefined,
	);
	const deps = bindProjectionCacheBackfillDeps({
		sessionPersistence: {
			list: async () => [{ id: "session-a", extra: true }, { not: "a session" }],
		},
		sessionProjectionCache: {
			cachedSnapshot: () => ({ values: { title: 1 } }),
			coldSnapshot: async () => ({}),
		},
	});
	assert.ok(deps);
});

test("previewMissingProjectionTitles counts historical roots missing cache titles", () => {
	const { workspaceDirFor } = loadTsCommonJs("src/main/dsh/dshSessionPath.ts");
	const home = mkdtempSync(join(tmpdir(), "pideck-proj-preview-"));
	try {
		const write = (id, cwd, extra = []) => {
			const dir = join(home, "sessions", workspaceDirFor(cwd), id);
			mkdirSync(dir, { recursive: true });
			const line = [
				JSON.stringify({ type: "session", version: 0, id, createdAt: 1, cwd, delegationDepth: 0 }),
				...extra,
				"",
			].join("\n");
			writeFileSync(join(dir, "session.jsonl.zstd"), zstdCompressSync(Buffer.from(line, "utf8")));
		};
		write("session-cached", "D:\\a", [
			JSON.stringify({ type: "session/title", data: { title: "缓存已有" } }),
		]);
		write("session-logged", "D:\\b", [
			JSON.stringify({ type: "session/title", data: { title: "日志标题" } }),
		]);
		write("session-empty", "D:\\c");
		write("session-child", "D:\\b", []);
		const childDir = join(home, "sessions", workspaceDirFor("D:\\b"), "session-child");
		writeFileSync(
			join(childDir, "session.jsonl.zstd"),
			zstdCompressSync(Buffer.from(`${JSON.stringify({
				type: "session",
				version: 0,
				id: "session-child",
				createdAt: 1,
				cwd: "D:\\b",
				parentSession: "session-logged",
				delegationDepth: 0,
			})}\n`, "utf8")),
		);
		mkdirSync(join(home, "storages"), { recursive: true });
		writeFileSync(join(home, "storages", "session_projcache.json"), JSON.stringify({
			tables: {
				sessions: {
					"session-cached": { rows: { title: { val: "缓存已有" } } },
				},
			},
		}));
		const preview = previewMissingProjectionTitles(home);
		assert.equal(preview.titled, 1);
		assert.equal(preview.missing, 2);
		assert.equal(preview.samples.some((item) => item.dshSessionId === "session-logged" && item.loggedTitle === "日志标题"), true);
		assert.equal(preview.samples.some((item) => item.dshSessionId === "session-child"), false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("hostEntry routes the projection cache backfill bridge", () => {
	const src = readFileSync(join(repoRoot, "src/main/dsh/hostEntry.ts"), "utf8");
	assert.match(src, /PIDECK_PROJECTION_CACHE_BRIDGE_PATH/);
	assert.match(src, /handleProjectionCacheBridgeFetch/);
});

test("IPC and config page expose historical title backfill", () => {
	const ipc = readFileSync(join(repoRoot, "src/shared/ipc.ts"), "utf8");
	const tab = readFileSync(join(repoRoot, "src/renderer/src/config/DshConfigTab.tsx"), "utf8");
	assert.match(ipc, /dshPreviewMissingProjectionTitles/);
	assert.match(ipc, /dshBackfillProjectionTitles/);
	assert.match(tab, /backfillProjectionTitles/);
	assert.match(tab, /previewMissingProjectionTitles/);
});
