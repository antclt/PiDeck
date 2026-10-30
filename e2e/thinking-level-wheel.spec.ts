import { test, expect } from "./mock-pi-fixture";
import { settleStartupOverlays } from "./startupOverlays";
import type { Locator, Page } from "@playwright/test";

async function wheelOn(window: Page, target: Locator, deltaY: number, keepVisible?: Locator) {
	const box = await target.boundingBox();
	if (!box) throw new Error("目标元素没有可见盒子，无法发滚轮事件");
	await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await window.mouse.wheel(0, deltaY);
	// 弹层必须在滚完仍在：启动期浮层（命令面板首次引导的 Radix Dialog）会抢焦点，
	// Radix 把它判成 focus-outside 后立刻关闭本弹层；缺这条断言时失败表现为下一次
	// boundingBox 超时（「弹层没了」的信号迟到一轮），排查成本极高。
	if (keepVisible) await expect(keepVisible).toBeVisible();
}

const valueNow = async (slider: Locator) => Number(await slider.getAttribute("aria-valuenow"));

/** 端点下标直接从滑条读：档位表随模型的能力上报变化，写死会在换模型/换 pi 目录时假红。 */
const maxIndex = async (slider: Locator) => Number(await slider.getAttribute("aria-valuemax"));

async function wheelToEdge(window: Page, slider: Locator, deltaY: number, keepVisible?: Locator) {
	const max = await maxIndex(slider);
	const target = deltaY > 0 ? 0 : max;
	// 一格一档，从一端到另一端最多 max 次；多给一次余量兜底「开局就在另一端」的情形
	for (let attempt = 0; attempt <= max + 1; attempt += 1) {
		if ((await valueNow(slider)) === target) return;
		await wheelOn(window, slider, deltaY, keepVisible);
	}
	throw new Error(`滚轮未到达端点 ${target}，当前 ${await valueNow(slider)}`);
}

async function openThinkingPopover(window: Page) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	// 先把启动浮层弹完并关掉，再开档位弹层：引导是 Radix Dialog + FocusScope，
	// 中途弹出会抢走滑条焦点，导致本弹层被 focus-outside 判定时关闭。
	await settleStartupOverlays(window);
	const trigger = window.getByRole("button", { name: "选择思考级别" });
	await expect(trigger).toBeEnabled({ timeout: 30_000 });
	const appliedBefore = (await trigger.innerText()).trim();
	await trigger.click();
	const content = window.locator('[data-slot="popover-content"]');
	await expect(content).toBeVisible({ timeout: 5_000 });
	return { trigger, content, appliedBefore, slider: content.getByRole("slider"), ticks: content.locator("[data-tick-value]") };
}

test("滚轮上滚一格 = 增大一档、下滚一格 = 减小一档；全程不关闭弹层", async ({ window }) => {
	test.setTimeout(120_000);
	const { content, slider } = await openThinkingPopover(window);

	await wheelToEdge(window, slider, 100, content);
	expect(await valueNow(slider)).toBe(0);

	await wheelOn(window, slider, -100, content);
	await expect(slider).toHaveAttribute("aria-valuenow", "1");
	await expect(content).toBeVisible();

	await wheelOn(window, slider, 100, content);
	await expect(slider).toHaveAttribute("aria-valuenow", "0");
	await expect(content).toBeVisible();
});

test("端点不越界：已在 max 继续上滚仍停在 max", async ({ window }) => {
	test.setTimeout(120_000);
	const { content, slider } = await openThinkingPopover(window);
	const max = await maxIndex(slider);

	await wheelToEdge(window, slider, -100, content);
	expect(await valueNow(slider)).toBe(max);
	for (let i = 0; i < 3; i += 1) await wheelOn(window, slider, -100, content);
	expect(await valueNow(slider)).toBe(max);
});

test("滚轮只改弹层内预览；关闭弹层才应用到触发器", async ({ window }) => {
	test.setTimeout(120_000);
	const { trigger, content, slider, ticks, appliedBefore } = await openThinkingPopover(window);

	await wheelToEdge(window, slider, 100, content);
	await wheelOn(window, slider, -100, content);
	await expect(slider).toHaveAttribute("aria-valuenow", "1");
	expect((await trigger.innerText()).trim()).toBe(appliedBefore);

	// 期望文案从刻度标签行同一下标读取，不与档位表里写死「minimal」
	const expectedLabel = (await ticks.nth(1).innerText()).trim();
	await window.keyboard.press("Escape");
	await expect(content).toBeHidden({ timeout: 5_000 });
	await expect(trigger).toHaveText(expectedLabel, { timeout: 10_000 });
});
