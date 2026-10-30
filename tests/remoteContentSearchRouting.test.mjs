import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * files:search-content 的远端路由（W2）。
 *
 * 这条 handler 是渲染层唯一的「内容搜索」入口。断言的不是 helper 协议（reader/真机测试管那里），而是
 * 路由本身：远端项目只经注入的 remoteFiles.searchContent；旧 helper 的能力回退返回 null（= 仅文件名），
 * 未装配时同样 null，且本地/WSL 路径永远不会误走远端。
 */

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

const REMOTE_PROJECT = { id: "remote-1", name: "Remote", lastOpenedAt: 0, locator: { kind: "ssh", hostId: "host-1", remotePath: "/srv/app" } };
const WSL_PROJECT = { id: "wsl-1", name: "WSL", path: "/home/dev/app", environment: "wsl", lastOpenedAt: 0 };

function createFilesIpc(options = {}) {
	const handlers = new Map();
	const electron = {
		app: {},
		dialog: {},
		ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
		shell: { openPath: async () => "", showItemInFolder: () => undefined },
	};
	const { registerFilesIpc } = loadTsCommonJs("src/main/ipc/filesIpc.ts", { stubs: { electron } });
	const projects = new Map([
		[REMOTE_PROJECT.id, REMOTE_PROJECT],
		[WSL_PROJECT.id, WSL_PROJECT],
	]);
	const calls = [];
	registerFilesIpc({
		fileSystemService: {
			listTree: async () => [],
			searchNames: async () => [],
			create: async () => "",
			delete: async () => undefined,
			rename: async () => "",
		},
		projectStore: { get: (id) => projects.get(id) },
		settingsStore: { get: () => ({ wslEnabled: true, wslDistro: "Ubuntu-26.04" }) },
		getFileIndexService: () => null,
		appLogger: { info: async () => undefined, error: async () => undefined },
		openExternalUrl: async () => undefined,
		...(options.remoteFiles === undefined
			? {}
			: {
					remoteFiles: {
						directoryPage: async () => ({ ok: false, code: "UNUSED" }),
						pathsExist: async () => ({ ok: false, code: "UNUSED" }),
						...(options.remoteFiles === "no-search"
							? {}
							: {
									searchContent: async (projectId, query) => {
										calls.push({ projectId, query });
										return options.remoteFiles;
									},
								}),
					},
				}),
	});
	const handler = handlers.get(ipcChannels.filesSearchContent);
	assert.ok(handler, "files:search-content must be registered");
	return { handler, calls };
}

test("a capable remote project returns the remote content result unchanged", async () => {
	const value = { hits: [{ name: "main.ts", path: "src/main.ts", relativePath: "src/main.ts", line: 2, column: 4, snippet: "needle" }], matchedFiles: 1, scannedFiles: 3, scannedBytes: 256, truncated: false };
	const { handler, calls } = createFilesIpc({ remoteFiles: { ok: true, value } });
	assert.deepEqual(await handler({}, REMOTE_PROJECT.id, "needle"), value);
	assert.deepEqual(calls, [{ projectId: REMOTE_PROJECT.id, query: "needle" }]);
});

test("an old helper (capability missing) answers null: name-only fallback, never an error", async () => {
	const { handler, calls } = createFilesIpc({ remoteFiles: { ok: true, value: null } });
	assert.equal(await handler({}, REMOTE_PROJECT.id, "needle"), null);
	assert.equal(calls.length, 1, "the route still asks main; the capability check happens behind it");
});

test("a remote read failure collapses to null instead of throwing across IPC", async () => {
	const { handler } = createFilesIpc({ remoteFiles: { ok: false, code: "SSH_HOST_NOT_READY" } });
	assert.equal(await handler({}, REMOTE_PROJECT.id, "needle"), null);
});

test("an assembly without the remote port still answers null", async () => {
	const { handler } = createFilesIpc({ remoteFiles: "no-search" });
	assert.equal(await handler({}, REMOTE_PROJECT.id, "needle"), null);
	const missing = createFilesIpc();
	assert.equal(await missing.handler({}, REMOTE_PROJECT.id, "needle"), null);
});

test("local/WSL content search never routes through the remote port", async () => {
	const { handler, calls } = createFilesIpc({ remoteFiles: { ok: true, value: { hits: [], matchedFiles: 0, scannedFiles: 0, scannedBytes: 0, truncated: false } } });
	// WSL: the host-side index root is intentionally empty, so the local path answers null.
	assert.equal(await handler({}, WSL_PROJECT.id, "needle"), null);
	// Unknown project and invalid query keep the same validation the local path already had.
	await assert.rejects(handler({}, "missing", "needle"), /PROJECT_NOT_FOUND/);
	await assert.rejects(handler({}, REMOTE_PROJECT.id, "   "), /Invalid search query/);
	assert.equal(calls.length, 0, "no remote request may be made for a non-remote project or an invalid call");
});
