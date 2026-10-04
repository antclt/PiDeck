import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PI_TUI_COLORS, PI_TUI_LOGO_CELLS, PI_TUI_PIECES, resolveLogoStyle, LOGO_STYLE_STORAGE_KEY } = loadTsCommonJs("src/renderer/src/components/app/piTuiLogoData.ts");

test("official pi TUI logo bitmap matches pi source colors and cell layout", () => {
	// pi 源码 pi-logo.ts：coral #E48A7A / blue #4F8EB3 / yellow #EAB65D（品牌色固定）。
	// 沙箱加载的模块对象来自另一 realm，deepEqual 会因原型链不同误报，一律用标量断言。
	assert.equal(PI_TUI_COLORS.coral, "#E48A7A");
	assert.equal(PI_TUI_COLORS.blue, "#4F8EB3");
	assert.equal(PI_TUI_COLORS.yellow, "#EAB65D");
	// 4×4 位图 10 个有色格（y:x 锚定官方渲染行列）
	assert.deepEqual(Object.keys(PI_TUI_LOGO_CELLS).sort(), ["0:0", "0:1", "0:2", "1:0", "1:2", "2:0", "2:1", "2:3", "3:0", "3:3"]);
	assert.equal(PI_TUI_LOGO_CELLS["0:0"], "coral");
	assert.equal(PI_TUI_LOGO_CELLS["1:2"], "coral");
	assert.equal(PI_TUI_LOGO_CELLS["1:0"], "blue");
	assert.equal(PI_TUI_LOGO_CELLS["2:1"], "blue");
	assert.equal(PI_TUI_LOGO_CELLS["2:3"], "yellow");
	assert.equal(PI_TUI_LOGO_CELLS["3:3"], "yellow");
});

test("three animation pieces reassemble the settled bitmap exactly", () => {
	const reassembled = {};
	for (const piece of PI_TUI_PIECES) {
		assert.ok(piece.targetY >= 0, "piece target must land inside the 4x4 grid");
		assert.ok(piece.startY < piece.targetY, "piece must enter from above");
		for (const [dy, dx] of piece.cells) {
			reassembled[`${piece.targetY + dy}:${dx}`] = piece.color;
		}
	}
	// 逐格标量断言（跨 realm 对象不用 deepEqual）：三块落位后必须逐格还原定格位图
	assert.deepEqual(Object.keys(reassembled).sort(), Object.keys(PI_TUI_LOGO_CELLS).sort());
	for (const key of Object.keys(PI_TUI_LOGO_CELLS)) {
		assert.equal(reassembled[key], PI_TUI_LOGO_CELLS[key], `piece ${key} 颜色与定格位图不一致`);
	}
});

test("resolveLogoStyle treats classic as explicit opt-in, everything else falls back to pi-tui", () => {
	assert.equal(resolveLogoStyle("pi-tui"), "pi-tui");
	assert.equal(resolveLogoStyle("classic"), "classic");
	assert.equal(resolveLogoStyle(null), "pi-tui");
	assert.equal(resolveLogoStyle(undefined), "pi-tui");
	assert.equal(resolveLogoStyle("Pi-TUI"), "pi-tui");
	assert.equal(resolveLogoStyle("garbage"), "pi-tui");
});

test("boot splash reads the same localStorage key and embeds the same pi-tui bitmap", () => {
	const repoRoot = fileURLToPath(new URL("..", import.meta.url));
	const html = readFileSync(`${repoRoot}src/renderer/index.html`, "utf8");
	// 启动画面内联脚本（无法 import 共享常量）必须与 LOGO_STYLE_STORAGE_KEY 同步；空白容忍防格式化断言
	assert.match(html, new RegExp(`localStorage\\.getItem\\(\\s*["']${LOGO_STYLE_STORAGE_KEY.replace(":", "\\:")}["']\\s*\\)`), "boot splash must read LOGO_STYLE_STORAGE_KEY");
	// 新默认 pi-tui：仅显式选 classic 才不挂 class（与 shared/settings 默认同源）
	assert.match(html, new RegExp(`localStorage\\.getItem\\(\\s*["']${LOGO_STYLE_STORAGE_KEY.replace(":", "\\:")}["']\\s*\\)\\s*!==\\s*["']classic["']`), "boot splash 默认 pi-tui（非 classic 即挂 class）");
	// 开屏 pi-tui SVG 与数据模块逐格一致（颜色 + 位置抽样锚定）
	assert.match(html, /class="boot-logo-pi-tui"[\s\S]*?fill="#E48A7A"[\s\S]*?fill="#4F8EB3"[\s\S]*?fill="#EAB65D"/);
	assert.match(html, /<rect x="3" y="3" width="1" height="1" fill="#EAB65D"\/>/);
	// classic / pi-tui 显隐互斥（html.logo-pi-tui class 切换）
	assert.match(html, /html\.logo-pi-tui \.boot-logo \.boot-logo-classic\s*\{\s*display:\s*none/);
	// 官方位图为 1:1 正方形（半块字符每格上下两个正方形像素），不得再按 4:3 压成 48×36
	const bootRule = html.match(/\.boot-logo \.boot-logo-pi-tui\s*\{[^}]*\}/u);
	assert.ok(bootRule, "boot splash 应有 pi-tui logo 尺寸规则");
	assert.match(bootRule[0], /height:\s*48px/, "开屏 pi-tui 高度须与宽度一致（48px，1:1）");
});

