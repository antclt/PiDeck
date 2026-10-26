import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./mock-pi-fixture";

/**
 * 侧栏「项目」分组标题栏冻结回归。
 *
 * 背景：设置里开启「侧栏分组标题栏冻结」后，聊天区标题栏正常冻结，项目区标题栏却
 * 仍随列表滚走。原因是 sticky 元素只在其包含块内粘附：项目区标题栏外面那层纯逻辑
 * 包裹 <div> 只罩住标题栏自身，包含块在滚动一开始就到头。
 *
 * 断言必须建立在「列表真的滚动了」之上，否则会出现「没滚也算粘住」的假通过。
 */
const projectDir = mkdtempSync(join(tmpdir(), "pideck-sticky-header-"));
const SESSION_COUNT = 40;

test.use({
	seedSettings: { sidebarStickyGroupHeaders: true },
	seedProjects: [{ id: "p-sticky", name: "stickyproj", path: projectDir }],
	seedSessionFiles: async ({}, use) => {
		await use(
			Array.from({ length: SESSION_COUNT }, (_, i) => ({
				projectPath: projectDir,
				fileName: `seed-${i}.jsonl`,
				entries: [
					{
						type: "session",
						version: 3,
						id: `s${i}`,
						parentId: null,
						name: `冻结验证会话 ${i + 1}`,
						cwd: projectDir,
						timestamp: new Date(Date.now() - (SESSION_COUNT - i) * 60_000).toISOString(),
					},
					{
						type: "message",
						id: `m${i}`,
						parentId: `s${i}`,
						timestamp: new Date(Date.now() - (SESSION_COUNT - i) * 59_000).toISOString(),
						message: { role: "user", content: [{ type: "text", text: `填充 ${i}` }] },
					},
				],
			})),
		);
	},
});

test("项目分组标题栏在列表滚动后仍停在顶部", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 30_000 });
	await window.getByRole("tab", { name: "项目" }).click();
	await window.getByRole("button", { name: "stickyproj" }).first().waitFor({ timeout: 20_000 });
	// 展开项目，让足够多的会话渲染出来，列表才真的有滚动空间
	await window.getByRole("button", { name: "展开", exact: true }).first().click();
	await window.waitForTimeout(1000);
	// 侧栏会话列表有分页（默认 6 条 + 「查看更多」），点开直到全部展开，列表才够高到可滚
	for (let i = 0; i < 6; i++) {
		const more = window.getByRole("button", { name: /查看更多/ });
		if ((await more.count()) === 0) break;
		await more.first().click();
		await window.waitForTimeout(400);
	}

	const result = await window.evaluate(() => {
		const list = document.querySelector(".conversation-list") as HTMLElement | null;
		if (!list) return { error: "no list" };
		const listTop = list.getBoundingClientRect().top;
		const sticky = Array.from(list.querySelectorAll("div")).find((d) => getComputedStyle(d).position === "sticky") as HTMLElement | undefined;
		if (!sticky) return { error: "no sticky header" };
		const wrap = sticky.parentElement as HTMLElement;
		list.scrollTop = 0;
		const before = sticky.getBoundingClientRect().top - listTop;
		list.scrollTop = 200;
		const movedScrollTop = list.scrollTop;
		const after = sticky.getBoundingClientRect().top - listTop;
		list.scrollTop = 0;
		return {
			scrollable: list.scrollHeight > list.clientHeight + 20,
			wrapDisplay: getComputedStyle(wrap).display,
			movedScrollTop,
			before: Math.round(before),
			after: Math.round(after),
		};
	});

	expect(result).not.toHaveProperty("error");
	// 前提：列表真的滚动了，排除「没滚也算粘住」的假通过
	expect(result.scrollable).toBe(true);
	expect(result.movedScrollTop).toBe(200);
	// 行为断言（放在实现断言之前：测试要因为「标题滚走了」而红，不因实现细节而红）
	expect(result.after).toBeLessThanOrEqual(1);
	// 实现约束：包裹层必须 display:contents，否则包含块只有标题栏高度
	expect(result.wrapDisplay).toBe("contents");
});
