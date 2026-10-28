import { expect, type Page } from "@playwright/test";
import { test as fixture } from "./fixtures";

/**
 * 全局文字抗锯齿口径。
 *
 * 背景：macOS 从 Mojave 起不再做次像素彩边合成，`-webkit-font-smoothing` 在今天的 mac 上
 * 只影响字形粗细，不产生彩边。历史上 body 写的是 antialiased（理由「消除彩色边缘」），
 * 代价是亮字压暗底时笔画偏细、观感发虚——暗色主题下尤其明显。
 *
 * 覆盖面按用户实际反馈的三块走：侧栏列表、会话区、设置弹框。三者都靠继承 body 生效，
 * 没有任何一处单独声明过抗锯齿口径（仓库里只有 .detail-drawer / .drawer-content-frame /
 * .config-modal / .config-pane / CodeMirror 五处例外，方向都是「改回子像素」）。
 * 这里用真实渲染结果守住口径，而不是只读源码里的字符串。
 */
const EXPECTED = "subpixel-antialiased";

async function readSmoothing(window: Page) {
	return window.evaluate(() => {
		const score = (selector: string) => {
			const element = document.querySelector(selector);
			return element ? getComputedStyle(element).webkitFontSmoothing : null;
		};
		return {
			theme: document.documentElement.dataset.theme,
			body: getComputedStyle(document.body).webkitFontSmoothing,
			sidebarItem: score(".sidebar-body button, .list-toolbar button"),
			chatPane: score(".chat-pane"),
		};
	});
}

for (const theme of ["dark", "light"] as const) {
	fixture.describe(`font smoothing (${theme})`, () => {
		fixture.use({
			seedProjects: [{ id: "font-project", name: "FontProject", path: process.cwd() }],
			seedSettings: { theme, language: "zh-CN" },
		});

		fixture("sidebar, chat pane and settings dialog all render with subpixel antialiasing", async ({ window }) => {
			await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

			const shell = await readSmoothing(window);
			expect(shell.theme).toBe(theme);
			expect(shell.body).toBe(EXPECTED);
			// 侧栏与会话区继承同一口径，不能再被局部规则改成灰阶
			expect(shell.sidebarItem).toBe(EXPECTED);
			if (shell.chatPane) expect(shell.chatPane).toBe(EXPECTED);

			// 设置弹框自己没有任何抗锯齿声明，只跟随 body；历史回归正是从它的观感被发现的。
			await window.getByRole("button", { name: /^设置/ }).first().click();
			await expect(window.locator(".settings-modal")).toBeVisible();
			const dialogSmoothing = await window.locator(".settings-modal").evaluate((element) => getComputedStyle(element).webkitFontSmoothing);
			expect(dialogSmoothing).toBe(EXPECTED);
			const tabSmoothing = await window.locator(".settings-modal [role='tab']").first().evaluate((element) => getComputedStyle(element).webkitFontSmoothing);
			expect(tabSmoothing).toBe(EXPECTED);
		});
	});
}
