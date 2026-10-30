/**
 * 侧栏「需处理」badge 的契约回归（task-12）。
 *
 * 生产链路：main 的 `remoteProjectRootStatus` 走 Op 信封（`opOk({ status, code, helperCapabilities })`），
 * 渲染层必须从 `value` 里读事实。事故形态：漂移已被主进程检测到（主内容区显示
 * `SSH_PROJECT_ROOT_UNRESOLVED`），但侧栏项目行没有 badge —— 因为读者只认扁平形状，把信封读成
 * `unavailable`。本文件从公开入口断言行为：读函数三态、hook 把 needs-attention 落进 atom（badge 的
 * 唯一数据源）、以及 badge 真的渲染出 testid 与稳定码 hint。
 */
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const { readRootStatusResponse } = loadTsCommonJs("src/renderer/src/components/sidebar/remoteProjectStatusState.ts");

test("Op 信封：status / code / helperCapabilities 从 value 读，旧扁平形状仍兼容", () => {
	const ok = readRootStatusResponse({ ok: true, value: { status: "ok", helperCapabilities: ["echo", "fs.searchContent"] } });
	assert.equal(ok.status, "ok");
	assert.equal(ok.code, null);
	assert.deepEqual([...ok.helperCapabilities], ["echo", "fs.searchContent"]);

	const attention = readRootStatusResponse({ ok: true, value: { status: "needs-attention", code: "SSH_PROJECT_ROOT_UNRESOLVED" } });
	assert.equal(attention.status, "needs-attention");
	assert.equal(attention.code, "SSH_PROJECT_ROOT_UNRESOLVED");

	const failed = readRootStatusResponse({ ok: false, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" });
	assert.equal(failed.status, "unavailable");
	assert.equal(failed.code, "REMOTE_FEATURE_DISABLED");

	// 迁移前的扁平形状（旧宿主/既有测试）继续可用，不能因升级信封而退回 unavailable。
	assert.equal(readRootStatusResponse({ ok: true, status: "ok" }).status, "ok");
	assert.equal(readRootStatusResponse({ ok: true, status: "needs-attention", code: "SSH_PROJECT_ROOT_CHANGED" }).code, "SSH_PROJECT_ROOT_CHANGED");
});

/** 项目 rootStatus 提示的宿主：查询挂起，由测试决定落地时机。 */
function rootStatusHarness() {
	const host = quickMessageHookHost();
	const atoms = { remoteProjectRootStatusAtom: { initial: {} } };
	const store = new Map(Object.values(atoms).map((token) => [token, token.initial]));
	const write = (token, next) => store.set(token, typeof next === "function" ? next(store.get(token)) : next);
	const jotai = { atom: (initial) => ({ initial }), useAtom: (token) => [store.get(token), (next) => write(token, next)], useSetAtom: (token) => (next) => write(token, next) };
	const calls = [];
	const pending = new Map();
	const api = {
		remoteHosts: {
			rootStatus: (projectId) => {
				calls.push(projectId);
				return new Promise((resolve) => pending.set(projectId, resolve));
			},
		},
	};
	const projects = [{ id: "p1", name: "p1", lastOpenedAt: 1, locator: { kind: "ssh", hostId: "host-a", remotePath: "/srv/p1" } }];
	const { useRemoteProjectRootStatuses } = loadTsCommonJs("src/renderer/src/components/sidebar/useRemoteProjectRootStatuses.ts", {
		stubs: { react: host.react, jotai, "../../atoms/remote-sessions-atoms": atoms },
	});
	return {
		render: () => host.render(() => useRemoteProjectRootStatuses(api, projects)),
		calls,
		resolve: (projectId, value) => {
			const resolve = pending.get(projectId);
			pending.delete(projectId);
			resolve?.(value);
		},
		statuses: () => store.get(atoms.remoteProjectRootStatusAtom),
	};
}

test("漂移检测 → 侧栏 badge 数据源：Op 信封的 needs-attention 落进 atom", async () => {
	const h = rootStatusHarness();
	h.render();
	assert.deepEqual([...h.calls], ["p1"]);
	h.resolve("p1", { ok: true, value: { status: "needs-attention", code: "SSH_PROJECT_ROOT_UNRESOLVED" } });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(h.statuses().p1.status, "needs-attention");
	assert.equal(h.statuses().p1.code, "SSH_PROJECT_ROOT_UNRESOLVED");
});

test("badge 渲染：needs-attention 时出 testid 与稳定码 hint，ok/unavailable 不占位置", () => {
	const atomValue = { p1: { status: "needs-attention", code: "SSH_PROJECT_ROOT_UNRESOLVED", helperCapabilities: null } };
	const { RemoteProjectStatusTag } = loadTsCommonJs("src/renderer/src/components/sidebar/RemoteProjectStatusTag.tsx", {
		stubs: {
			react: React,
			jotai: { useAtomValue: () => atomValue },
			"../../atoms/remote-sessions-atoms": { remoteProjectRootStatusAtom: {} },
			"../../i18n": { t: (key, params) => (params === undefined ? key : key + ":" + JSON.stringify(params)) },
			"lucide-react": { AlertTriangle: () => null },
		},
	});
	const html = renderToStaticMarkup(React.createElement(RemoteProjectStatusTag, { projectId: "p1" }));
	assert.match(html, /data-testid="remote-project-needs-attention"/);
	assert.match(html, /SSH_PROJECT_ROOT_UNRESOLVED/);
	const okHtml = renderToStaticMarkup(React.createElement(RemoteProjectStatusTag, { projectId: "missing" }));
	assert.equal(okHtml, "", "没有 needs-attention 记录时不得渲染 badge（不制造噪音）");
});
