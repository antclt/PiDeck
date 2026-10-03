/**
 * 自定义主题包（Phase 1 主题开放）单测：
 * - parseCustomThemePackage：合法包（含内置 demo/模板）解析归一化；非法 id/未知 token/危险颜色值/
 *   双档全空/非 JSON 逐一拒绝，错误信息面向用户可直接展示；
 * - sanitizeCustomThemeSnapshot：设置快照逐键过滤，id/name 非法或双档全空返回 undefined；
 * - buildCustomThemeGuideMarkdown：指南含白名单 token、示例主题 id 与目录路径（双语文案）；
 * - CustomThemeStore：真实 tmp 目录上 list/read/save/delete 行为（内置示例上架、坏文件降级
 *   parseError、删除走回收站桩、内置示例不可删）。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const loadPure = createTsSandbox();
const { parseCustomThemePackage, serializeCustomThemePackage, sanitizeCustomThemeSnapshot, buildCustomThemeGuideMarkdown, DEMO_CUSTOM_THEME, CUSTOM_THEME_TEMPLATE, CUSTOM_THEME_TOKEN_WHITELIST } = loadPure("src/shared/customThemes.ts");
// 指南模块与主题契约同目录，单独加载避免一次绑死两个模块
const { buildCustomThemeGuideMarkdown: buildGuide } = loadPure("src/shared/customThemeGuide.ts");

/** 合法最小主题包 JSON（外部完整键形态） */
function minimalPackageJson(overrides = {}) {
	return JSON.stringify({ schemaVersion: 1, id: "test-theme", name: "测试主题", appearance: { light: { "--color-bg-app": "#fafafa", "--color-accent": "#4a7854" } }, ...overrides });
}

test("内置示例与空白模板都能通过自身校验（常量与校验器不漂移）", () => {
	const demo = parseCustomThemePackage(serializeCustomThemePackage(DEMO_CUSTOM_THEME));
	assert.equal(demo.ok, true);
	assert.equal(demo.theme.id, "berry-night-demo");
	assert.ok(demo.tokens.light["bg-app"]);

	const template = parseCustomThemePackage(serializeCustomThemePackage(CUSTOM_THEME_TEMPLATE));
	assert.equal(template.ok, true);
});

test("合法包解析：外部 --color-* 键归一化为无前缀快照键", () => {
	const parsed = parseCustomThemePackage(minimalPackageJson());
	assert.equal(parsed.ok, true);
	assert.deepEqual(Object.keys(parsed.tokens.light).sort(), ["accent", "bg-app"]);
	// theme 字段保留外部完整键形态（供序列化落盘）
	assert.equal(parsed.theme.appearance.light["--color-bg-app"], "#fafafa");
});

test("非法 id / 未知 token / 危险颜色值逐项拒绝", () => {
	const badId = parseCustomThemePackage(minimalPackageJson({ id: "My Theme!" }));
	assert.equal(badId.ok, false);
	assert.ok(badId.errors.some((e) => e.includes("id")));

	const unknownToken = parseCustomThemePackage(JSON.stringify({ schemaVersion: 1, id: "a-b", name: "x", appearance: { light: { "--color-hax": "#fff" } } }));
	assert.equal(unknownToken.ok, false);
	assert.ok(unknownToken.errors.some((e) => e.includes("--color-hax")));

	// 引用与注入面必须被颜色值白名单挡住（值只进 inline style 的双保险）
	for (const evil of ["var(--x)", "url(javascript:alert(1))", "red blue", '#ff")); background:url(x)', "#ggggzz"]) {
		const result = parseCustomThemePackage(JSON.stringify({ schemaVersion: 1, id: "a-b", name: "x", appearance: { light: { "--color-accent": evil } } }));
		assert.equal(result.ok, false, `值 ${evil} 不应通过校验`);
	}
});

test("双档全空 / 非 JSON / appearance 缺失拒绝", () => {
	assert.equal(parseCustomThemePackage(JSON.stringify({ schemaVersion: 1, id: "a-b", name: "x", appearance: { light: {}, dark: {} } })).ok, false);
	assert.equal(parseCustomThemePackage("not json").ok, false);
	assert.equal(parseCustomThemePackage(JSON.stringify({ schemaVersion: 1, id: "a-b", name: "x" })).ok, false);
});

