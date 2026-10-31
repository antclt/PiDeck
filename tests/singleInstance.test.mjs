import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 回归背景（2026-10 用户反馈）：开着「单实例运行」（singleInstance）时点系统通知能回到原窗口，
 * 关掉（允许多开）后点通知**直接多开一个 PiDeck**。
 *
 * 原因：通知 toast 用 `activationType="protocol"` + `pideck://`，Windows 点击时是按协议唤起
 * **新进程**，不是给原进程发 click。旧实现里 `!enabled` 直接不写锁，新进程发现不了任何在跑实例，
 * 于是只能自己开窗。现在多开模式下锁仍在，只当「深链激活交给哪个窗口」的路由目标。
 *
 * 这里用真实临时目录 + electron stub 验证两条启动决策，不启动 Electron。
 */

const VERSION = "0.9.9-beta";

function makeUserData(t) {
	const root = mkdtempSync(join(tmpdir(), "pideck-single-instance-"));
	mkdirSync(join(root, "instance-locks"), { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

/** 造一把「另一个活着的实例」持有的锁：用父进程 pid，保证跨平台都被判成存活。 */
function writeLiveOwnerLock(userData, { ready = true } = {}) {
	const lockPath = join(userData, "instance-locks", `${VERSION}.lock`);
	writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, version: VERSION, at: Date.now(), ready }), "utf8");
	return lockPath;
}

function loadSingleInstance(userData, warns) {
	return loadTsCommonJs("src/main/singleInstance.ts", {
		stubs: {
			electron: { app: { getPath: () => userData, once: () => {} } },
			"./logging/sharedLogger": {
				getAppLogger: () => ({ info: () => {}, warn: (scope, message, detail) => warns.push({ scope, message, detail }) }),
			},
		},
	});
}

test("多开 + 普通启动：不握手不退出，锁过户到本进程（深链路由目标）", (t) => {
	const userData = makeUserData(t);
	const lockPath = writeLiveOwnerLock(userData);
	const warns = [];
	const { acquireVersionSingleInstance } = loadSingleInstance(userData, warns);

	const startedAt = Date.now();
	const result = acquireVersionSingleInstance(false, VERSION, () => {});
	t.after(() => result.dispose());

	assert.equal(result.isPrimary, true, "多开模式必须照常开窗");
	assert.ok(Date.now() - startedAt < 1_000, "多开普通启动不该白等握手超时");
	assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, process.pid, "锁要过户给最新窗口");
	assert.equal(existsSync(join(userData, "instance-locks", `${VERSION}.focus`)), false, "普通启动不写深链请求");
});

test("多开 + 深链激活：先请求已运行实例；无人响应时仍开窗，绝不静默退出", (t) => {
	const userData = makeUserData(t);
	writeLiveOwnerLock(userData, { ready: true });
	const warns = [];
	const { acquireVersionSingleInstance } = loadSingleInstance(userData, warns);

	// 本进程内没有「另一个主实例」来消费 .focus，握手必然超时：这正是「主实例卡死」的形态。
	const result = acquireVersionSingleInstance(false, VERSION, () => {}, { routeActivation: true });
	t.after(() => result.dispose());

	assert.equal(result.isPrimary, true, "路由无人接手时用户至少要有窗口");
	assert.ok(
		warns.some((entry) => entry.scope === "single-instance" && String(entry.message).includes("unacknowledged")),
		"必须先尝试过把深链交给已运行实例",
	);
});
