import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { IMAGE_ZOOM_FIT, IMAGE_ZOOM_MAX, IMAGE_ZOOM_MIN, clampImagePan, clampImageZoom, imageZoomFromWheelDelta, normalizeImageWheelDelta, stepImageZoom, zoomPanAroundCursor } = loadTsCommonJs("src/renderer/src/components/session/imageZoom.ts");

/**
 * 图片预览缩放几何契约（2026-11「点开图片能缩放」）。
 *
 * 口径：`zoom` 是相对**适配窗口**的百分比（100 = 整图装进 92vw×88vh），不是 1:1 像素比；
 * `pan` 与光标坐标都相对画面中心。四条规则必须成立，缺一条用户就会看到漂移/甩飞：
 * 1) 缩放下限 = 适配窗口（再小只有黑边），上限 800%；
 * 2) 按钮档位落在 25% 整数倍上（滚轮停在 137% 时点 + 应到 150%，不是 162%）；
 * 3) 滚轮缩放锚定光标：缩放前后光标下的像素不许动；
 * 4) 平移夹取到「画面不留空白」：图比视口小的方向锁中心，大了才允许拖到边缘。
 */

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} ≠ ${expected}`);

/** vm 里加载的模块返回的普通对象与本 realm 的原型不同，比较前先摊平成字面量。 */
const plain = (value) => ({ x: value.x, y: value.y });

test("缩放下限是适配窗口，上限 800%，非法输入回落到适配档", () => {
	assert.equal(IMAGE_ZOOM_MIN, 100);
	assert.equal(IMAGE_ZOOM_MAX, 800);
	assert.equal(IMAGE_ZOOM_FIT, 100);
	assert.equal(clampImageZoom(50), 100);
	assert.equal(clampImageZoom(1200), 800);
	assert.equal(clampImageZoom(Number.NaN), 100);
	assert.equal(clampImageZoom(Number.POSITIVE_INFINITY), 100);
	assert.equal(clampImageZoom(200.04), 200);
});

test("按钮步进对齐 25% 整数倍，到达两端后不再变化", () => {
	assert.equal(stepImageZoom(100, 1), 125);
	assert.equal(stepImageZoom(137, 1), 150);
	assert.equal(stepImageZoom(137, -1), 125);
	assert.equal(stepImageZoom(125, 1), 150);
	assert.equal(stepImageZoom(125, -1), 100);
	assert.equal(stepImageZoom(800, 1), 800);
	assert.equal(stepImageZoom(100, -1), 100);
});

test("滚轮增量归一化：行模式 16px/行、页模式 800px/页", () => {
	assert.equal(normalizeImageWheelDelta(3, 0), 3);
	assert.equal(normalizeImageWheelDelta(2, 1), 32);
	assert.equal(normalizeImageWheelDelta(1, 2), 800);
	assert.equal(normalizeImageWheelDelta(-100), -100, "缺省 deltaMode 按像素模式");
});

test("向上滚放大、向下滚缩小，适配窗口处缩不小，单次事件不会一步跳到上限", () => {
	// 断言区间而非精确值：灵敏度（指数系数）是调参项，锁死常数会让「行为仍正确」的调整也红灯
	const up = imageZoomFromWheelDelta(100, -100);
	assert.ok(up > 110 && up < 120, `一格滚轮应约 +15%，实际 ${up}`);
	assert.equal(imageZoomFromWheelDelta(100, 100), 100, "适配窗口再向下滚不动");
	const down = imageZoomFromWheelDelta(200, 100);
	assert.ok(down > 165 && down < 185, `一格滚轮应约 -15%，实际 ${down}`);
	assert.ok(up > 100 && down < 200, "方向不能反");
	// 一次超大滚动（夹在 ±240 delta 内）最多约 +40%，避免一甩就从 100% 冲到 800%
	const burst = imageZoomFromWheelDelta(100, -100000);
	assert.ok(burst > 130 && burst < 145, `单次事件上限应在 140% 附近，实际 ${burst}`);
	assert.ok(imageZoomFromWheelDelta(200, -50) > 200, "小幅向上滚也要放大");
	assert.ok(imageZoomFromWheelDelta(200, 50) < 200, "小幅向下滚也要缩小");
	assert.equal(imageZoomFromWheelDelta(800, -100), 800, "到顶后不再变化");
});

test("平移夹取：图比视口小的方向锁中心，大了才允许拖到边缘", () => {
	const image = { width: 200, height: 100 };
	const viewport = { width: 400, height: 300 };
	assert.deepEqual(plain(clampImagePan({ x: 120, y: -80 }, 100, image, viewport)), { x: 0, y: 0 }, "适配档没有可平移余量");
	// 400% 时画面 800×400：横向余量 (800-400)/2=200，纵向 (400-300)/2=50
	assert.deepEqual(plain(clampImagePan({ x: 500, y: -500 }, 400, image, viewport)), { x: 200, y: -50 });
	assert.deepEqual(plain(clampImagePan({ x: -40, y: 20 }, 400, image, viewport)), { x: -40, y: 20 }, "区间内原样保留");
});

test("滚轮缩放锚定光标：缩放前后光标下的像素保持不动", () => {
	const fromZoom = 200;
	const toZoom = 300;
	const pan = { x: 40, y: -30 };
	const cursor = { x: 150, y: 80 };
	const scaleBefore = fromZoom / 100;
	// 光标当前指着的图像点（未缩放坐标系）
	const point = { x: (cursor.x - pan.x) / scaleBefore, y: (cursor.y - pan.y) / scaleBefore };
	const next = zoomPanAroundCursor(pan, fromZoom, toZoom, cursor);
	const scaleAfter = toZoom / 100;
	close(next.x + scaleAfter * point.x, cursor.x, "横向不漂移");
	close(next.y + scaleAfter * point.y, cursor.y, "纵向不漂移");
});

test("缩放比例未变时光标锚定是恒等变换（到顶/到底继续滚不抖动）", () => {
	const pan = { x: 12, y: -7 };
	assert.deepEqual(plain(zoomPanAroundCursor(pan, 800, 800, { x: 300, y: 120 })), plain(pan));
	assert.deepEqual(plain(zoomPanAroundCursor(pan, 100, 100, { x: -300, y: 120 })), plain(pan));
});
