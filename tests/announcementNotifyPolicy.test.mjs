/**
 * 公告通知弹出时机策略纯函数单测（utils/announcementNotifyPolicy.ts）。
 * 守护：isBusyForAnnouncement 的四类忙碌信号命中即跳过、nextTickDelayMs 的
 * 可见/不活跃分档、levelToNoticeKind 级别映射。无运行时依赖，vm 沙箱直接加载。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { readFileSync } from "node:fs";

/** 纯 TS 模块加载（无外部依赖，deps 留空）。 */
function loadTsModule(filePath) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, require: () => { throw new Error("unexpected require"); } });
	return module.exports;
}

const policy = loadTsModule("src/renderer/src/utils/announcementNotifyPolicy.ts");

/** 空闲上下文工厂（补丁语义），所有用例从全空闲出发。 */
const idle = (patch = {}) => ({
	composerFocused: false,
	agentBusy: false,
	modalOpen: false,
	windowInactive: false,
	...patch,
});

test("isBusyForAnnouncement：任一忙碌信号命中即跳过本轮弹出", () => {
	assert.equal(policy.isBusyForAnnouncement(idle()), false);
	assert.equal(policy.isBusyForAnnouncement(idle({ composerFocused: true })), true);
	assert.equal(policy.isBusyForAnnouncement(idle({ agentBusy: true })), true);
	assert.equal(policy.isBusyForAnnouncement(idle({ modalOpen: true })), true);
	assert.equal(policy.isBusyForAnnouncement(idle({ windowInactive: true })), true);
});

test("nextTickDelayMs：窗口不活跃用大间隔节流，可见时短间隔保证空闲后及时弹出", () => {
	assert.equal(policy.nextTickDelayMs(idle({ windowInactive: true })), policy.ANNOUNCEMENT_POLL_HIDDEN_MS);
	assert.equal(policy.nextTickDelayMs(idle()), policy.ANNOUNCEMENT_POLL_VISIBLE_MS);
	// 分档合理性：可见轮询必须快于后台节流
	assert.ok(policy.ANNOUNCEMENT_POLL_VISIBLE_MS < policy.ANNOUNCEMENT_POLL_HIDDEN_MS);
});

test("levelToNoticeKind：公告级别映射到 toast 严重度", () => {
	assert.equal(policy.levelToNoticeKind("critical"), "error");
	assert.equal(policy.levelToNoticeKind("warn"), "warning");
	assert.equal(policy.levelToNoticeKind("info"), "info");
});
