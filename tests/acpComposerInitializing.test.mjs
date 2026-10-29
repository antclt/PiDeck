import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isAcpComposerInitializing } from "../src/renderer/src/utils/composerInitializing.ts";

/**
 * ACP 选中会话即后台预热（spawn + 握手 + configOptions），期间 runtime=starting。
 *
 * 2026-11 契约变更（用户反馈「ACP 启动动画期间输入框像坏了」）：指示照旧显示，但**不再拦发送**。
 * 旧实现把 isAcpInitializing 接进 canSend / canSendQuickMessage，并在 promoteAndSend 里静默 return，
 * 于是 Enter 毫无反馈；现在发送和 pi 冷启动走同一条路（useSessionSend 先发布 activating，
 * 再由主进程 ensureRuntime 复用同一条 pending activation），用户不必先等握手结束再按发送。
 * 编辑器仍然不锁：预热不得抢焦点（见 composerPrewarmFocus 测试）。
 */
test("只有 ACP 的 runtime starting 算输入框初始化中", () => {
	assert.equal(isAcpComposerInitializing(true, "starting"), true);
	assert.equal(isAcpComposerInitializing(true, "idle"), false);
	assert.equal(isAcpComposerInitializing(true, "running"), false);
	assert.equal(isAcpComposerInitializing(true, undefined), false);
	assert.equal(isAcpComposerInitializing(false, "starting"), false);
});

const controller = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");
const composerArea = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
const composerComponents = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");

test("初始化只是指示态：发送闸门只看用户发送态，不被 ACP 握手拦住", () => {
	assert.match(controller, /const isAcpInitializing = isAcpComposerInitializing\(isAcpBackend, runtime\?\.status\)/);
	// isStarting 仍然只跟用户发送走（编辑器 disabled 与发送锁都靠它）。
	assert.match(controller, /const isStarting = isUserFacingSessionStart\(sendState\.status\)/);
	// 发送可用性不再引用初始化标志：预热期间输入 → 发送照常（主进程排队到握手之后）。
	const canSendLine = controller.split("\n").find((line) => line.includes("canSend: hasContent"));
	assert.ok(canSendLine, "必须保留 canSend 定义");
	assert.doesNotMatch(canSendLine, /isAcpInitializing/, "canSend 不得因 ACP 预热置灰");
	const quickSendLine = controller.split("\n").find((line) => line.includes("canSendQuickMessage:"));
	assert.ok(quickSendLine, "必须保留 canSendQuickMessage 定义");
	assert.doesNotMatch(quickSendLine, /isAcpInitializing/, "快捷消息同理不得被 ACP 预热拦住");
	// Enter / 快捷消息 / 追问的统一入口不能再有静默 return：那是「按了没反应」的直接来源。
	const promote = controller.slice(controller.indexOf("const promoteAndSend"));
	const promoteGate = promote.slice(0, promote.indexOf("if (mode === \"imagegen\")"));
	assert.doesNotMatch(promoteGate, /if \(isAcpInitializing\) return;/, "promoteAndSend 不得静默丢弃发送");
});

test("输入框原位显示初始化指示（spinner + 文案），完成后让位给 configOptions", () => {
	assert.match(composerArea, /acpInitializing=\{composer\.isAcpInitializing\}/);
	assert.match(composerArea, /aria-busy=\{composer\.isAcpInitializing \|\| undefined\}/);
	assert.match(composerComponents, /props\.backend === "acp" && props\.acpInitializing/);
	assert.match(composerComponents, /animate-pideck-spin/);
	assert.match(composerComponents, /t\("app\.agentStartingPlaceholder"\)/);
});
