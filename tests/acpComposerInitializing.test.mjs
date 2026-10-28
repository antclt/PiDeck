import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isAcpComposerInitializing } from "../src/renderer/src/utils/composerInitializing.ts";

/**
 * ACP 选中会话即后台预热（spawn + 握手 + configOptions），期间 runtime=starting。
 * 输入框要显示初始化指示、发送置灰，但编辑器不能锁（预热不得抢焦点）。
 * 判定必须只认 ACP：pi standby / DSH host 的 starting 不阻塞发送。
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

test("controller 用独立标志锁发送，不改 isStarting（编辑器仍可输入）", () => {
	assert.match(controller, /const isAcpInitializing = isAcpComposerInitializing\(isAcpBackend, runtime\?\.status\)/);
	// 独立标志：isStarting 仍然只跟用户发送走（已有 composerPrewarmFocus 测试守住）。
	assert.match(controller, /const isStarting = isUserFacingSessionStart\(sendState\.status\)/);
	assert.match(controller, /canSend: hasContent && !isStarting && !isAcpInitializing/);
	assert.match(controller, /canSendQuickMessage: !isStarting && !isAcpInitializing/);
	// Enter / 快捷消息 / 追问都走 promoteAndSend，入口统一拦截。
	assert.match(controller, /if \(isAcpInitializing\) return;/);
});

test("输入框原位显示初始化指示（spinner + 文案），完成后让位给 configOptions", () => {
	assert.match(composerArea, /acpInitializing=\{composer\.isAcpInitializing\}/);
	assert.match(composerArea, /aria-busy=\{composer\.isAcpInitializing \|\| undefined\}/);
	assert.match(composerComponents, /props\.backend === "acp" && props\.acpInitializing/);
	assert.match(composerComponents, /animate-pideck-spin/);
	assert.match(composerComponents, /t\("app\.agentStartingPlaceholder"\)/);
});
