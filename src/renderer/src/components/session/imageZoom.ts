/**
 * 图片预览浮层的缩放/平移几何（纯函数，可单测）。
 *
 * 坐标口径：
 * - `zoom` 是相对「适配窗口」的百分比：100 = 整图装进 `max-width:92vw / max-height:88vh`
 *   （与 `.image-preview-modal img` 的样式一致），**不是 1:1 像素比**。会话里的截图常远大于
 *   窗口，按 1:1 算「100%」会显示成局部放大，用户无从判断自己看的是全图还是细节。
 * - `pan` 是相对中心的位移（CSS px），与 `transform: translate(...) scale(...)` 的顺序对应：
 *   translate 作用在缩放后的画面上，所以位移直接按屏幕像素累加。
 * - 光标坐标同样相对画面中心，这样锚定公式与 pan 是同一个原点，不需要再减半宽高。
 */

/** 适配窗口（默认档）。 */
export const IMAGE_ZOOM_FIT = 100;
export const IMAGE_ZOOM_MIN = 100;
export const IMAGE_ZOOM_MAX = 800;
/** 按钮一次跳的档位；从滚轮的连续值（如 137%）出发时取「下一个 25% 整数倍」。 */
export const IMAGE_ZOOM_BUTTON_STEP = 25;

export interface ImageZoomPan {
	x: number;
	y: number;
}

export interface ImageZoomSize {
	width: number;
	height: number;
}

function clampNumber(value: number, min: number, max: number): number {
	const clamped = Math.min(max, Math.max(min, value));
	// 归一化 -0：夹到 0 时 Math.max(-0, x) 会留下 -0，会让调用方/测试多一层噪声（-0 !== 0）
	return clamped === 0 ? 0 : clamped;
}

/** 收敛到合法区间并保留一位小数（滚轮产生连续值，整数化会让小增量原地不动）。 */
export function clampImageZoom(value: number): number {
	if (!Number.isFinite(value)) return IMAGE_ZOOM_FIT;
	return clampNumber(Math.round(value * 10) / 10, IMAGE_ZOOM_MIN, IMAGE_ZOOM_MAX);
}

/**
 * 按钮步进：向上取到下一个 `step` 的整数倍、向下取上一个整数倍。
 * 不用「当前值 ± step」是因为滚轮停在 137% 时那会变成 162%/112%，档位越点越脏。
 * `1e-6` 抵消浮点误差，避免 125% 再点一次向下变成 75% 那一档。
 */
export function stepImageZoom(current: number, direction: 1 | -1, step = IMAGE_ZOOM_BUTTON_STEP): number {
	const from = clampImageZoom(current);
	if (direction > 0) return clampImageZoom((Math.floor(from / step + 1e-6) + 1) * step);
	return clampImageZoom((Math.ceil(from / step - 1e-6) - 1) * step);
}

/**
 * 滚轮增量归一化：行模式（`DOM_DELTA_LINE`）按 16px/行、页模式（`DOM_DELTA_PAGE`）按一页 ≈800px 折算。
 * Electron 里基本只会拿到像素模式，这两档是为触控板/无障碍设备的旧事件兜底。
 */
export function normalizeImageWheelDelta(deltaY: number, deltaMode = 0): number {
	if (deltaMode === 1) return deltaY * 16;
	if (deltaMode === 2) return deltaY * 800;
	return deltaY;
}

/**
 * 滚轮 → 缩放比例：指数映射，一格滚轮（±100）约 ±15%，触控板的小增量能连续跟随；
 * 单次事件最多约 ±40%（夹在 ±240 delta 内），防止一次大滚动直接把图甩到 800%。
 * 向下滚 = 缩小，与系统滚动方向一致；缩到适配窗口即停（再小只会得到一圈黑边）。
 */
export function imageZoomFromWheelDelta(current: number, deltaY: number): number {
	const bounded = clampNumber(deltaY, -240, 240);
	return clampImageZoom(current * Math.exp(-bounded * 0.0014));
}

/**
 * 把位移限制在「画面不留空白」的范围内：图片在某个方向上比视口小就锁在中心（0），
 * 比视口大才允许平移，且最多平移到图片边缘与视口边缘重合。
 * 不做这个夹取，用户甩两下就把图拖出屏幕，只能靠关闭重开找回。
 */
export function clampImagePan(pan: ImageZoomPan, zoom: number, image: ImageZoomSize, viewport: ImageZoomSize): ImageZoomPan {
	const scale = clampImageZoom(zoom) / IMAGE_ZOOM_FIT;
	const maxX = Math.max(0, (image.width * scale - viewport.width) / 2);
	const maxY = Math.max(0, (image.height * scale - viewport.height) / 2);
	return {
		x: clampNumber(pan.x, -maxX, maxX),
		y: clampNumber(pan.y, -maxY, maxY),
	};
}

/**
 * 光标锚定缩放：缩放前后，光标下的那个像素保持不动。
 *
 * 推导：设图上一点在未缩放坐标系里相对中心为 `p`，位移 `t`，缩放 `s`，则它出现在
 * 屏幕上的位置 `c = t + s·p`。要求 `c` 不变解出新位移 `t' = k·t + (1-k)·c`，其中 `k = s'/s`。
 */
export function zoomPanAroundCursor(pan: ImageZoomPan, fromZoom: number, toZoom: number, cursor: ImageZoomPan): ImageZoomPan {
	const k = clampImageZoom(toZoom) / clampImageZoom(fromZoom);
	if (!Number.isFinite(k) || k <= 0) return pan;
	return {
		x: cursor.x * (1 - k) + k * pan.x,
		y: cursor.y * (1 - k) + k * pan.y,
	};
}
