/**
 * 工作区面板服务缝（Phase A）的行为测试。
 *
 * 断言的是“provider 把调用路由到哪条现成通道”，不是源码形状：
 * - 读面（目录页/搜索/Git 历史/仓库/refs/compare）已经位置无关，本地与远端必须走同一通道；
 * - 写面（远端文件）必须带 version，绝不静默省略；
 * - 远端 Git 写在 Phase C 之前必须显式 unsupported，不能假装成功。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createProjectServices, LOCAL_PROJECT_SERVICE_CAPABILITIES, REMOTE_PROJECT_SERVICE_CAPABILITIES, PROJECT_SERVICE_CODES, ProjectServiceError } = loadTsCommonJs("src/renderer/src/services/projectServices.ts");

const localProject = { id: "p1", name: "p1", lastOpenedAt: 0, path: "C:/p1" };
const remoteProject = { id: "p2", name: "p2", lastOpenedAt: 0, locator: { kind: "ssh", hostId: "h1", remotePath: "/srv/p2" } };

function makeApi() {
	const calls = [];
	const record = (name, args) => {
		calls.push({ name, args });
	};
	const api = {
		files: {
			directoryPage: async (target, options) => {
				record("files.directoryPage", [target, options]);
				return { ok: true, value: { entries: [], truncated: false, revision: 1, generation: "g" } };
			},
			search: async (projectId, query) => {
				record("files.search", [projectId, query]);
				return [];
			},
			searchContent: async (projectId, query) => {
				record("files.searchContent", [projectId, query]);
				return null;
			},
			readContent: async (target) => {
				record("files.readContent", [target]);
				return "local-content";
			},
			writeContent: async (target, content) => {
				record("files.writeContent", [target, content]);
			},
			stat: async (target) => {
				record("files.stat", [target]);
				return { exists: true, isDirectory: false };
			},
			create: async (parent, name, type) => {
				record("files.create", [parent, name, type]);
			},
			rename: async (target, newName) => {
				record("files.rename", [target, newName]);
			},
			delete: async (target) => {
				record("files.delete", [target]);
			},
			open: async (target) => {
				record("files.open", [target]);
			},
			showInFolder: async (target) => {
				record("files.showInFolder", [target]);
			},
		},
		git: {
			status: async (projectId, repoPath) => {
				record("git.status", [projectId, repoPath]);
				return { merge: [], index: [], workingTree: [], untracked: [] };
			},
			historyPage: async (projectId, options, repoPath) => {
				record("git.historyPage", [projectId, options, repoPath]);
				return { ok: true, value: { commits: [], hasMore: false } };
			},
			repositoryList: async (projectId) => {
				record("git.repositoryList", [projectId]);
				return { ok: true, value: { repos: [], truncated: false, revision: 1, generation: "g" } };
			},
			refs: async (projectId, repoPath) => {
				record("git.refs", [projectId, repoPath]);
				return [];
			},
			compareRefs: async (projectId, base, head, repoPath) => {
				record("git.compareRefs", [projectId, base, head, repoPath]);
				return { ok: true, value: { mode: "merge-base", base: { ref: base, oid: "1" }, head: { ref: head, oid: "2" }, files: [] } };
			},
			stage: async (projectId, targets, repoPath) => {
				record("git.stage", [projectId, targets, repoPath]);
			},
			unstage: async (projectId, targets, repoPath) => {
				record("git.unstage", [projectId, targets, repoPath]);
			},
			commit: async (projectId, message, repoPath) => {
				record("git.commit", [projectId, message, repoPath]);
			},
			discardFiles: async (projectId, resources, repoPath) => {
				record("git.discardFiles", [projectId, resources, repoPath]);
			},
		},
		remoteHosts: {
			statProjectEntry: async (projectId, path) => {
				record("remoteHosts.statProjectEntry", [projectId, path]);
				return { ok: true, value: { stat: { kind: "file", bytes: 1, mtimeMs: 1 }, version: "v1" } };
			},
			openProjectText: async (projectId, path) => {
				record("remoteHosts.openProjectText", [projectId, path]);
				return { ok: true, value: { document: { content: "remote-content", version: "v1" } } };
			},
			saveProjectText: async (projectId, path, content, version) => {
				record("remoteHosts.saveProjectText", [projectId, path, content, version]);
				return { ok: true, value: { version: "v2" } };
			},
			createProjectFile: async (projectId, parent, name) => {
				record("remoteHosts.createProjectFile", [projectId, parent, name]);
				return { ok: true, value: { relativePath: parent ? parent + "/" + name : name, kind: "file" } };
			},
			createProjectDirectory: async (projectId, parent, name) => {
				record("remoteHosts.createProjectDirectory", [projectId, parent, name]);
				return { ok: true, value: { relativePath: parent ? parent + "/" + name : name, kind: "directory" } };
			},
			renameProjectEntry: async (projectId, source, target, version) => {
				record("remoteHosts.renameProjectEntry", [projectId, source, target, version]);
				return { ok: true, value: { relativePath: target } };
			},
			deleteProjectEntry: async (projectId, path, version) => {
				record("remoteHosts.deleteProjectEntry", [projectId, path, version]);
				return { ok: true, value: { trashId: "t1" } };
			},
		},
	};
	return { api, calls };
}

test("读面已位置无关：本地与远端都走同一目录页/搜索通道", async () => {
	for (const project of [localProject, remoteProject]) {
		const { api, calls } = makeApi();
		const services = createProjectServices(project, api);
		const target = { projectId: project.id, relativePath: "" };
		await services.files.listDirectory(target, { force: true });
		await services.files.searchFiles(project.id, "calc");
		await services.files.searchContent(project.id, "验收");
		assert.deepEqual(
			calls.map((call) => call.name),
			["files.directoryPage", "files.search", "files.searchContent"],
		);
	}
});

test("本机文件写面：读正文/保存/新建/改名/删除走 files:*，系统打开走本机", async () => {
	const { api, calls } = makeApi();
	const services = createProjectServices(localProject, api);
	const target = { projectId: "p1", relativePath: "src/a.ts" };
	assert.equal((await services.files.readText(target)).content, "local-content");
	await services.files.writeText(target, "next");
	await services.files.createEntry({ projectId: "p1", relativePath: "src" }, "b.ts", "file");
	await services.files.renameEntry(target, "c.ts");
	await services.files.deleteEntry(target);
	await services.files.openInEditor(target);
	await services.files.showInFolder(target);
	assert.deepEqual(
		calls.map((call) => call.name),
		["files.readContent", "files.writeContent", "files.create", "files.rename", "files.delete", "files.open", "files.showInFolder"],
	);
});

test("远端文件写面：保存必须带 version；缺省时先取 entry 令牌，再写", async () => {
	const { api, calls } = makeApi();
	const services = createProjectServices(remoteProject, api);
	const target = { projectId: "p2", relativePath: "src/a.ts" };
	const read = await services.files.readText(target);
	assert.deepEqual({ ...read }, { content: "remote-content", version: "v1" });
	await services.files.writeText(target, "next", "v1");
	assert.deepEqual(calls.at(-1), { name: "remoteHosts.saveProjectText", args: ["p2", "src/a.ts", "next", "v1"] });
	calls.length = 0;
	const saved = await services.files.writeText(target, "next2");
	assert.deepEqual({ ...saved }, { version: "v2" });
	assert.deepEqual(
		calls.map((call) => call.name),
		["remoteHosts.statProjectEntry", "remoteHosts.saveProjectText"],
	);
	assert.equal(calls[1].args[3], "v1");
});

test("远端文件管理：新建按类型分流，改名/删除复用 entry 令牌", async () => {
	const { api, calls } = makeApi();
	const services = createProjectServices(remoteProject, api);
	const parent = { projectId: "p2", relativePath: "src" };
	await services.files.createEntry(parent, "b.ts", "file");
	await services.files.createEntry(parent, "dir", "directory");
	await services.files.renameEntry({ projectId: "p2", relativePath: "src/b.ts" }, "c.ts");
	await services.files.deleteEntry({ projectId: "p2", relativePath: "src/c.ts" });
	assert.deepEqual(
		calls.map((call) => call.name),
		["remoteHosts.createProjectFile", "remoteHosts.createProjectDirectory", "remoteHosts.statProjectEntry", "remoteHosts.renameProjectEntry", "remoteHosts.statProjectEntry", "remoteHosts.deleteProjectEntry"],
	);
	assert.deepEqual(calls[3].args, ["p2", "src/b.ts", "src/c.ts", "v1"]);
	assert.deepEqual(calls[5].args, ["p2", "src/c.ts", "v1"]);
});

test("远端没有本机路径：系统打开显式 unsupported，且不调用任何通道", async () => {
	const { api, calls } = makeApi();
	const services = createProjectServices(remoteProject, api);
	for (const method of ["openInEditor", "showInFolder"]) {
		await assert.rejects(
			() => services.files[method]({ projectId: "p2", relativePath: "src/a.ts" }),
			(error) => error instanceof ProjectServiceError && error.code === PROJECT_SERVICE_CODES.unsupported,
		);
	}
	assert.equal(calls.length, 0);
});

test("Git 读面：本地与远端都走统一通道，不各自另开实现", async () => {
	for (const project of [localProject, remoteProject]) {
		const { api, calls } = makeApi();
		const services = createProjectServices(project, api);
		await services.git.status(project.id, { projectId: project.id, relativePath: "" });
		await services.git.history(project.id, { maxCount: 10 }, { projectId: project.id, relativePath: "" });
		await services.git.repos(project.id);
		await services.git.refs(project.id, { projectId: project.id, relativePath: "" });
		await services.git.compare(project.id, "main", "dev", { projectId: project.id, relativePath: "" });
		assert.deepEqual(
			calls.map((call) => call.name),
			["git.status", "git.historyPage", "git.repositoryList", "git.refs", "git.compareRefs"],
		);
	}
});

test("Git 写面：本机委派；远端 Phase C 前显式 unsupported", async () => {
	const localApi = makeApi();
	const localServices = createProjectServices(localProject, localApi.api);
	await localServices.git.stage("p1", [{ projectId: "p1", relativePath: "a.ts" }]);
	await localServices.git.commit("p1", "msg");
	assert.deepEqual(
		localApi.calls.map((call) => call.name),
		["git.stage", "git.commit"],
	);

	const remoteApi = makeApi();
	const remoteServices = createProjectServices(remoteProject, remoteApi.api);
	await assert.rejects(
		() => remoteServices.git.commit("p2", "msg"),
		(error) => error instanceof ProjectServiceError && error.code === PROJECT_SERVICE_CODES.unsupported,
	);
	assert.equal(remoteApi.calls.length, 0);
});

test("能力表：远端没有系统打开/Worktree，内容搜索是协商值；本机全量", () => {
	assert.deepEqual(createProjectServices(localProject, makeApi().api).capabilities, LOCAL_PROJECT_SERVICE_CAPABILITIES);
	const remote = createProjectServices(remoteProject, makeApi().api).capabilities;
	assert.deepEqual(remote, REMOTE_PROJECT_SERVICE_CAPABILITIES);
	assert.equal(remote.files.systemOpen, false);
	assert.equal(remote.files.contentSearch, "negotiated");
	assert.equal(remote.git.worktree, false);
	assert.equal(remote.git.write, false);
	assert.equal(createProjectServices(localProject, makeApi().api).kind, "local");
	assert.equal(createProjectServices(remoteProject, makeApi().api).kind, "remote");
});