test("PiTuiLogo component renders the 4x4 bitmap as a square (SVG and Canvas)", () => {
	const repoRoot = fileURLToPath(new URL("..", import.meta.url));
	const source = readFileSync(`${repoRoot}src/renderer/src/components/app/PiTuiLogo.tsx`, "utf8");
	// 官方 TUI 半块字符：每字符格上下叠两个正方形像素 → 4×4 位图整体 1:1。
	// 2026-12 曾误按「2 行字符」把高度算成 3/4：SVG 被挤出侧向留白、canvas 方形缓冲被 CSS 纵向压扁，
	// 品牌区 logo 明显偏扁——本测试锁住「正方形」契约（空白容忍，AGENTS.md 格式化要求）。
	assert.match(source, /width=\{size\}\s*height=\{size\}/, "svg 宽高必须相等（位图 1:1）");
	assert.doesNotMatch(source, /\(size \* 3\) \/ 4|\(cssSize \* 3\) \/ 4/, "不得再按 4:3 计算高度");
	const paintSection = source.slice(source.indexOf("function paintCells"));
	assert.match(paintSection, /const cssW = cssSize;\s*const cssH = cssSize;/, "canvas CSS 尺寸必须为 1:1");
});

test("LogoMark sidebar and about logo branch on logoStyle (source scan, whitespace tolerant)", () => {
	const repoRoot = fileURLToPath(new URL("..", import.meta.url));
	const appParts = readFileSync(`${repoRoot}src/renderer/src/components/app/AppParts.tsx`, "utf8");
	const about = readFileSync(`${repoRoot}src/renderer/src/components/app/AboutPopover.tsx`, "utf8");
	const logoMark = readFileSync(`${repoRoot}src/renderer/src/components/app/LogoMark.tsx`, "utf8");
	// 空白容忍（AGENTS.md 格式化契约）：定位代码块用 \s* 而非字面空白
	assert.match(appParts, /logoStyle === "pi-tui"\s*\?\s*<PiTuiLogoCanvas size=\{18\} playOnClick \/>\s*:\s*<PiLogoCanvas size=\{18\} playOnClick \/>/);
	assert.match(about, /logoStyle === "pi-tui"\s*\?\s*<PiTuiLogoCanvas size=\{40\} playOnClick \/>\s*:\s*<PiLogoCanvas size=\{40\} playOnClick \/>/);
	assert.match(logoMark, /logoStyle === "pi-tui"\s*\?\s*\(\s*\/\*[\s\S]*?PiTuiLogoMark size=\{glyph\} \/>/);
});

// SettingsStore 依赖 electron / 日志 / git 路径解析器，stub 顶掉（与 settingsStoreHiddenModules.test.mjs 同款）
function makeSettingsStore() {
	const userData = mkdtempSync(join(tmpdir(), "pideck-logo-style-user-"));
	const home = mkdtempSync(join(tmpdir(), "pideck-logo-style-home-"));
	const { SettingsStore } = loadTsCommonJs("src/main/settings/SettingsStore.ts", {
		stubs: {
			electron: {
				app: {
					getPath: (key) => (key === "userData" ? userData : key === "home" ? home : tmpdir()),
				},
				BrowserWindow: class {},
				Menu: { setApplicationMenu: () => undefined },
			},
			"../logging/sharedLogger": { getAppLogger: () => undefined },
			"../git/gitExecutable": { setConfiguredGitPath: () => undefined },
		},
	});
	return { SettingsStore, userData };
}

const seedSettings = (userData, extra) => {
	writeFileSync(join(userData, "settings.json"), JSON.stringify({ installationType: "installed", chatContentWidthPct: 80, ...extra }));
};

test("SettingsStore: logoStyle 默认 pi-tui、旧配置缺字段回落新默认、非法值被清洗", async () => {
	const { SettingsStore, userData } = makeSettingsStore();
	seedSettings(userData, {});
	const store = new SettingsStore();
	await store.load();
	assert.equal(store.get().logoStyle, "pi-tui", "旧 settings.json 缺 logoStyle 时回落新默认 pi-tui");

	await store.update({ logoStyle: "classic" });
	assert.equal(store.get().logoStyle, "classic", "显式选 classic 生效");

	await store.update({ logoStyle: "neon" });
	assert.equal(store.get().logoStyle, "classic", "非法枚举被丢弃，保持原设置");
});

test("logoStyle 默认值三处同源（shared 默认 / SettingsStore 默认 / atom 初值）", () => {
	const repoRoot = fileURLToPath(new URL("..", import.meta.url));
	const sharedDefaults = readFileSync(`${repoRoot}src/shared/types/settings.ts`, "utf8");
	const storeDefaults = readFileSync(`${repoRoot}src/main/settings/SettingsStore.ts`, "utf8");
	const atoms = readFileSync(`${repoRoot}src/renderer/src/atoms/app-ui-atoms.ts`, "utf8");
	for (const [path, source] of [
		["src/shared/types/settings.ts", sharedDefaults],
		["src/main/settings/SettingsStore.ts", storeDefaults],
	]) {
		assert.match(source, /logoStyle\s*:\s*"pi-tui"/, `${path} 默认 pi-tui`);
	}
	assert.match(atoms, /logoStyleAtom\s*=\s*atom<"classic"\s*\|\s*"pi-tui">\("pi-tui"\)/, "atom 初值 pi-tui");
});
