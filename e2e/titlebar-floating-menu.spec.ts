import { test, expect } from "./mock-pi-fixture";
import { makeSeedProject } from "./open-session";

/**
 * 回归：侧栏右键菜单被 flip 到视口上沿时，首项不能落进自定义标题栏的拖拽热区。
 *
 * `.window-drag-layer` 是一条 `--window-drag-height`(40px) 高的 `-webkit-app-region: drag`
 * 透明矩形；Electron 把 app-region 矩形按顺序合成一张 SkRegion（drag 并集 / no-drag 差集，
 * 与 z-index 无关），压在热区上的那一截照样点不动——菜单画得上去，首项却没响应。
 * 所以这里钉几何：菜单（以及首项）的顶边必须在热区下沿以下。
 *
 * 复现手法：窗口缩到最小尺寸（880×640）+ 窗口缩放 150%（设置里允许的最大档，CSS 视口
 * 587×427）后，右键列表靠下的历史会话。会话右键菜单比下方剩余空间更高，Radix 会 flip 到
 * 上方再被视口上沿 clamp，正是用户报的「只有第一项点不动」。
 * 拖拽命中本身在浏览器进程侧、不产生 DOM 事件，Playwright 断言不到；那半由
 * tests/titlebarFloatingHitTest.test.mjs 的 no-drag 守卫覆盖。
 */
const project = makeSeedProject("titlebar-floating-menu");
const titles = ["会话-A", "会话-B", "会话-C", "会话-D", "会话-E"];
const seedSessionFiles = titles.map((title, index) => ({
	projectPath: project.path,
	fileName: `history-${index}.jsonl`,
	entries: [
		{ type: "session", version: 3, id: `history-${index}`, parentId: null, name: title, cwd: project.path, timestamp: new Date(Date.now() + index * 1000).toISOString() },
		{ type: "message", id: "u1", parentId: `history-${index}`, message: { role: "user", content: [{ type: "text", text: `${title} 的问题` }] }, timestamp: new Date().toISOString() },
	],
}));

// 缩放从设置里预置（而不是运行时 setZoomFactor）：启动即生效，不受应用自身的缩放恢复时序影响。
test.use({ seedProjects: [project], seedSessionFiles: async ({}, use) => use(seedSessionFiles), seedSettings: { zoomFactor: 1.5 } });

test("sidebar context menu keeps its first item below the titlebar drag region", async ({ app, window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("tab", { name: "项目", exact: true }).click();
	await window.locator(".conversation", { hasText: project.name }).first().click();
	await expect(window.locator(".history-session-row")).toHaveCount(titles.length);

	// 最小窗口 + 150% 缩放：会话右键菜单（含运行控制/文件操作等条件项）比下方剩余空间更高，
	// flip 到上方后会被视口上沿 clamp 进标题栏热区。
	const mainWindow = await app.browserWindow(window);
	await mainWindow.evaluate((win) => {
		const [x, y] = win.getPosition();
		win.setBounds({ x, y, width: 880, height: 640 });
	});
	await window.waitForTimeout(600);

	const row = window.locator(".history-session-row", { hasText: titles[titles.length - 1] });
	await expect(row).toBeVisible();
	await row.click({ button: "right" });

	const menu = window.locator('[data-slot="dropdown-menu-content"]');
	await expect(menu).toBeVisible();

	const geometry = await menu.evaluate((el) => {
		const content = el.getBoundingClientRect();
		const firstItem = el.querySelector('[role="menuitem"]')?.getBoundingClientRect();
		const dragLayer = document.querySelector(".window-drag-layer")?.getBoundingClientRect();
		if (!firstItem || !dragLayer) throw new Error("missing first item or drag layer");
		return {
			side: el.getAttribute("data-side"),
			dragStrip: { top: dragLayer.top, bottom: dragLayer.bottom },
			menu: { top: content.top, bottom: content.bottom },
			firstItem: { top: firstItem.top, bottom: firstItem.bottom },
			viewportHeight: window.innerHeight,
		};
	});

	// 前提：热区确实存在，且菜单真的被排到了触发器上方（否则这条用例没测到目标场景）。
	expect(geometry.dragStrip.top).toBe(0);
	expect(geometry.dragStrip.bottom).toBeGreaterThan(0);
	expect(geometry.side).toBe("top");
	// 菜单整体（含首项）必须落在热区下沿以下：collisionPadding 让位生效。
	expect(geometry.menu.top).toBeGreaterThanOrEqual(geometry.dragStrip.bottom);
	expect(geometry.firstItem.top).toBeGreaterThanOrEqual(geometry.dragStrip.bottom);
	expect(geometry.firstItem.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
});
