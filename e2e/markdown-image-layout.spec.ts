import { expect, test } from "./mock-pi-fixture";
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeSeedProject } from "./open-session";

/**
 * Markdown 图片布局冒烟（2026-10，对话内图片渲染改造的机器守卫）。
 *
 * 为什么需要 e2e：这条链路的失败都发生在「单测看不到的中间层」——`mdast-util-to-hast`
 * 会把反斜杠编码成 %5C、streamdown 内部跑 `rehype-sanitize` 会剥掉非白名单属性、
 * Windows `app.getPath("temp")` 是 8.3 短名。三轮真机 smoke 才把它们逐个撞出来，
 * 所以这里用真实 Electron + 真实渲染管线断言**用户看得见的几何结果**：
 * 同段两张 → 两个 96×96 瓷砖且同一行；单图 → 高度 360 上限；点击 → 全屏预览可开可关。
 *
 * 布局规则照 dsh：单图 `max-width: min(100%, 640px)` + `max-height: 360px`，
 * 同段多图 96px 方块瓷砖（原始 64px 太小，按 PiDeck 观感放大）。
 */

const repoRoot = resolve(__dirname, "..");
const project = makeSeedProject("img-layout");
const imageDir = join(project.path, "img");
mkdirSync(imageDir, { recursive: true });
// 1254×1254 的正方图：单图规则下会被高度 360 约束成 360×360，瓷砖下被裁成 96×96
copyFileSync(join(repoRoot, "docs", "images", "88vip.png"), join(imageDir, "big.png"));

const now = Date.now();
const at = (offsetMs: number) => new Date(now - offsetMs).toISOString();

test.use({
	seedProjects: [project],
	seedSessionFiles: [
		{
			projectPath: project.path,
			entries: [
				{ type: "session", version: 3, id: "img-layout-h", parentId: null, name: "图片布局巡检", cwd: project.path, timestamp: at(60_000) },
				{ type: "message", id: "img-layout-1", parentId: "img-layout-h", timestamp: at(59_000), message: { role: "user", content: [{ type: "text", text: "图片布局巡检" }] } },
				{
					type: "message",
					id: "img-layout-2",
					parentId: "img-layout-1",
					timestamp: at(58_000),
					message: {
						role: "assistant",
						content: [
							{
								type: "text",
								text: [
									"## 标题",
									"",
									"同段两张：",
									"",
									"![甲](img/big.png) ![乙](img/big.png)",
									"",
									"单图上限：",
									"",
									"![丙](img/big.png)",
									"",
									"| 列 | 值 |",
									"| --- | --- |",
									"| 单元格 | 可见 |",
									"",
									"- 列表项",
									"",
									"```js",
									"const marker = 1;",
									"```",
									"",
									"[![链接里的图](img/big.png)](https://example.com/x)",
									"",
									"![外部](C:\\pideck-e2e-not-whitelisted\\a.png)",
								].join("\n"),
							},
						],
					},
				},
			],
		},
	],
});

