import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 图片预览缩放接线契约（2026-11：「点开会话里的图片能缩放，滚轴控制大小」）。
 *
 * 背景：`ImageLightbox` 之前只有关闭/动作条，看图只能看适配窗口那一档；大截图里的细节
 * 无法放大，用户只能另存到系统看图器里看。缩放能力落在三处，任何一处断开都等于功能失效，
 * 且都不容易在单测里跑出来（需要真实滚轮/指针事件），所以用源码锚点兜住：
 * 1) 纯几何在 `imageZoom.ts`（无 React 依赖，可被 node 直接加载）；
 * 2) 交互在 `useImageZoom`——滚轮必须**非 passive** 监听，否则 preventDefault 被忽略、
 *    浮层下的时间线跟着滚（React 的 onWheel 就是 passive，仓库里踩过多次）；
 * 3) 浮层必须裁切溢出（放大后的图不能画出窗口），并挂上 `− 200% +` 药丸与图片 transform。
 */

const read = (path) => readFileSync(path, "utf8");
const lightbox = read("src/renderer/src/components/session/ImageLightbox.tsx");
const hook = read("src/renderer/src/hooks/session/useImageZoom.ts");
const controls = read("src/renderer/src/components/session/ImageZoomControls.tsx");
const geometry = read("src/renderer/src/components/session/imageZoom.ts");
const zhCN = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const enUS = read("src/renderer/src/i18n/rendererCopy.en-US.ts");
const zhTW = read("src/renderer/src/i18n/rendererCopy.zh-TW.ts");

test("几何模块是与 React 无关的纯函数（node --test 可直接加载）", () => {
	assert.doesNotMatch(geometry, /from\s+"react"/);
	assert.doesNotMatch(geometry, /use(State|Ref|Effect|Callback|Memo)\(/);
});

test("浮层接上缩放控制器：图片拿 transform，底部控制簇挂上药丸", () => {
	assert.match(lightbox, /useImageZoom\s*\(\s*dialogRef\s*\)/);
	assert.match(lightbox, /ref=\{zoom\.imageRef\}/);
	assert.match(lightbox, /style=\{zoom\.imageStyle\}/);
	assert.match(lightbox, /\.\.\.zoom\.handlers/);
	assert.match(lightbox, /<ImageZoomControls[\s\S]{0,400}onZoomIn=\{zoom\.zoomIn\}/);
	assert.match(lightbox, /onZoomOut=\{zoom\.zoomOut\}/);
	assert.match(lightbox, /onReset=\{zoom\.reset\}/);
	// 放大后的图必须被浮层裁掉，否则会画出窗口（className 里还有别的 utility，不能假定它紧贴收尾）
	assert.match(lightbox, /className="image-preview-modal[^"]*\boverflow-hidden\b/);
	// 原生图片拖拽会盖掉指针平移；touch-none 让触屏/笔拖拽不被滚动手势接管
	assert.match(lightbox, /draggable=\{false\}/);
	assert.match(lightbox, /className=\{`touch-none/);
});

test("键盘也能平移：放大后方向键走 hook 的 panBy（与拖拽共用夹取）", () => {
	// 只加缩放不加键盘平移 = 放大后只能靠鼠标看到被裁掉的部分
	assert.match(lightbox, /const KEY_PAN[\s\S]{0,200}ArrowLeft/);
	assert.match(lightbox, /zoom\.panBy\(/);
	assert.match(lightbox, /zoom\.zoom\s*<=\s*IMAGE_ZOOM_FIT\)\s*return/, "适配档不吞方向键");
	assert.match(hook, /const panBy = useCallback/);
	assert.match(hook, /clampImagePan\(next, current\.zoom/, "键盘平移与拖拽共用夹取");
	// 点图片会把焦点丢回 body（图片不可聚焦）：对话框必须自己收回焦点，否则方向键根本到不了 onKeyDown
	assert.match(lightbox, /tabIndex=\{-1\}/);
	assert.match(lightbox, /onPointerDown=\{\(\)\s*=>\s*dialogRef\.current\?\.focus\(\)\}/, "点过图片后方向键仍可用");
});

test("滚轮缩放用非 passive 原生监听（React onWheel 是 passive，preventDefault 无效）", () => {
	assert.doesNotMatch(lightbox, /onWheel=/);
	assert.match(hook, /addEventListener\("wheel",\s*onWheel,\s*\{\s*passive:\s*false\s*\}\)/);
	assert.match(hook, /removeEventListener\("wheel",\s*onWheel\)/);
	assert.match(hook, /event\.preventDefault\(\)/, "拦掉默认滚动");
	// 光标锚定：以浮层中心为原点换算光标位置
	assert.match(hook, /clientX\s*-\s*rect\.left\s*-\s*rect\.width\s*\/\s*2/);
});

test("拖拽平移：仅在放大后启用，并用 pointer capture 保证拖出图片也不丢事件", () => {
	assert.match(hook, /zoom\s*<=\s*IMAGE_ZOOM_FIT\)\s*return/);
	assert.match(hook, /setPointerCapture\(/);
	assert.match(hook, /releasePointerCapture\(/);
	assert.match(hook, /onPointerCancel/);
});

test("药丸控件：加减禁用态 + 点百分比回到适配档", () => {
	assert.match(controls, /t\("app\.imageZoomIn"\)/);
	assert.match(controls, /t\("app\.imageZoomOut"\)/);
	assert.match(controls, /t\("app\.imageZoomReset",\s*\{\s*percent\s*\}\)/);
	// 重置必须真的接上 onClick（否则百分比只是个不响应的标签）
	assert.match(controls, /onClick=\{props\.onReset\}/);
	// 命中区得撑满药丸高度：裸 <button> + text-xs 只有 16px 高，上下各 6px 会点了没反应
	assert.match(controls, /className="[^"]*\bh-7\b[^"]*flex|className="flex h-7/);
	assert.match(controls, /disabled=\{!props\.canZoomOut\}/);
	assert.match(controls, /disabled=\{!props\.canZoomIn\}/);
	assert.match(controls, /\{percent\}%/, "显示当前百分比");
});

test("缩放文案三语言同步（zh-TW 是生成物，改完 zh-CN 必须重跑脚本）", () => {
	for (const [name, dictionary] of [
		["zh-CN", zhCN],
		["en-US", enUS],
		["zh-TW", zhTW],
	]) {
		for (const key of ["app.imageZoomIn", "app.imageZoomOut", "app.imageZoomReset"]) {
			assert.match(dictionary, new RegExp(`"${key}":\\s*"[^"]+"`), `${name} 缺 ${key}`);
		}
	}
});
