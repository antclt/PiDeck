import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const webCss = readFileSync("src/renderer/src/web/web.css", "utf8");
const webSidebar = readFileSync("src/renderer/src/web/WebSidebar.tsx", "utf8");
const webHeader = readFileSync("src/renderer/src/web/WebHeader.tsx", "utf8");
const webModelSheet = readFileSync("src/renderer/src/web/WebModelSheet.tsx", "utf8");
const webChatApp = readFileSync("src/renderer/src/web/WebChatApp.tsx", "utf8");
const webSessionStrips = readFileSync("src/renderer/src/web/WebSessionStrips.tsx", "utf8");

test("Web shell keeps sidebar and chat pane in a horizontal split", () => {
	assert.match(webCss, /\.app\.wechat-shell\s*\{[\s\S]*?flex-direction:\s*row;/, "the desktop shell defaults to a vertical layout, so Web must explicitly restore the horizontal split");
	assert.match(webCss, /\.app\.wechat-shell\s*>\s*\.chat-list-pane\s*\{[\s\S]*?flex:\s*0\s+0\s+280px;[\s\S]*?width:\s*280px;/, "the Web sidebar needs a stable width or it consumes the chat pane");
	assert.match(webCss, /\.app\.wechat-shell\s*>\s*\.chat-pane\s*\{[\s\S]*?flex:\s*1\s+1\s+0;/, "the chat pane must own the remaining horizontal space");
});

test("Web project rows can collapse after the active session is revealed", () => {
	assert.match(webSidebar, /useEffect\(\(\) => \{/);
	assert.doesNotMatch(webSidebar, /expandedProjects\.has\(project\.id\) \|\| project\.id === activeSessionProjectId/, "the active project must not be forced open on every render");
	assert.match(webSidebar, /const expanded = searching \|\| expandedProjects\.has\(project\.id\)/);
});

test("Web model picker lives in a searchable bottom sheet, header stays one row", () => {
	// 模型选择器已从头部的 Command 弹层迁到 composer 的 WebBottomSheet（第三批瘦身）：
	// 搜索输入在 sheet 内，header 不再携带 CommandInput。
	assert.match(webModelSheet, /placeholder=\{t\("web\.modelSearch"\)\}/);
	assert.match(webModelSheet, /t\("web\.modelEmpty"\)/);
	assert.doesNotMatch(webHeader, /CommandInput/);
	// 头部固定单行（全局入口收敛进溢出菜单），不再 flex-wrap 换行。
	assert.match(webHeader, /web-header flex min-w-0 items-center/);
	assert.doesNotMatch(webHeader, /flex-wrap/);
});

test("Mobile Web keeps chat full-screen and opens the project tree as a drawer", () => {
	assert.match(webChatApp, /mobileSidebarOpen/);
	assert.match(webChatApp, /onOpenSidebar/);
	assert.match(webSidebar, /mobile-sidebar-backdrop/);
	assert.match(webSidebar, /mobile-open/);
	assert.match(webSidebar, /onDeleteProject/);
});

test("Web starts with no selected session and exposes a scroll-to-bottom action", () => {
	assert.doesNotMatch(webChatApp, /setActiveSessionId\(next\.sessions\[0\]\?\.id \?\? ""\)/);
	assert.match(webChatApp, /setActiveSessionId\(""\)/);
	assert.match(readFileSync("src/renderer/src/web/WebTimeline.tsx", "utf8"), /scroll-to-bottom|ScrollDown|scrollToBottom/);
});

test("Project actions are sibling buttons instead of nested controls", () => {
	assert.match(webSidebar, /project-row-actions[\s\S]*?<Button/);
	assert.doesNotMatch(webSidebar, /project-row-actions[\s\S]*?<span[\s\S]*?role="button"/);
});

// 回归：孤儿 catalog 记录（projectId 不匹配任何项目）必须出现在「未分组」兜底分组里，
// 而不是在侧栏完全不可见。会话行与项目内会话复用同一渲染路径（含运行态圆点 + 点击打开）。
test("Web sidebar groups orphan sessions under an ungrouped fallback", () => {
	assert.match(webSidebar, /t\("web\.ungrouped"\)/);
	assert.match(webSidebar, /projectIds\.has\(session\.projectId\)/);
	assert.match(webSidebar, /const ungroupedSessions = useMemo\(/, "ungrouped sessions must be derived from sessions whose projectId matches no registered project");
	// 未分组分组用与项目内会话相同的 SessionRows 渲染（运行态圆点 + 可点击打开）。
	assert.match(webSidebar, /sessions=\{ungroupedSessions\}/);
	assert.match(webSidebar, /onSelect=\{props\.onSelectSession\}/);
	// 未分组分组不会在无孤儿记录时显示，避免空标题占位。
	assert.match(webSidebar, /ungroupedSessions\.length > 0/);
});

// 回归（第四批视觉打磨）：过程行无框化 + 身份色。web.css 曾经给 .tool-card/.thinking-block
// 加边框+面板底做成「卡片」，与桌面 timeline.css 的无框过程行哲学冲突，此处锁定回收后的形态。
test("Web timeline keeps tool cards and thinking rows frameless with identity colors", () => {
	// 工具卡/思考块不画外框、不铺面板底（视觉对齐桌面过程行）。
	assert.match(webCss, /\.web-app \.tool-card\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;\s*\}/);
	assert.doesNotMatch(webCss, /\.web-app \.tool-card,\s*[\s\S]*?\.thinking-block\s*\{[\s\S]*?background:\s*var\(--color-bg-panel\)/);
	// 身份色变量必须在 web.css 的两套 :root 覆盖里显式声明（亮/暗各一份），
	// 否则图标掉回灰字（timeline.css 的 .tool-card-icon 引用这些变量）。
	const rootBlocks = webCss.match(/:root[^{]*\{[\s\S]*?\}/g) ?? [];
	assert.ok(rootBlocks.length >= 2, `expected >=2 :root blocks in web.css, got ${rootBlocks.length}`);
	for (const block of rootBlocks) {
		assert.match(block, /--color-tool:\s*var\(--color-info\)/, "every web :root override must redeclare --color-tool");
		assert.match(block, /--color-thinking:/, "every web :root override must redeclare --color-thinking");
	}
	// running 呼吸 + 错误染色走 tone-/data- 状态类（与桌面 timeline 同构）。
	assert.match(webCss, /tone-running \.tool-card-icon[\s\S]*?animation:\s*tool-icon-breathe/);
	assert.match(webCss, /tone-error \.tool-card-icon[\s\S]*?color:\s*var\(--color-danger\)/);
});

// 回归：状态 pill 在 flex-col 标题块里必须 self-start，否则被 stretch 拉成整行横条。
test("Web header status pill stays compact inside the flex-col title block", () => {
	assert.match(webHeader, /agent-status-indicator self-start/);
});

// 回归：三条 strip 默认折叠、无框化，且不使用不存在的 Tailwind token
// （bg-bg-surface/text-text-muted/bg-bg-inset 曾是静默 no-op，样式从未生效）。
test("Web session strips stay collapsed by default and use real tokens only", () => {
	assert.match(webSessionStrips, /useState\(false\)/, "StripShell must default to collapsed on mobile");
	assert.doesNotMatch(webSessionStrips, /bg-bg-surface|text-text-muted|bg-bg-inset/, "these tokens do not exist in the theme bridge — they silently no-op");
	// 折叠条只占一行：标题行可点（aria-expanded），明细展开后才渲染。
	assert.match(webSessionStrips, /aria-expanded=\{open\}/);
});
