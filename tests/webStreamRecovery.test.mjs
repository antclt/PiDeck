/**
 * Web SSE 断线恢复决策单测（第二批）：decideStreamRecovery 的守卫组合 ——
 * 页面不可见/离线/ready 态不恢复；error 态立即恢复并提示；防抖窗口内不重复。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { decideStreamRecovery, WEB_RECOVERY_DEBOUNCE_MS } = loadTsCommonJs("src/renderer/src/web/webStreamRecovery.ts");

const base = {
	status: "streaming",
	documentVisible: true,
	online: true,
	lastAttemptAt: 0,
	now: 100_000,
};

test("页面不可见时不恢复（回前台才算用户回来了）", () => {
	assert.equal(decideStreamRecovery({ ...base, documentVisible: false }).recover, false);
});

test("离线时不恢复（没有网络，拉磁盘窗口也必失败）", () => {
	assert.equal(decideStreamRecovery({ ...base, online: false }).recover, false);
});

test("ready 且无 error 时不恢复（正常态轮询自己会追平）", () => {
	assert.equal(decideStreamRecovery({ ...base, status: "ready" }).recover, false);
});

test("error 态立即恢复并提示用户", () => {
	const decision = decideStreamRecovery({ ...base, status: "error" });
	assert.equal(decision.recover, true);
	assert.equal(decision.notify, true);
});

test("submitted/streaming 回前台恢复但不打扰（静默补齐）", () => {
	const decision = decideStreamRecovery({ ...base, status: "streaming", documentVisible: true });
	assert.equal(decision.recover, true);
	assert.equal(decision.notify, false);
});

test(`防抖：${WEB_RECOVERY_DEBOUNCE_MS}ms 内不重复恢复`, () => {
	const again = decideStreamRecovery({ ...base, lastAttemptAt: base.now - 1000 });
	assert.equal(again.recover, false);
	const later = decideStreamRecovery({ ...base, lastAttemptAt: base.now - WEB_RECOVERY_DEBOUNCE_MS - 1 });
	assert.equal(later.recover, true);
});
