import { test, expect } from "./fixtures";
import { openSettings } from "./open-session";

/**
 * 设置页侧栏搜索：输入 → 命中条目 → 切到对应 tab 并滚到锚点高亮。
 *
 * 背景（issue 反馈）：设置项分散在 20+ 个 tab，不熟悉 Ctrl+P 的用户找不到开关；
 * 侧栏搜索要求支持中文、英文别名与拼音首字母（dl → 代理、ylcx → 用量查询）。
 * 打分内核由 tests/settingsSearch.test.mjs 覆盖，这里验证接线与真实跳转。
 */
async function openSearch(window: import("@playwright/test").Page) {
	await openSettings(window);
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();
	return { modal, input: modal.getByRole("combobox", { name: "搜索设置项" }) };
}

test("sidebar search jumps to a tab by pinyin", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await openSearch(window);
	const modal = window.locator(".settings-modal");
	const input = modal.getByRole("combobox", { name: "搜索设置项" });
	await input.fill("daili");

	const results = modal.getByRole("listbox", { name: "搜索设置项" });
	await expect(results).toBeVisible();
	// 「代理设置」tab 名全拼命中；tab 名通道保证它排在只靠关键词的条目之前
	const first = results.getByRole("option").first();
	await expect(first).toContainText("代理设置");

	// Enter 走选中项（无需鼠标），跳转后搜索框清空、tab 列表回来、目标 tab 激活
	await input.press("Enter");
	await expect(input).toHaveValue("");
	await expect(modal.getByRole("tab", { name: "代理设置" })).toHaveAttribute("aria-selected", "true");
});

test("sidebar search reaches a single setting and highlights its anchor", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const { modal, input } = await openSearch(window);
	// 英文关键词命中「启用桌面端网络代理」（settingsFieldAnchors 里的 desktop proxy）
	await input.fill("desktop proxy");
	const results = modal.getByRole("listbox", { name: "搜索设置项" });
	const option = results.getByRole("option", { name: /启用桌面端网络代理/ });
	await expect(option).toBeVisible();
	await option.click();

	// 落到代理设置 tab，并且目标行真的被定位（settings-anchor-flash 高亮 1.6s 后消失，故用短超时 poll）
	await expect(modal.getByRole("tab", { name: "代理设置" })).toHaveAttribute("aria-selected", "true");
	const anchor = modal.locator("#settings-section-proxy-enable-desktop");
	await expect(anchor).toBeVisible();
	await expect(anchor).toHaveClass(/settings-anchor-flash/, { timeout: 1200 });
});

test("sidebar search highlights the matched text for literal queries", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const { modal, input } = await openSearch(window);
	await input.fill("代理");
	const results = modal.getByRole("listbox", { name: "搜索设置项" });
	const first = results.getByRole("option").first();
	// 字面命中才标黄；拼音命中无法映射回汉字位置，不造假高亮（见 settingsSearch.ts）
	await expect(first.locator("mark")).toHaveText("代理");
	await expect(first).toContainText("代理设置");
});

test("sidebar search shows an empty state and clears via the clear button", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const { modal, input } = await openSearch(window);
	await input.fill("zzzzzzzz");
	await expect(modal.getByText("没有匹配的设置项")).toBeVisible();

	await modal.getByRole("button", { name: "清除" }).click();
	await expect(input).toHaveValue("");
	// 清空后回到 tab 列表
	await expect(modal.getByRole("tab").first()).toBeVisible();
});
