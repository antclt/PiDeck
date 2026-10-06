import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/** 独立浮窗宿主：目录、默认模型和创建命令均为替身，不启动真实 Agent。 */
function setup({ activeProjectId, backend = "pi", create, listCatalog } = {}) {
	const host = quickMessageHookHost();
	const projects = [
		{ id: "chat", name: "Chat", path: "", kind: "chat", lastOpenedAt: 0 },
		{ id: "work", name: "Workspace", path: "C:/work", lastOpenedAt: 1 },
	];
	const calls = [];
	const opened = [];
	const atoms = { projectInventoryAtom: "projects", currentSessionAtom: "session", effectiveAgentBackendAtom: "backend" };
	const { useMiniOverlayWorkspace } = loadTsCommonJs("src/renderer/src/hooks/useMiniOverlayWorkspace.ts", {
		stubs: {
			react: host.react,
			jotai: { useAtomValue: (atom) => ({ projects, session: undefined, backend })[atom] },
			"../atoms": atoms,
			"../desktopApi": { desktopApi: { sessions: { listCatalog: listCatalog ?? (async () => []), resolveLaunchDefaults: async () => ({ model: { provider: "configured", modelId: "default", modelName: "Default model" } }) } } },
			"../i18n": { t: (key) => key },
			"../utils/notice": { showNotice: () => {} },
		},
	});
	const render = () =>
		host.render(() =>
			useMiniOverlayWorkspace({
				activeProjectId,
				onCreateSession: async (...args) => {
					calls.push(args);
					return create ? create(...args) : { id: "new", projectId: args[0] };
				},
				onOpenSession: async (projectId, sessionId) => {
					opened.push([projectId, sessionId]);
					return sessionId;
				},
			}),
		);
	return { render, calls, opened, host };
}

const settle = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

test("新建浮窗会话须明确选项目，选项目本身不创建会话", async () => {
	const { render, calls } = setup();
	let workspace = render();
	workspace.showNewSession();
	workspace = render();
	assert.equal(workspace.project, undefined);
	await workspace.createSession();
	assert.equal(calls.length, 0);
	workspace.selectProject("work");
	workspace = render();
	assert.equal(workspace.project.id, "work");
	assert.equal(calls.length, 0);
});

test("浮窗新建页点选模型完整传入所选项目与有效后端", async () => {
	const { render, calls } = setup({ activeProjectId: "work", backend: "dsh" });
	let workspace = render();
	workspace.showNewSession();
	workspace = render();
	workspace.selectModel({ provider: "route", id: "model-a", name: "Friendly name" });
	workspace = render();
	await workspace.createSession();
	assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ["work", { model: { provider: "route", modelId: "model-a", modelName: "Friendly name" } }, "dsh"]);
	assert.equal(render().view, "session");
});

test("切换项目不把旧项目点选的模型带进新会话", async () => {
	const { render, calls } = setup({ activeProjectId: "work" });
	let workspace = render();
	workspace.showNewSession();
	workspace = render();
	workspace.selectModel({ provider: "local", id: "model-a", name: "Local model" });
	workspace = render();
	workspace.selectProject("chat");
	workspace = render();
	await workspace.createSession();
	assert.equal(calls[0][0], "chat");
	assert.equal(calls[0][1].model, undefined);
});

test("显示真实默认模型但未显式点选时继续由主进程解析默认值", async () => {
	const { render, calls } = setup({ activeProjectId: "work" });
	render().showNewSession();
	render();
	await settle();
	const workspace = render();
	assert.equal(workspace.displayModel.modelId, "default");
	await workspace.createSession();
	assert.equal(calls[0][1].model, undefined);
});

test("新建在途时重复点击只创建一次，失败保留项目和模型可重试", async () => {
	let reject;
	const pending = new Promise((_, fail) => {
		reject = fail;
	});
	const { render, calls } = setup({ activeProjectId: "work", create: () => pending });
	render().showNewSession();
	let workspace = render();
	workspace.selectModel({ provider: "local", id: "model-a", name: "Local model" });
	workspace = render();
	const first = workspace.createSession();
	await workspace.createSession();
	assert.equal(calls.length, 1);
	reject(new Error("offline"));
	await first;
	workspace = render();
	assert.equal(workspace.creating, false);
	assert.equal(workspace.view, "new");
	assert.equal(workspace.project.id, "work");
	assert.equal(workspace.displayModel.modelId, "model-a");
});

test("主页只展示所选项目的最近顶层会话，点击经会话选择命令恢复", async () => {
	const { render, opened } = setup({
		activeProjectId: "work",
		listCatalog: async () => [
			{ id: "old", projectId: "work", updatedAt: 1 },
			{ id: "recent", projectId: "work", updatedAt: 3 },
			{ id: "child", projectId: "work", updatedAt: 4, parentSessionId: "recent" },
		],
	});
	render();
	await settle();
	const workspace = render();
	assert.deepEqual(
		Array.from(workspace.recentSessions, (session) => session.id),
		["recent", "old"],
	);
	await workspace.openSession("recent");
	assert.deepEqual(opened, [["work", "recent"]]);
	assert.equal(render().view, "session");
});

test("主页切换项目后丢弃旧目录的迟到结果", async () => {
	let resolveOld;
	const oldCatalog = new Promise((resolve) => {
		resolveOld = resolve;
	});
	const { render } = setup({ activeProjectId: "work", listCatalog: async (projectId) => (projectId === "work" ? oldCatalog : []) });
	render().selectProject("chat");
	render();
	await settle();
	resolveOld([{ id: "stale", projectId: "work", updatedAt: 1 }]);
	await settle();
	assert.equal(render().recentSessions.length, 0);
});
