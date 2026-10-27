import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./mock-pi-fixture";

/**
 * 带空格本地路径的内联链接渲染验证（真实 DOM，非单测）。
 *
 * 为什么必须有这一层：单测只能证明 remark 插件产出的 mdast 正确，
 * 证明不了「界面上真的渲染成可点击链接」。这里用真实会话文件 + 真实渲染管线，
 * 断言时间线里出现 <a> 且不再残留原始 `[label](path)` 语法。
 *
 * 覆盖两种失败原因（互相独立）：
 *  A. 括号成对 + 空格（`Program Files (x86)`）—— CommonMark 因空格放弃；
 *  B. 括号不成对（`My App (x86`）—— CommonMark 因括号不配对放弃。
 */
const spaceDir = mkdtempSync(join(tmpdir(), "pideck-spacepath-"));
const nested = join(spaceDir, "Program Files (x86)", "My App");
mkdirSync(nested, { recursive: true });
const readmePath = join(nested, "README.md");
writeFileSync(readmePath, "# README\n\nspace-path marker-ok\n");
const forward = readmePath.replace(/\\/g, "/");

// 不成对括号形态：把 `(x86)` 的右括号删掉
const unpaired = forward.replace("(x86)", "(x86");

const assistantText = ["产物清单（括号成对 + 空格）：", `[README.md](${forward}) — 结构化属性`, "不成对括号形态：", `[README.md](${unpaired}) — 说明文字`].join("\n\n");

// 不带空格的盘符路径：CommonMark 能正常解析、不走恢复路径，但裸 `C:/` 会被
// rehype-sanitize 当成未知协议 `c:` 剥掉 href（同症状、不同入口）。
const noSpaceDir = mkdtempSync(join(tmpdir(), "pideck-nospacepath-"));
const noSpaceFile = join(noSpaceDir, "README.md");
writeFileSync(noSpaceFile, "# README\n\nno-space-path marker-ok\n");
const noSpaceForward = noSpaceFile.replace(/\\/g, "/");
const assistantTextWithNoSpace = `${assistantText}\n\n盘符路径（不带空格）：\n\n[README.md](${noSpaceForward})`;

test.use({
	seedProjects: [{ id: "p-space", name: "spacepath", path: spaceDir }],
	seedSessionFiles: [
		{
			projectPath: spaceDir,
			entries: [
				{
					type: "session",
					version: 3,
					id: "s1",
					parentId: null,
					name: "空格路径渲染验证",
					cwd: spaceDir,
					timestamp: new Date(Date.now() - 60_000).toISOString(),
				},
				{
					type: "message",
					id: "m1",
					parentId: "s1",
					timestamp: new Date(Date.now() - 59_000).toISOString(),
					message: { role: "user", content: [{ type: "text", text: "空格路径验证" }] },
				},
				{
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: new Date(Date.now() - 58_000).toISOString(),
					message: { role: "assistant", content: [{ type: "text", text: assistantTextWithNoSpace }] },
				},
			],
		},
	],
});

test("带空格本地路径渲染成可点击链接，且不残留原始语法", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 30_000 });
	await window.getByRole("tab", { name: "项目" }).click();
	const projectRow = window.getByRole("button", { name: "spacepath" }).first();
	await expect(projectRow).toBeVisible({ timeout: 20_000 });
	await window.getByRole("button", { name: "展开", exact: true }).first().click();
	await window.waitForTimeout(1200);

	const historyRow = window.locator(".conversation", { hasText: "空格路径渲染验证" }).first();
	await expect(historyRow).toBeVisible({ timeout: 20_000 });
	await historyRow.click();

	const timeline = window.locator(".message-timeline");
	await expect(timeline).toContainText("产物清单", { timeout: 20_000 });

	// A. 括号成对 + 空格 → 必须渲染成链接
	const paired = timeline.getByRole("link", { name: "README.md" }).first();
	await expect(paired).toBeVisible({ timeout: 15_000 });
	const href = await paired.getAttribute("href");
	expect(href ?? "").toContain("Program");

	// 不再残留原始 markdown 语法
	await expect(timeline).not.toContainText("[README.md](");

	// 必须被识别成「文件链接」：cursor-pointer + 等宽高亮（= MarkdownLink 生效，而不是无 href 的空 <a>）
	const cls = (await paired.getAttribute("class")) ?? "";
	expect(cls).toContain("cursor-pointer");
	expect(cls).toContain("font-mono");

	// 右键菜单必须可用（复制绝对路径 / 在资源管理器打开）—— 空 href 的 <a> 不会有这层
	await paired.click({ button: "right" });
	await expect(window.getByText("复制绝对路径")).toBeVisible({ timeout: 10_000 });
	await expect(window.getByText("在资源管理器打开")).toBeVisible();
	await window.keyboard.press("Escape");
	// 点击应打开文件并显示真实内容
	await paired.click();
	const stage = window.locator(".workbench-stage-split").first();
	await expect(stage).toBeVisible({ timeout: 15_000 });
	await expect(stage).toContainText("space-path marker-ok", { timeout: 10_000 });

	// 不带空格的盘符路径（解析能成功、不走恢复路径）同样必须是文件链接：
	// 裸 `C:/` 会被 rehype-sanitize 当成未知协议 `c:` 剥掉 href，渲染出没有 href 的死 <a>。
	const noSpaceLink = timeline.getByRole("link", { name: "README.md" }).last();
	const noSpaceHref = (await noSpaceLink.getAttribute("href")) ?? "";
	expect(noSpaceHref.startsWith("file://")).toBe(true);
	expect(((await noSpaceLink.getAttribute("class")) ?? "").includes("cursor-pointer")).toBe(true);
	await noSpaceLink.click();
	await expect(stage).toContainText("no-space-path marker-ok", { timeout: 10_000 });
});
