import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { remoteGitRepoScope, projectFilePath, repoRelativeFilePath } = loadTsCommonJs("src/main/git/RemoteGitService.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const { registerRemoteGitReadIpc } = loadTsCommonJs("src/main/ipc/remoteGitReadIpc.ts", { stubs: { electron: { ipcMain: { handle: (_channel, _fn) => undefined } } } });

const projectId = "remote-project";
const locator = { kind: "ssh", hostId: "remote-host", remotePath: "/workspace/project" };
const oid = (char) => char.repeat(40);
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * T5（v5 §10.3）：public 与 legacy 的路径分界。
 *
 * 这里钉的是**纯转换函数 + 真实注册边界**：
 * - 仓库 scope 只允许一种归一化（字符串或 ProjectFileTarget），跨项目/越界/多余字段一律拒绝；
 * - 项目相对 → 仓库内只按目录前缀严格剥离（`packages/a-other/x` 不是 `packages/a` 的文件）；
 * - 共享 `git:refs` 入口接受文件树传来的 target scope，旧远端调用（字符串）行为不变。
 */
test("仓库 scope：字符串、ProjectFileTarget 与根都有确定结果；跨项目/越界/多余字段被拒绝", () => {
	assert.equal(remoteGitRepoScope(projectId, ""), "");
	assert.equal(remoteGitRepoScope(projectId, undefined), "");
	assert.equal(remoteGitRepoScope(projectId, "packages/a"), "packages/a");
	assert.equal(remoteGitRepoScope(projectId, { projectId, relativePath: "packages/a" }), "packages/a");
	assert.equal(remoteGitRepoScope(projectId, { projectId, relativePath: "" }), "");

	for (const value of ["../outside", "/absolute", "a\\b", "packages/a/.git", "x.lock/y"]) {
		assert.throws(() => remoteGitRepoScope(projectId, value), /GIT_RESULT_INVALID/, String(value));
	}
	assert.throws(() => remoteGitRepoScope(projectId, { projectId: "other", relativePath: "packages/a" }), /GIT_RESULT_INVALID/);
	assert.throws(() => remoteGitRepoScope(projectId, { projectId, relativePath: "packages/a", extra: 1 }), /GIT_RESULT_INVALID/);
});

test("项目相对 ↔ 仓库内：严格目录前缀，不接受同名前缀或跨仓目标", () => {
	// 输出方向：仓库内 → 项目相对。
	assert.equal(projectFilePath("", "a.txt"), "a.txt");
	assert.equal(projectFilePath("packages/a", "a.txt"), "packages/a/a.txt");
	assert.equal(projectFilePath("packages/a", "sub/b.txt"), "packages/a/sub/b.txt");

	// 输入方向：项目相对 → 仓库内（helper 只认仓库内路径）。
	const target = (relativePath, owner = projectId) => ({ projectId: owner, relativePath });
	assert.equal(repoRelativeFilePath(projectId, "", target("a.txt")), "a.txt");
	assert.equal(repoRelativeFilePath(projectId, "packages/a", target("packages/a/a.txt")), "a.txt");
	assert.equal(repoRelativeFilePath(projectId, "packages/a", target("packages/a/sub/b.txt")), "sub/b.txt");

	// 同名前缀不是前缀：这两个值必须被拒绝，而不是猜到“也许用户想写 a/a.txt”。
	assert.throws(() => repoRelativeFilePath(projectId, "packages/a", target("packages/a-other/a.txt")), /GIT_RESULT_INVALID/);
	assert.throws(() => repoRelativeFilePath(projectId, "packages/a", target("packages/a")), /GIT_RESULT_INVALID/);
	assert.throws(() => repoRelativeFilePath(projectId, "packages/a", target("packages/b/a.txt")), /GIT_RESULT_INVALID/);
	// 没有前缀就是没有前缀（禁止“有前缀就剥、没前缀也当合法”）。
	assert.throws(() => repoRelativeFilePath(projectId, "packages/a", target("a.txt")), /GIT_RESULT_INVALID/);
	assert.throws(() => repoRelativeFilePath(projectId, "packages/a", target("packages/a/a.txt", "other")), /GIT_RESULT_INVALID/);
});

function fixture() {
	const handlers = new Map();
	const calls = [];
	const sender = new EventEmitter();
	sender.id = 1;
	sender.isDestroyed = () => false;
	const session = {
		async request(method, params, options) {
			calls.push({ method, params, ...(options?.repo === undefined ? {} : { repo: options.repo }) });
			options?.onRequestId?.("request-id");
			if (method === "hello") return { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.status", "git.refs"] };
			if (method === "git.status") return { status: "", head: oid("a"), branch: "main" };
			if (method === "git.refs") return { head: oid("a"), branch: "main", refs: [{ fullName: "refs/heads/main", name: "main", oid: oid("a"), kind: "branch" }] };
			throw new Error("UNEXPECTED_METHOD");
		},
		async cancel(id) {
			calls.push({ method: "cancel", id });
		},
	};
	const port = registerRemoteGitReadIpc({
		enabled: true,
		locator: (id) => (id === projectId ? locator : undefined),
		trusted: async () => true,
		service: async () => ({
			async withProjectSession(_hostId, _root, work, options) {
				assert.equal(options.requireReady, true);
				return { ok: true, value: await work(session) };
			},
			connectionFacts: () => ({ connectionId: "conn-1", state: "ready" }),
		}),
	});
	return { port, calls, sender, handlers };
}

test("共享 git:refs 接受文件树传来的 ProjectFileTarget scope；跨项目/越界在开会话前拒绝", async () => {
	const f = fixture();
	const refs = await f.port.refs({ sender: f.sender }, projectId, { projectId, relativePath: "packages/a" });
	assert.deepEqual(plain(refs), [{ name: "main", fullName: "refs/heads/main", hash: oid("a"), type: "head" }]);
	assert.equal(f.calls.at(-1).repo, "packages/a", "target scope 被归一成 helper 需要的仓库内路径");

	f.calls.length = 0;
	for (const value of [{ projectId: "other", relativePath: "packages/a" }, "../outside", "packages/a/.git"]) {
		await assert.rejects(f.port.refs({ sender: f.sender }, projectId, value), /GIT_RESULT_INVALID/);
	}
	assert.equal(f.calls.length, 0, "非法 scope 一个帧都不发");

	// 旧远端调用（字符串）行为不变，根 scope 仍是空串。
	f.calls.length = 0;
	await f.port.refs({ sender: f.sender }, projectId, "");
	assert.equal(f.calls.at(-1).repo, undefined, "根 scope 不伪造 repo 字段");
});
