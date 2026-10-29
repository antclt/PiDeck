import { test, expect } from "./mock-pi-fixture";
import type { Page } from "@playwright/test";

/**
 * 状态条「已运行」秒表（2026-10 用户反馈回归）。
 *
 * 背景：本轮实时耗时原先挂在 TurnRow 末尾（LiveDuration），用户觉得「单独吊在
 * 最底部有点突兀」；现在与「正在执行命令…」收进状态条同一行，轮末只保留固定耗时。
 * 产品契约（真实 DOM，不扫源码）：
 * 1) 本轮进行中，状态条有「已运行 Ns」，且读数会增长（不是静态占位）；
 * 2) 进行中**不能**同时在轮末显示秒表——同一个数字只能有一处；
 * 3) 本轮结束后状态条读数消失，轮末出现唯一的固定耗时。
 *
 * 用 mock pi 的 `SLOW` 节奏（220ms × 18 ≈ 4s）撑出轮内断言窗口。
 */
async function startAgent(window: Page) {
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	return composer;
}

test("elapsed timer lives in the status bar only while the turn runs", async ({ window }) => {
	test.setTimeout(90_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = await startAgent(window);
	const timeline = window.locator(".message-timeline");

	await composer.click();
	await window.keyboard.type("SLOW 状态条秒表");
	await window.keyboard.press("Enter");

	// 1. 轮内：状态条出现「已运行」，并带解释性 title（悬停才知道数的是什么）
	const elapsed = timeline.locator(".responding-fact", { hasText: "已运行" });
	await expect(elapsed).toBeVisible({ timeout: 15_000 });
	await expect(elapsed).toHaveAttribute("title", /不含等待你回答的时长/);

	// 读数必须真的在走：两次采样不同（SLOW 流约 4s，足够跨过整秒边界）
	const firstReading = (await elapsed.textContent())?.trim() ?? "";
	await expect.poll(async () => (await elapsed.textContent())?.trim() ?? "", { timeout: 8_000 }).not.toBe(firstReading);

	// 2. 轮内：轮末不能同时挂秒表（唯一读数点纪律）
	const runningRow = timeline.locator(".turn-row").last();
	await expect(runningRow.locator("svg.lucide-clock")).toHaveCount(0);

	// 3. 收尾：状态条读数消失，轮末出现且只出现一个固定耗时
	await expect(timeline).toContainText("流式渲染验证完成", { timeout: 20_000 });
	await expect(timeline.locator(".responding-suffix")).toHaveCount(0);
	await expect(runningRow.locator("svg.lucide-clock")).toHaveCount(1, { timeout: 15_000 });
	await expect(runningRow.locator("svg.lucide-clock + span")).toHaveText(/^\d+(\.\d)?[smh]/, { timeout: 10_000 });

	// 4. 固定耗时必须是真实回合耗时，而不是 0（回归：assistant.timestamp 是请求开始，
	//    旧实现 endedAt - startedAt 恒为 0，轮末从来不出数）。SLOW 流本身约 4s。
	const settled = (await runningRow.locator("svg.lucide-clock + span").textContent())?.trim() ?? "";
	const settledSeconds = settled.endsWith("m") ? Number.parseFloat(settled) * 60 : settled.endsWith("h") ? Number.parseFloat(settled) * 3600 : Number.parseFloat(settled);
	expect(settledSeconds, `轮末固定耗时应为真实回合时长（实际读到 ${settled}）`).toBeGreaterThanOrEqual(3);
});

test("settled elapsed survives a reload from history", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = await startAgent(window);
	await composer.click();
	await window.keyboard.type("SLOW 历史耗时回放");
	await window.keyboard.press("Enter");

	const timeline = window.locator(".message-timeline");
	await expect(timeline).toContainText("流式渲染验证完成", { timeout: 30_000 });
	const clock = timeline.locator(".turn-row").last().locator("svg.lucide-clock + span");
	await expect(clock).toHaveText(/^\d+(\.\d)?[smh]/, { timeout: 15_000 });

	// 历史回放走的是 JSONL 投影路径（assistant.timestamp = 请求开始，只有 meta.endedAt
	// 记录真实结束点）；重载后仍应显示真实回合耗时，而不是 0。
	await window.reload();
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 30_000 });
	await window
		.getByRole("button", { name: /SLOW 历史耗时回放/ })
		.first()
		.click();
	await expect(timeline).toContainText("流式渲染验证完成", { timeout: 30_000 });
	const restored = timeline.locator(".turn-row").last().locator("svg.lucide-clock + span");
	await expect(restored).toHaveText(/^\d+(\.\d)?[smh]/, { timeout: 15_000 });
	const text = (await restored.textContent())?.trim() ?? "";
	expect(Number.parseFloat(text), `重载后轮末耗时应保持真实值（实际 ${text}）`).toBeGreaterThanOrEqual(3);
});
