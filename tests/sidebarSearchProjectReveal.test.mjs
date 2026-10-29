import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 回归（用户反馈「搜索里点项目不会跳转」）：搜索面板的项目项原来只做「选中 + 展开」，
 * 但侧栏三个分段（活动 / 聊天 / 项目）只挂载当前分段——停在别的分段时目标行不在 DOM 里，
 * 也不会滚动定位，用户看到的是左侧毫无变化、右侧只出现项目引导页（准备新开会话）。
 *
 * 修复契约：项目项 onSelect 走 revealSearchProject ——
 *   1) 切到项目所在分段（Chat → 聊天，其余 → 项目；简洁模式不切，三段都渲染）；
 *   2) worktree 子项目先展开父项目与该分支行，再展开自身；
 *   3) 两帧后按 data-project-row-id 在列表滚动容器内 scrollIntoView。
 * 行上的 data-project-row-id 是定位锚点，缺一处就退化成「只在部分项目上能用」。
 */

const sidebar = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");
const projectTree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");
const worktreeTree = readFileSync("src/renderer/src/components/sidebar/WorktreeTree.tsx", "utf8");

test("search project item delegates to the reveal helper", () => {
	assert.match(sidebar, /onSelect: \(\) => \{\s*actions\.projects\.select\(project\.id\);\s*revealSearchProject\(project\);\s*\}/);
});

test("reveal switches to the segment that actually renders the project row", () => {
	assert.match(sidebar, /if \(!props\.simple\) controller\.setNavTab\(isChatProject\(project\) \? "chats" : "projects"\);/);
});

test("reveal expands worktree ancestors before scrolling", () => {
	assert.match(sidebar, /controller\.revealProject\(parent\.id\);/);
	assert.match(sidebar, /controller\.expandWorktreeSessions\(project\.id\);/);
	assert.match(sidebar, /controller\.revealProject\(project\.id\);/);
});

test("reveal scrolls the project row inside the sidebar list", () => {
	assert.match(sidebar, /const conversationListRef = useRef<HTMLElement>\(null\);/);
	assert.match(sidebar, /<section ref=\{conversationListRef\} className="conversation-list/);
	assert.match(sidebar, /querySelector<HTMLElement>\(`\[data-project-row-id="\$\{CSS\.escape\(project\.id\)\}"\]`\)/);
	assert.match(sidebar, /scrollIntoView\(\{ block: "nearest" \}\)/);
});

test("project rows carry the reveal anchor", () => {
	// 根项目行（项目分段）与 Chat 标题行（聊天分段）各一处
	assert.equal(projectTree.match(/data-project-row-id=\{project\.id\}/g)?.length, 2);
	// worktree 子项目行（挂在父项目树里）
	assert.match(worktreeTree, /data-project-row-id=\{childProject\?\.id\}/);
});
