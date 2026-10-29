import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 2026-10-29 决定：定时任务 / 智能体 / 收藏 三个低频入口收进「更多」折叠组，
// 让会话列表回到首屏。此前 automationSidebarEntry.test.mjs 断言的是「平铺在
// 新建/搜索下方」的旧形态，那条仍保留（校验它们不再回到左下角 Dock），
// 这里补新契约：三个入口必须挂在折叠组内，且默认收起。
const sidebar = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");

test("低频入口收在「更多」折叠组内", () => {
	const toggleIndex = sidebar.indexOf("aria-controls=\"sidebar-more-actions\"");
	const groupIndex = sidebar.indexOf('id="sidebar-more-actions"');
	const automationIndex = sidebar.indexOf("<AutomationDockButton />");
	const agentIndex = sidebar.indexOf("<AgentMarketDockButton />");
	const favoritesIndex = sidebar.indexOf("<FavoritesDockButton />");

	assert.ok(toggleIndex > -1, "缺少「更多」折叠开关");
	assert.ok(groupIndex > toggleIndex, "折叠组容器应挂在开关之后");
	assert.ok(automationIndex > groupIndex, "定时任务入口应在折叠组内");
	assert.ok(agentIndex > groupIndex, "智能体入口应在折叠组内");
	assert.ok(favoritesIndex > groupIndex, "收藏入口应在折叠组内");
});

test("折叠组默认收起，开关带 aria-expanded", () => {
	assert.match(sidebar, /const \[moreActionsOpen, setMoreActionsOpen\] = useState\(false\)/, "折叠组默认应为收起");
	assert.match(sidebar, /aria-expanded=\{moreActionsOpen\}/, "开关必须暴露展开态");
	assert.match(sidebar, /\{moreActionsOpen \? \(/, "三个入口只在展开时渲染");
});

test("折叠组不吞掉宿主插件入口", () => {
	const groupEnd = sidebar.indexOf("<HostPluginDockButtons");
	const favoritesIndex = sidebar.indexOf("<FavoritesDockButton />");
	assert.ok(groupEnd > favoritesIndex, "宿主插件入口应留在折叠组之外（条件渲染，不属于低频三件套）");
});
