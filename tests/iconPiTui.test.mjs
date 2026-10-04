import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const { PI_TUI_COLORS, PI_TUI_LOGO_CELLS } = loadTsCommonJs("src/renderer/src/components/app/piTuiLogoData.ts");

/**
 * 应用图标 pi-tui 风格资源契约：
 * 1) build/icon-pi-tui.svg 与 renderer 的 piTuiLogoData 位图逐格一致（三色像素标），
 *    且容器规格与 classic build/icon.svg 同款（rx 228 深色渐变底 + shine），中心高 520 等高；
 * 2) scripts/make-icon.js 产出的 build/icon-pi-tui.png 是 256×256 透明留白 PNG（运行时 setIcon 用）。
 */

test("icon-pi-tui.svg contains the same 10-cell bitmap as renderer piTuiLogoData", () => {
	const svg = fs.readFileSync(path.join(root, "build", "icon-pi-tui.svg"), "utf8");

	const rects = [...svg.matchAll(/<rect x="(\d)" y="(\d)" width="1" height="1" fill="(#(?:[0-9A-Fa-f]{6}))"\/>/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]), fill: m[3].toUpperCase() }));
	assert.equal(rects.length, 10, "must be exactly 10 bitmap cells");

	// piTuiLogoData 的单元格键是 "y:x"、值是颜色名；svg 是 x/y 属性 + hex，两套坐标对齐比较。
	const expectedByCell = new Map(Object.entries(PI_TUI_LOGO_CELLS).map(([key, colorName]) => [key, PI_TUI_COLORS[colorName].toUpperCase()]));
	for (const [key, expectedFill] of expectedByCell) {
		const [y, x] = key.split(":").map(Number);
		const rect = rects.find((r) => r.x === x && r.y === y);
		assert.ok(rect, `svg must contain cell ${key}`);
		assert.equal(rect.fill, expectedFill, `cell ${key} color must match piTuiLogoData`);
	}
	// 颜色只允许品牌三色（coral/blue/yellow）
	for (const rect of rects) {
		assert.ok(["#E48A7A", "#4F8EB3", "#EAB65D"].includes(rect.fill), `unexpected fill color ${rect.fill}`);
	}
});

test("icon-pi-tui.svg keeps the classic container spec and stays vector-only", () => {
	const svg = fs.readFileSync(path.join(root, "build", "icon-pi-tui.svg"), "utf8");
	assert.match(svg, /rx="228"/, "container corner radius must match classic icon.svg");
	assert.match(svg, /viewBox="0 0 4 4"/, "bitmap viewport must be 4x4");
	assert.match(svg, /width="693" height="520"/, "bitmap height 520 matches classic wordmark; width is 4:3");
	assert.match(svg, /translate\(166, 170\)/, "bitmap centered horizontally, baseline aligned with classic wordmark");
	assert.ok(!svg.includes("data:image/png"), "must not embed raster data");
});

test("make-icon.js emitted build/icon-pi-tui.png as a 256x256 transparent PNG", async () => {
	const pngPath = path.join(root, "build", "icon-pi-tui.png");
	assert.ok(fs.existsSync(pngPath), "icon-pi-tui.png must be generated (npm run make-icon)");
	const meta = await sharp(pngPath).metadata();
	assert.equal(meta.width, 256);
	assert.equal(meta.height, 256);
	assert.equal(meta.channels, 4, "must keep alpha channel for icon padding");
});
