/**
 * 侧栏「启用/关闭工作区」入口的远端能力门禁（WS3 task-6）。
 *
 * 以前远端项目也能看到该菜单项，点击后才被主进程的 UNSUPPORTED_PROJECT_LOCATION 拒绝，
 * 用户看到的是一条原始错误码。这里锁定：
 * - 菜单判据：本机（含 WSL）显示，Chat 与远端项目不显示；
 * - 点击守卫：远端项目不调用主进程，返回明确原因 key（不弹原始错误码）；
 * - 本机路径不变；
 * - 过期的远端 Git 能力文案不再声称 stage/commit/sync/push 不可用。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const { shouldShowWorktreeMenuEntry, worktreeToggleUnavailableKey } = loadTsCommonJs("src/renderer/src/utils/worktreeEntryGate.ts");
const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const { enUS } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts");

const LOCAL = { id: "p-local", name: "Local", lastOpenedAt: 1, path: "D:/work/local", environment: "windows" };
const WSL = { id: "p-wsl", name: "WSL", lastOpenedAt: 1, path: "/home/dev/wsl", environment: "wsl", wslDistro: "Ubuntu-26.04" };
const CHAT = { id: "builtin-chat", name: "Chat", lastOpenedAt: 1, path: "D:/work/chat", kind: "chat", environment: "windows" };
const REMOTE = { id: "p-remote", name: "Remote", lastOpenedAt: 1, locator: { kind: "ssh", hostId: "11111111-1111-4111-8111-111111111111", remotePath: "/srv/app" } };

test("工作区菜单入口：本机（含 WSL）显示，Chat 与远端项目隐藏", () => {
	assert.equal(shouldShowWorktreeMenuEntry(LOCAL), true);
	assert.equal(shouldShowWorktreeMenuEntry(WSL), true);
	assert.equal(shouldShowWorktreeMenuEntry(CHAT), false, "Chat 项目没有 Git 工作区语义，沿用既有隐藏行为");
	assert.equal(shouldShowWorktreeMenuEntry(REMOTE), false, "远端项目没有本机 Git 目录，入口必须隐藏");
});

test("点击守卫判据：只有远端项目返回明确原因 key，本机/Chat 可执行", () => {
	assert.equal(worktreeToggleUnavailableKey(LOCAL), null);
	assert.equal(worktreeToggleUnavailableKey(WSL), null);
	assert.equal(worktreeToggleUnavailableKey(CHAT), null);
	assert.equal(worktreeToggleUnavailableKey(REMOTE), "remoteGit.worktreeUnsupported");
});

function worktreeHarness() {
	const host = quickMessageHookHost();
	const notices = [];
	const toggled = [];
	const listed = [];
	const refreshed = [];
	const api = {
		projects: {
			toggleWorktreeEnabled: async (projectId) => {
				toggled.push(projectId);
				return { id: projectId, worktreeEnabled: true };
			},
			list: async () => {
				listed.push(1);
				return [];
			},
		},
	};
	const { useWorktreeActions } = loadTsCommonJs("src/renderer/src/hooks/useWorktreeActions.ts", {
		stubs: {
			react: host.react,
			"../desktopApi": { desktopApi: api },
			"../utils/notice": { showNotice: (message) => notices.push(message) },
			"../i18n": { t: (key) => key },
		},
	});
	let state = null;
	const render = () =>
		(state = host.render(() =>
			useWorktreeActions({
				projects: [],
				displayAgents: [],
				setProjects: () => {},
				refreshWorktrees: async (projectId) => {
					refreshed.push(projectId);
				},
				overlays: { showConfirm: () => {}, clearConfirm: () => {} },
			}),
		));
	return { host, render, view: () => state, notices, toggled, listed, refreshed };
}

test("远端项目点击不调用主进程、不弹 UNSUPPORTED_PROJECT_LOCATION，只给明确原因", async () => {
	const h = worktreeHarness();
	h.render();
	await h.view().toggleProjectWorktree(REMOTE);
	assert.equal(h.toggled.length, 0, "远端项目不应调用 toggleWorktreeEnabled");
	assert.deepEqual(h.notices, ["remoteGit.worktreeUnsupported"]);
	assert.ok(!h.notices.some((message) => message.includes("UNSUPPORTED_PROJECT_LOCATION")), "不能把主进程原始错误码直接 toast");
	h.host.unmount();
});

test("本机项目行为不变：照常切换并刷新项目列表", async () => {
	const h = worktreeHarness();
	h.render();
	await h.view().toggleProjectWorktree(LOCAL);
	assert.deepEqual(h.toggled, [LOCAL.id]);
	assert.deepEqual(h.listed, [1]);
	assert.deepEqual(h.notices, []);
	h.host.unmount();
});

test("过期能力文案已修正：不再声称 stage/commit/sync/push 不可用，history 明确 HEAD-only", () => {
	for (const dictionary of [zhCN, enUS]) {
		assert.ok(dictionary["remoteGit.worktreeUnsupported"]);
		assert.match(dictionary["remoteGit.historyReadOnly"], /HEAD/);
	}
	// remoteGit.readOnly / remoteGit.managedIndex 已删除：无组件引用、仅被本测试钉住的死 key。
	// 能力说明以 worktreeUnsupported / historyReadOnly / commitHint 为准（上方断言保留）。
	assert.doesNotMatch(zhCN["remoteGit.commitHint"], /也不支持 amend、push/);
	assert.doesNotMatch(enUS["remoteGit.commitHint"], /amend, push or signing are not supported/);
});
