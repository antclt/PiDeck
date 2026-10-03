import { test, expect } from "./fixtures";

test.use({
	seedSettings: {
		// 跳过首次启动的 pi 环境检测引导弹窗（会遮挡侧栏设置入口）
		piEnvironmentChecked: true,
	},
});

/**
 * 会话 Tab 栏字号：弹窗实时预览 + 放弃回滚 + 保存后即时生效回归。
 *
 * v0.7.8 发布前用户反馈「改了之后没变化」：保存链路（Select → draft → saveAll →
 * settings:update → onSettingsApplied → useAppAppearance → html[data-tab-font-size] →
 * CSS --font-size-tab → .session-tab 的 text-tab）验证完好，真因是字号不在弹窗实时
 * 预览范围（主题色却即时预览）——选档位时界面毫无反应，被误认为设置无效。
 * 修复：字号纳入实时预览（与 useAppAppearance 共用 applyFontSizeAttributes）+
 * 放弃时回滚。本用例从 UI 驱动三段行为，任何一环断裂都会在这里现形。
 */
test("tab bar font size change applies immediately after save", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 默认未单独设置：跟随界面字号 medium（12px）
	await expect(window.locator("html")).toHaveAttribute("data-tab-font-size", "medium");
	await expect(await window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-size-tab").trim())).toBe("12px");

	await window.getByRole("button", { name: "设置", exact: true }).click();
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();

	await modal.getByText("外观设置").click();

	// 「自定义各区域字号」开关：开启后才渲染 界面/Tab 栏/会话/输入 字号四行
	const perAreaSwitch = modal.locator("div.min-h-\\[54px\\]").filter({ hasText: "自定义各区域字号" }).getByRole("switch");
	if (!(await perAreaSwitch.isChecked())) {
		await perAreaSwitch.click();
	}

	// 「会话 Tab 栏字号」行（SettingRow 网格）内的 Select trigger
	const row = modal.locator("div.min-h-\\[54px\\]").filter({ hasText: "会话 Tab 栏字号" });
	await expect(row).toHaveCount(1);
	await row.getByRole("combobox").click();

	// Radix Select 弹层 portal 到 body
	await window.getByRole("option", { name: "紧凑" }).click();

	// 实时预览：选档位后、保存前界面立即变化（v0.7.8 用户反馈「改了没变化」的根因：
	// 字号此前不在弹窗实时预览范围内，主题色却即时预览，体验不一致）
	await expect(window.locator("html")).toHaveAttribute("data-tab-font-size", "compact");
	await expect(await window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-size-tab").trim())).toBe("10px");

	// 放弃回滚：改「特大」（未保存）→ 关闭弹窗 → 选「放弃更改」→ 预览回滚为打开弹窗时的快照 medium
	// （compact 只选过未保存，快照始终是 medium）
	await row.getByRole("combobox").click();
	await window.getByRole("option", { name: "特大" }).click();
	await expect(window.locator("html")).toHaveAttribute("data-tab-font-size", "xlarge");
	await modal.getByRole("button", { name: "关闭" }).first().click();
	await window.getByRole("button", { name: "放弃更改" }).click();
	await expect(modal).toHaveCount(0);
	await expect(window.locator("html")).toHaveAttribute("data-tab-font-size", "medium");

	// 重新打开：改为「大」并保存，验证保存链（onSettingsApplied → useAppAppearance 接管）。
	// 快照里各区域字号均为 null，重开弹窗时「自定义各区域字号」开关回到关，需重新打开
	await window.getByRole("button", { name: "设置", exact: true }).click();
	await expect(modal).toBeVisible();
	await modal.getByText("外观设置").click();
	if (!(await perAreaSwitch.isChecked())) {
		await perAreaSwitch.click();
	}
	await row.getByRole("combobox").click();
	await window.getByRole("option", { name: "大", exact: true }).click();
	await modal.getByRole("button", { name: "保存" }).click();

	// 保存后即时生效：dataset 档位 + CSS 变量计算值同时更新为大档 13px
	await expect(window.locator("html")).toHaveAttribute("data-tab-font-size", "large");
	await expect(await window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-size-tab").trim())).toBe("13px");

	// 关闭弹窗后保持；若界面上已渲染会话 Tab：其计算字号必须是 13px（utility .text-tab 消费链）
	await modal.getByRole("button", { name: "关闭" }).first().click();
	await expect(modal).toHaveCount(0);
	await expect(window.locator("html")).toHaveAttribute("data-tab-font-size", "large");
	const tabCount = await window.locator(".session-tab").count();
	if (tabCount > 0) {
		const fontSize = await window
			.locator(".session-tab")
			.first()
			.evaluate((el) => getComputedStyle(el).fontSize);
		expect(fontSize).toBe("13px");
	}
});