test("markdown 图片布局：同段多图并排瓷砖、单图限高、点击开预览", async ({ window }) => {
	test.setTimeout(60_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 打开种子项目下的历史会话（不启动 agent）
	await window.getByRole("tab", { name: "项目" }).click();
	await window.locator(".conversation", { hasText: "img-layout" }).first().click();
	const historyRow = window.locator(".conversation", { hasText: "图片布局巡检" }).first();
	await expect(historyRow).toBeVisible({ timeout: 20_000 });
	await historyRow.click();

	const timeline = window.locator(".message-timeline");
	await expect(timeline).toContainText("同段两张", { timeout: 20_000 });

	const images = timeline.locator("img");
	// 甲 + 乙（同段瓷砖）、丙（单图）、链接里的图（图包在 a 里）
	await expect(images).toHaveCount(4, { timeout: 15_000 });

	// 图片真的加载成功（白图/破图会 naturalWidth 为 0）
	for (const index of [0, 1, 2]) {
		await expect.poll(() => images.nth(index).evaluate((node) => (node as HTMLImageElement).naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);
	}
	// 本地图必须走白名单协议，不许退回 file://
	await expect(images.nth(0)).toHaveAttribute("src", /^pideck-file:\/\//);

	// 同段两张：96×96 且同一行
	const first = await images.nth(0).boundingBox();
	const second = await images.nth(1).boundingBox();
	expect(first?.width).toBeCloseTo(96, 0);
	expect(first?.height).toBeCloseTo(96, 0);
	expect(second?.width).toBeCloseTo(96, 0);
	expect(second?.height).toBeCloseTo(96, 0);
	expect(Math.abs((first?.y ?? 0) - (second?.y ?? 0))).toBeLessThan(2);
	expect(second?.x ?? 0).toBeGreaterThan(first?.x ?? 0);

	// 单图：高度 360 上限（方图 → 360×360），宽度不超过 640
	const single = await images.nth(2).boundingBox();
	expect(single?.height).toBeCloseTo(360, 0);
	expect(single?.width).toBeCloseTo(360, 0);
	expect(single?.width ?? 0).toBeLessThanOrEqual(641);

	// 保存/复制要在渲染层拿到字节。pideck-file:// 是 corsEnabled:false 的自定义 scheme，
	// fetch 会被拦（曾经就是这么坏的），所以字节必须走 IPC；这条断言把「点保存没反应」挡在合并前。
	const probe = await window.evaluate(async () => {
		const node = document.querySelector(".message-timeline img") as HTMLImageElement | null;
		if (!node) return { error: "no image" };
		const path = new URL(node.src).searchParams.get("path") ?? "";
		const payload = await window.piDesktop.localImage.readBytes(path);
		return payload ? { bytes: payload.data.length, mimeType: payload.mimeType } : { error: "rejected" };
	});
	expect(probe).toMatchObject({ mimeType: "image/png" });
	expect(probe.bytes ?? 0).toBeGreaterThan(0);

	// p 组件覆盖只该影响图片分组，不能碰坏其它块级元素（标题/表格/列表/代码块）
	await expect(timeline.getByRole("heading", { level: 2, name: "标题" })).toBeVisible();
	await expect(timeline.locator("table")).toContainText("单元格");
	await expect(timeline.locator("li", { hasText: "列表项" })).toBeVisible();
	await expect(timeline.locator("pre code")).toContainText("const marker = 1;");

	// 白名单外 / 不存在的本地图：降级成「失败文案 · alt」+ 重试按钮，不出现破图也不崩
	const failed = timeline.getByText(/图片加载失败 · 外部/);
	await expect(failed).toBeVisible();
	await expect(timeline.locator('img[alt="外部"]')).toHaveCount(0);
	await failed.getByRole("button").click();
	await expect(failed).toBeVisible();

	// 点击瓷砖 → 全屏预览；Esc 关闭（焦点管理见 modalKeyboardAccess 契约测试）
	await images.nth(0).click();
	const dialog = window.getByRole("dialog");
	await expect(dialog).toBeVisible({ timeout: 5_000 });
	// 预览工具条：复制 / 保存（改造前 streamdown 自带 hover 下载，换成自研组件时丢了，现已补回）
	await expect(dialog.getByTestId("markdown-image-copy")).toBeVisible();
	await expect(dialog.getByTestId("markdown-image-save")).toBeVisible();

	// 缩放（2026-11）：药丸显示百分比，点 + 升一档 25%，图的 transform 跟着放大
	const level = dialog.getByTestId("image-zoom-level");
	const zoomIn = dialog.getByRole("button", { name: "放大" });
	const previewImage = dialog.locator("img");
	const readPercent = async () => Number.parseInt((await level.innerText()).replace("%", ""), 10);
	await expect(level).toHaveText("100%");
	const fitBox = await previewImage.boundingBox();
	await zoomIn.click();
	await expect(level).toHaveText("125%");
	const zoomedBox = await previewImage.boundingBox();
	expect((zoomedBox?.width ?? 0) / (fitBox?.width ?? 1)).toBeCloseTo(1.25, 1);

	// 滚轴直接控缩放：向上滚放大，连滚向下回到适配档就停住，不会缩成黑边小图
	// （光标锚定的几何正确性在 tests/imageZoom.test.mjs 里断言，这里只验证接线与比例变化）
	const dialogBox = await dialog.boundingBox();
	const centerX = (dialogBox?.x ?? 0) + (dialogBox?.width ?? 0) / 2;
	const centerY = (dialogBox?.y ?? 0) + (dialogBox?.height ?? 0) / 2;
	await window.mouse.move(centerX, centerY);
	await window.mouse.wheel(0, -240);
	await expect.poll(readPercent).toBeGreaterThan(125);
	for (let i = 0; i < 10; i += 1) await window.mouse.wheel(0, 400);
	await expect(level).toHaveText("100%");

	// 200%：拖拽必须 1:1 跟手（translate 在 scale 之后）；写成 scale(...) translate3d(...) 会变成 2× 位移
	for (let i = 0; i < 4; i += 1) await zoomIn.click();
	await expect(level).toHaveText("200%");
	const beforeDrag = await previewImage.boundingBox();
	await window.mouse.move(centerX, centerY);
	await window.mouse.down();
	await window.mouse.move(centerX, centerY - 60);
	await window.mouse.up();
	await expect
		.poll(async () => {
			const box = await previewImage.boundingBox();
			return (box?.y ?? 0) - (beforeDrag?.y ?? 0);
		})
		.toBeCloseTo(-60, -1);

	// 键盘也能平移：放大后被裁掉的部分不能只有鼠标能找回（WCAG 2.1.1）
	const beforeKey = await previewImage.boundingBox();
	await window.keyboard.press("ArrowUp");
	await expect.poll(async () => (await previewImage.boundingBox())?.y ?? 0).toBeLessThan(beforeKey?.y ?? 0);

	// 过拖不甩飞：连拖三次 -300px，夹取后图片中心必须仍在浮层内（夹取被删掉就会飞到窗口外）
	for (let i = 0; i < 3; i += 1) {
		await window.mouse.move(centerX, centerY);
		await window.mouse.down();
		await window.mouse.move(centerX, centerY - 300);
		await window.mouse.up();
	}
	const clampedBox = await previewImage.boundingBox();
	const clampedCenterY = (clampedBox?.y ?? 0) + (clampedBox?.height ?? 0) / 2;
	expect(clampedCenterY).toBeGreaterThan(dialogBox?.y ?? 0);
	expect(clampedCenterY).toBeLessThan((dialogBox?.y ?? 0) + (dialogBox?.height ?? 0));

	// 点百分比回适配档
	await level.click();
	await expect(level).toHaveText("100%");
	await expect(dialog).toBeVisible();
	await window.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0, { timeout: 5_000 });
});