test("sanitizeCustomThemeSnapshot：逐键过滤 + 整体非法丢弃", () => {
	const valid = { id: "test-theme", name: "测试", light: { "bg-app": "#fff", hax: "#000", accent: "var(--x)" }, dark: {} };
	const cleaned = sanitizeCustomThemeSnapshot(valid);
	// 沙箱跨 realm 对象不能用 deepEqual（原型不同）：按键逐个断言
	assert.equal(Object.keys(cleaned.light).length, 1);
	assert.equal(cleaned.light["bg-app"], "#fff"); // hax 不在白名单、var() 非法，均被滤掉
	assert.equal(sanitizeCustomThemeSnapshot({ id: "Bad Id", name: "x", light: { "bg-app": "#fff" } }), undefined);
	assert.equal(sanitizeCustomThemeSnapshot({ id: "a-b", name: "x", light: {}, dark: {} }), undefined);
	assert.equal(sanitizeCustomThemeSnapshot("junk"), undefined);
});

test("AI 指南：含白名单 token、示例主题 id 与目录路径（双语）", () => {
	const zh = buildGuide("zh-CN", "C:\\userData\\custom-themes");
	assert.ok(zh.includes("--color-bg-app"));
	assert.ok(zh.includes("berry-night-demo"));
	assert.ok(zh.includes("C:\\userData\\custom-themes"));
	const en = buildGuide("en-US", "/tmp/dir");
	assert.ok(en.includes("--color-bg-app"));
	assert.ok(en.includes("berry-night-demo"));
	// 白名单全量 token 都应出现在指南里（AI 能看到全部可扩展点）
	for (const token of CUSTOM_THEME_TOKEN_WHITELIST) {
		assert.ok(zh.includes(`--color-${token}`), `指南缺少 token ${token}`);
	}
});

test("CustomThemeStore：目录扫描/保存/读取/删除（真实 tmp 目录 + 回收站桩）", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pideck-custom-themes-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const trashed = [];
	// store 在 userData/custom-themes/ 下工作（桩的 userData = dir）
	const themesRoot = join(dir, "custom-themes");

	const loadStore = createTsSandbox({
		stubs: {
			electron: { app: { getPath: () => dir } },
			// 回收站副作用打桩：记录路径并移除文件（模拟移入回收站），测试不碰真实回收站
			"../fs/trash": {
				trashPath: async (p) => {
					trashed.push(p);
					rmSync(p, { force: true });
				},
			},
			"../logging/sharedLogger": { getAppLogger: () => ({ info() {}, warn() {}, error() {} }) },
		},
	});
	const store = loadStore("src/main/themes/CustomThemeStore.ts");

	// 空目录：只有内置示例
	const empty = await store.listCustomThemes();
	assert.equal(empty.themes.length, 1);
	assert.equal(empty.themes[0].source, "builtin");
	assert.equal(empty.themes[0].id, "berry-night-demo");

	// 保存合法包 → 落盘 <id>.json；保存非法包 → 拒绝且不落盘
	const saved = await store.saveCustomTheme(minimalPackageJson());
	assert.equal(saved.ok, true);
	assert.equal(saved.id, "test-theme");
	assert.ok(existsSync(join(themesRoot, "test-theme.json")));
	const bad = await store.saveCustomTheme(minimalPackageJson({ id: "bad id!" }));
	assert.equal(bad.ok, false);
	assert.ok(!existsSync(join(themesRoot, "bad id!.json")));

	// 列表：内置 + 用户（按 id 找到）；读取原始 JSON 往返
	const listed = await store.listCustomThemes();
	const user = listed.themes.find((item) => item.id === "test-theme");
	assert.equal(user?.source, "user");
	assert.equal(user?.name, "测试主题");
	assert.ok((await store.readCustomTheme("test-theme")).includes("test-theme"));

	// 坏 JSON 文件：降级为 parseError 条目（不致命，可定位）
	writeFileSync(join(themesRoot, "broken.json"), "{not json", "utf8");
	const withBroken = await store.listCustomThemes();
	const broken = withBroken.themes.find((item) => item.id === "broken");
	assert.ok(broken?.parseError?.length);

	// 删除用户主题 → 走回收站（打桩记录路径），文件消失；内置示例删除为 no-op
	await store.deleteCustomTheme("test-theme");
	assert.equal(trashed.length, 1);
	assert.ok(trashed[0].endsWith("test-theme.json"));
	assert.ok(!existsSync(join(themesRoot, "test-theme.json")));
	await store.deleteCustomTheme("berry-night-demo");
	assert.equal(trashed.length, 1); // 未新增
	// 路径安全：非法 id 不触达文件系统
	await store.deleteCustomTheme("../evil");
	assert.equal(trashed.length, 1);
	assert.equal(await store.readCustomTheme("../evil"), null);
});
