import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./mock-pi-fixture";

/**
 * 回归：文件预览「最大化 → 关闭」后会话面板必须恢复满宽。
 * 现场（2026-10-21）：右侧文件树点开 markdown → 占满中间栏 → 在最大化状态点关闭，
 * 会话面板只回到 ~48%，右半边空白；再打开一个文件后关闭才恢复。
 */
const projectDir = mkdtempSync(join(tmpdir(), "pideck-seed-wbclose-"));
writeFileSync(join(projectDir, "note.md"), ["# Note", "", "hello", ""].join("\n"));

test.use({
	seedProjects: [{ id: "p1", name: "workbench-close", path: projectDir }],
});

test("closing the maximized file preview restores the session pane to full width", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	await window.getByRole("tab", { name: "项目" }).click();
	const projectItem = window.locator(".conversation", { hasText: "pideck-seed-wbclose-" }).first();
	await expect(projectItem).toBeVisible({ timeout: 20_000 });
	await projectItem.click();
	await projectItem.hover();
	await projectItem.getByRole("button", { name: "普通会话" }).first().click();

	const toggle = window.locator(".header-drawer-toggle").first();
	await expect(toggle).toBeVisible();
	await toggle.click();
	const drawer = window.locator(".detail-drawer");
	await expect(drawer).toHaveAttribute("data-open", "true");

	const refreshButton = drawer.getByRole("button", { name: /刷新/ }).first();
	await refreshButton.click().catch(() => undefined);
	const fileRow = drawer.locator(".file-node-row", { hasText: "note.md" }).first();
	await expect(fileRow).toBeVisible({ timeout: 15_000 });
	await fileRow.click();

	const stage = window.locator(".workbench-stage-split").first();
	await expect(stage).toBeVisible({ timeout: 15_000 });
	const sessionPane = window.locator(".workbench-session-pane").first();
	const sessionRatio = async () => {
		const box = await sessionPane.boundingBox();
		const stageBox = await stage.boundingBox();
		if (!box || !stageBox || stageBox.width === 0) return 0;
		return box.width / stageBox.width;
	};

	// 打开时是 split
	await expect.poll(sessionRatio, { timeout: 5_000 }).toBeGreaterThan(0.4);

	// 占满中间栏 → 会话面板收起
	const maximizeBtn = window.getByRole("button", { name: "占满中间栏" });
	await expect(maximizeBtn).toBeVisible({ timeout: 10_000 });
	await maximizeBtn.click();
	await expect.poll(sessionRatio, { timeout: 5_000 }).toBeLessThan(0.05);

	// 最大化状态下关闭文件 → 应回到「无内容」：会话面板占满整条 stage
	const closeBtn = window.locator(".file-diff-header-actions").getByRole("button", { name: "关闭" }).first();
	await expect(closeBtn).toBeVisible({ timeout: 10_000 });
	await closeBtn.click();
	await expect(window.locator(".workbench-stage-with-content")).toHaveCount(0, { timeout: 10_000 });
	await expect.poll(sessionRatio, { timeout: 5_000 }).toBeGreaterThan(0.95);
});
