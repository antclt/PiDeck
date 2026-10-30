import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const surface = readFileSync("src/renderer/src/components/session/SessionStartSurface.tsx", "utf8");
const view = readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");

test("start surface reuses the session bottom composer, not a second input implementation", () => {
	// 统一输入：直接居中挂完整 ComposerArea（模型/思考/模式/安全级别/发送全保留），
	// 禁止再出现自制 TipTapComposer / waitRuntimeReady / sendPrompt 链路。
	assert.match(surface, /<ComposerArea/);
	assert.match(surface, /import \{ ComposerArea \} from "\.\/ComposerArea"/);
	assert.match(surface, /import \{ QueuedPromptPanel \} from "\.\/ComposerPanels"/);
	assert.match(surface, /import \{ SessionGoalStrip \} from "\.\/SessionGoalStrip"/);
	assert.match(surface, /import \{ SessionSubagentsStrip \} from "\.\/SessionSubagentsStrip"/);
	assert.match(surface, /import \{ SessionTodoStrip \} from "\.\/SessionTodoStrip"/);
	assert.match(surface, /<SessionTodoStrip sessionId=\{props\.sessionId\} \/>/);
	assert.match(surface, /<SessionSubagentsStrip sessionId=\{props\.sessionId\} \/>/);
	assert.match(surface, /<SessionGoalStrip sessionId=\{props\.sessionId\} \/>/);
	// 「修改的文件」已改为每轮末尾的 chip 行；引导页没有轮次，不再挂文件条
	assert.doesNotMatch(surface, /SessionFilesStrip/);
	assert.match(surface, /useSessionPaneServices\(\)/);
	assert.match(surface, /queuedPromptsBySession\[props\.sessionId\]/);
	assert.match(surface, /<LogoMark size=\{72\} \/>/);
	assert.doesNotMatch(surface, /TipTapComposer/);
	assert.doesNotMatch(surface, /waitRuntimeReady|sendPrompt|getComposerEnterIntent/);
});

test("start surface centers the composer", () => {
	// DeepSeek 式居中：flex 列 + 重心下移；2027-02 起两屏共用 StartSurfaceShell 骨架，
	// 布局值只在这一处定义（无项目卡天然对齐）：860px 列 / pt-[23vh] 重心 / 15.5px 输入字号。
	assert.match(surface, /pt-\[23vh\]/);
	assert.match(surface, /max-w-\[860px\]/);
	assert.match(surface, /\[--chat-content-pct-set:100%\]/);
	assert.doesNotMatch(surface, /defaultHeight=/);
	assert.match(surface, /session-start-surface/);
	// 起步提示只填草稿不直接发送；不存在一键直发残留
	assert.doesNotMatch(surface, /QUICK_ACTIONS/);
	assert.doesNotMatch(surface, /insertQuickPrompt/);
});

test("bottom composer is hidden while the start surface is showing", () => {
	// 空会话磁盘就绪后卸底部栏，避免同屏两个输入框。
	assert.match(view, /shouldMountBottomComposer/);
	assert.match(view, /sessionTimeline\.isSurfaceLoading/);
	assert.match(view, /bottomComposerVisible &&/);
	assert.doesNotMatch(view, /id="composer"/);
	assert.doesNotMatch(view, /sessionTimeline\.messages\.length > 0 && \(/);
});

test("empty active sessions render the start surface with the session id", () => {
	assert.match(timeline, /activeMessages\.length === 0/);
	assert.match(timeline, /<SessionStartSurface sessionId=\{sessionId\} \/>/);
});
