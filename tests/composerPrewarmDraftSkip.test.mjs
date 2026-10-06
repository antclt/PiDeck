import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 2026-10-06 悬浮窗进程堆积事故回归：输入触发的预热（activateRuntime）会把 standby
// 池进程认领给「从未发送的空白草稿」（status=draft），并立刻补一个替补进程；
// 用户反复「新建→输入→放弃」每轮泄漏一个空闲进程（IdleAgentReleaser 60min 才回收，
// keepCount=5）。守卫：空白草稿跳过激活预热——首条消息发送时 coordinator.activate
// 的懒认领路径（!entry.filePath → claimStandbyAgent）同样从池里拿热进程，不损失无感启动。
// 纯源码契约测试，不依赖 vm loader；正则空白容忍（格式化契约见 AGENTS.md）。
const composerArea = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");

function prewarmEffectBlock() {
	const start = composerArea.indexOf("prewarmStartedForSessionRef = useRef");
	const end = composerArea.indexOf("desktopApi.sessions.activateRuntime");
	assert.ok(start >= 0 && end > start, "prewarm effect block not found in ComposerArea.tsx");
	return composerArea.slice(start, end);
}

test("input prewarm skips never-sent draft sessions", () => {
	// 跳过判定必须在 activateRuntime 调用之前，且先于输入非空判断（草稿根本不该走到意图判断）。
	const block = prewarmEffectBlock();
	assert.match(block, /if\s*\(\s*sessionRecords\[props\.sessionId\]\?\.status\s*===\s*"draft"\s*\)\s*return;/);
});

test("prewarm effect depends on sessionRecords so draft→active promotion re-evaluates", () => {
	// 依赖数组必须包含 sessionRecords：草稿发送后转 active，effect 需重新评估才会
	// 为恢复场景预热（历史会话 --session 慢路径仍受益于输入预热）。
	const depsMatch = composerArea.match(/composer\.pasteFiles\.files\.length,\s*props\.sessionId[^)]*\);\n/s);
	assert.ok(depsMatch, "prewarm effect deps array not found");
	assert.match(depsMatch[0], /sessionRecords/);
});
