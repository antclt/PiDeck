import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Wave 7 弹窗收尾契约：
 * 1. Web 思考档位常量单源自桌面 THINKING_LEVELS（桌面加档位 Web 自动跟随，不再手抄漂移）。
 * 2. z-layer：GitGraph hover 详情卡用 --z-popover token；ImportOverlayHost 的 1100 必须
 *    带有意识保留注释（旧浮层 1000 之上的错误通报条，无对应 token）。
 * 3. WebPromptPicker 加载失败：role=alert + 重试按钮（错误可行动，对齐桌面 Picker 模式）。
 */

const picker = readFileSync(new URL("../src/renderer/src/web/WebPromptPicker.tsx", import.meta.url), "utf8");
const thinking = readFileSync(new URL("../src/renderer/src/web/WebThinkingSelector.tsx", import.meta.url), "utf8");
const gitGraph = readFileSync(new URL("../src/renderer/src/components/app/git/GitGraph.tsx", import.meta.url), "utf8");
const importHost = readFileSync(new URL("../src/renderer/src/components/overlays/ImportOverlayHost.tsx", import.meta.url), "utf8");

test("Web 思考档位单源自桌面 THINKING_LEVELS", () => {
	assert.match(thinking, /import \{ THINKING_LEVELS \} from "@\/components\/session\/sessionPickerOptions"/);
	assert.match(thinking, /WEB_THINKING_LEVELS = THINKING_LEVELS\.map/);
	// 手抄档位数组不得回归
	assert.doesNotMatch(thinking, /\["off", "minimal", "low"/);
});

test("GitGraph hover 详情卡用 z token", () => {
	assert.match(gitGraph, /z-\[var\(--z-popover\)\]/);
	assert.doesNotMatch(gitGraph, /z-\[1800\]/);
});

test("ImportOverlayHost 1100 层带意图注释", () => {
	const i = importHost.indexOf("zIndex: 1100");
	assert.ok(i > 0);
	const before = importHost.slice(Math.max(0, i - 300), i);
	assert.match(before, /旧浮层|有意识|1000/u, "1100 之上必须写明为何不用 --z-* token");
});

test("WebPromptPicker 失败态可行动", () => {
	assert.match(picker, /role="alert"/);
	assert.match(picker, /common\.retry/);
	assert.match(picker, /load\(debounced, category\)/);
});
