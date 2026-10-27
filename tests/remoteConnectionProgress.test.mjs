import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 连接进度屏的推导层：阶段只来自主进程诊断历史与状态推送，不从日志文本里猜。
const { isRemoteConnectionInFlight, resolveRemoteConnectionProgress } = loadTsCommonJs("src/renderer/src/components/app/settings/remoteConnectionProgressState.ts");

const at = "2026-01-01T00:00:00.000Z";
const entry = (phase, state = "bootstrapping", code = "SSH_CONNECTION_STEP") => ({ hostId: "0f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d", generation: 1, state, phase, code, at });
// VM 里加载的数组与测试文件不同 realm，按字符串比较。
const statuses = (progress) => progress.steps.map((step) => `${step.key}:${step.status}`).join(",");

test("in-flight states are the only ones that keep the panel polling", () => {
	for (const state of ["connecting", "probing", "bootstrapping", "reconnecting"]) assert.equal(isRemoteConnectionInFlight(state), true, state);
	for (const state of ["ready", "degraded", "disconnected", "offline", "needs-attention", undefined]) assert.equal(isRemoteConnectionInFlight(state), false, String(state));
});

test("a ready host completes every step", () => {
	const progress = resolveRemoteConnectionProgress({ state: "ready", entries: [entry("helper")] });
	assert.equal(progress.phase, "ready");
	assert.equal(statuses(progress), "channel:complete,environment:complete,helper:complete,agent:complete");
	assert.equal(progress.code, null);
});

test("the state floor advances the active step even when diagnostics lag", () => {
	const progress = resolveRemoteConnectionProgress({ state: "bootstrapping", entries: [] });
	assert.equal(progress.phase, "running");
	assert.equal(statuses(progress), "channel:complete,environment:complete,helper:active,agent:pending");
});

test("diagnostic phases fold into four user-facing steps", () => {
	const progress = resolveRemoteConnectionProgress({ state: "connecting", entries: [entry("openssh"), entry("authenticate"), entry("platform", "probing")] });
	assert.equal(statuses(progress), "channel:complete,environment:active,helper:pending,agent:pending");
	const helper = resolveRemoteConnectionProgress({ state: "bootstrapping", entries: [entry("node", "probing"), entry("helper", "bootstrapping")] });
	assert.equal(statuses(helper), "channel:complete,environment:complete,helper:active,agent:pending");
});

test("a failure stops on the step it reached and keeps the stable code", () => {
	const progress = resolveRemoteConnectionProgress({ state: "offline", entries: [entry("openssh"), entry("platform"), entry("helper", "offline", "REMOTE_NODE_NOT_FOUND")], errorCode: "REMOTE_NODE_NOT_FOUND" });
	assert.equal(progress.phase, "failed");
	assert.equal(progress.failedStep, "helper");
	assert.equal(progress.code, "REMOTE_NODE_NOT_FOUND");
	assert.equal(statuses(progress), "channel:complete,environment:complete,helper:failed,agent:pending");
});

test("free text never becomes a diagnostic code", () => {
	const progress = resolveRemoteConnectionProgress({ state: "needs-attention", entries: [entry("helper")], errorCode: "ssh: connect to host failed" });
	assert.equal(progress.phase, "failed");
	assert.equal(progress.code, null);
	assert.equal(progress.failedStep, "helper");
});

test("disconnecting without an error is cancelled, not failed", () => {
	const progress = resolveRemoteConnectionProgress({ state: "disconnected", entries: [entry("openssh")] });
	assert.equal(progress.phase, "idle");
	assert.equal(progress.code, null);
	assert.equal(statuses(progress), "channel:pending,environment:pending,helper:pending,agent:pending");
});

test("progress panel cancels through main and gates stale attempts", () => {
	const dialog = readFileSync("src/renderer/src/components/app/settings/RemoteConnectionProgressDialog.tsx", "utf8");
	assert.match(dialog, /aria-live="polite"/);
	assert.match(dialog, /desktopApi\.remoteHosts\.diagnostics/);
	assert.match(dialog, /props\.onCancel\(\)/);
	assert.match(dialog, /settings\.connections\.progress\.failedDescription/);
	const tab = readFileSync("src/renderer/src/components/app/settings/ConnectionsTab.tsx", "utf8");
	// 取消/重试后，旧 connect 的迟到结果不得回写新一次的状态或进度。
	assert.match(tab, /if \(attemptRef\.current !== attempt\) return;/);
	assert.match(tab, /<RemoteConnectionProgressDialog/);
});
