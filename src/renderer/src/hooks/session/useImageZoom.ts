import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { clampImagePan, clampImageZoom, IMAGE_ZOOM_FIT, IMAGE_ZOOM_MAX, IMAGE_ZOOM_MIN, imageZoomFromWheelDelta, normalizeImageWheelDelta, stepImageZoom, zoomPanAroundCursor, type ImageZoomPan } from "../../components/session/imageZoom";

export interface ImageZoomHandlers {
	onPointerDown: (event: ReactPointerEvent<HTMLImageElement>) => void;
	onPointerMove: (event: ReactPointerEvent<HTMLImageElement>) => void;
	onPointerUp: (event: ReactPointerEvent<HTMLImageElement>) => void;
	onPointerCancel: (event: ReactPointerEvent<HTMLImageElement>) => void;
}

export interface ImageZoomController {
	/** 相对适配窗口的百分比（100 = 全图装进窗口）。 */
	zoom: number;
	dragging: boolean;
	canZoomIn: boolean;
	canZoomOut: boolean;
	imageRef: RefObject<HTMLImageElement | null>;
	imageStyle: { transform: string };
	handlers: ImageZoomHandlers;
	zoomIn: () => void;
	zoomOut: () => void;
	reset: () => void;
	/** 键盘平移：放大后被裁掉的部分不能只有鼠标能找回（WCAG 2.1.1）。 */
	panBy: (dx: number, dy: number) => void;
}

interface ImageZoomView {
	zoom: number;
	pan: ImageZoomPan;
}

interface DragState {
	pointerId: number;
	startX: number;
	startY: number;
	base: ImageZoomPan;
}

/**
 * 图片预览浮层的缩放/平移交互（滚轮缩放 + 拖拽平移 + 按钮档位）。
 *
 * 接收浮层容器（`.image-preview-modal`）的 ref，滚轮监听挂在**容器**上而不是图片上：
 * 指针停在背景或底部工具条上时也该能缩放，且 React 的 `onWheel` 是 passive 监听
 * （`preventDefault` 会被忽略并告警），必须自己注册 `{ passive: false }`。
 *
 * 图片尺寸取 `offsetWidth/offsetHeight`（布局尺寸，不受 transform 影响）= 适配窗口后的
 * 实际显示尺寸；视口尺寸取容器 `clientWidth/clientHeight`。两者都只在缩放/拖拽时读一次，
 * 不订阅 ResizeObserver——浮层是全屏模态，窗口尺寸变化时下一次交互重新读取即可。
 */
export function useImageZoom(viewportRef: RefObject<HTMLElement | null>): ImageZoomController {
	const imageRef = useRef<HTMLImageElement | null>(null);
	// 缩放与位移必须同帧提交：分成两个 state 会出现「先按旧位移缩放一帧」的抖动
	const [view, setView] = useState<ImageZoomView>({ zoom: IMAGE_ZOOM_FIT, pan: { x: 0, y: 0 } });
	const [dragging, setDragging] = useState(false);
	const viewRef = useRef<ImageZoomView>(view);
	const dragRef = useRef<DragState | null>(null);

	const commit = useCallback((next: ImageZoomView) => {
		viewRef.current = next;
		setView(next);
	}, []);

	/** 读一次当前几何（适配尺寸 + 视口尺寸）；图片还没布局出来时返回 null，调用方按无夹取处理。 */
	const measure = useCallback(() => {
		const image = imageRef.current;
		const viewport = viewportRef.current;
		if (!image || !viewport) return null;
		const width = image.offsetWidth;
		const height = image.offsetHeight;
		if (width <= 0 || height <= 0) return null;
		return {
			image: { width, height },
			viewport: { width: viewport.clientWidth, height: viewport.clientHeight },
		};
	}, [viewportRef]);

	const applyZoom = useCallback(
		(target: number, cursor?: ImageZoomPan) => {
			const current = viewRef.current;
			const zoom = clampImageZoom(target);
			const bounds = measure();
			const anchored = cursor ? zoomPanAroundCursor(current.pan, current.zoom, zoom, cursor) : current.pan;
			commit({ zoom, pan: bounds ? clampImagePan(anchored, zoom, bounds.image, bounds.viewport) : anchored });
		},
		[commit, measure],
	);

	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		const onWheel = (event: WheelEvent) => {
			// 拦掉默认滚动：否则时间线/编辑器在浮层下面跟着滚
			event.preventDefault();
			const rect = viewport.getBoundingClientRect();
			const cursor = { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
			applyZoom(imageZoomFromWheelDelta(viewRef.current.zoom, normalizeImageWheelDelta(event.deltaY, event.deltaMode)), cursor);
		};
		viewport.addEventListener("wheel", onWheel, { passive: false });
		return () => viewport.removeEventListener("wheel", onWheel);
	}, [applyZoom, viewportRef]);

	const onPointerDown = useCallback((event: ReactPointerEvent<HTMLImageElement>) => {
		// 只在放大后才拖：适配窗口时没有可平移的余量，按下拖动不该有任何位移
		if (event.button !== 0 || viewRef.current.zoom <= IMAGE_ZOOM_FIT) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, base: viewRef.current.pan };
		setDragging(true);
	}, []);

	const onPointerMove = useCallback(
		(event: ReactPointerEvent<HTMLImageElement>) => {
			const drag = dragRef.current;
			if (!drag || drag.pointerId !== event.pointerId) return;
			const bounds = measure();
			const next = { x: drag.base.x + (event.clientX - drag.startX), y: drag.base.y + (event.clientY - drag.startY) };
			const zoom = viewRef.current.zoom;
			commit({ zoom, pan: bounds ? clampImagePan(next, zoom, bounds.image, bounds.viewport) : next });
		},
		[commit, measure],
	);

	const endDrag = useCallback((event: ReactPointerEvent<HTMLImageElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		dragRef.current = null;
		setDragging(false);
		if (event.currentTarget.hasPointerCapture(drag.pointerId)) event.currentTarget.releasePointerCapture(drag.pointerId);
	}, []);

	const zoomIn = useCallback(() => applyZoom(stepImageZoom(viewRef.current.zoom, 1)), [applyZoom]);
	const zoomOut = useCallback(() => applyZoom(stepImageZoom(viewRef.current.zoom, -1)), [applyZoom]);
	const reset = useCallback(() => applyZoom(IMAGE_ZOOM_FIT), [applyZoom]);
	// 方向键平移与拖拽共用同一套夹取：两条入口各写一份边界判定，迟早会漂移
	const panBy = useCallback(
		(dx: number, dy: number) => {
			const current = viewRef.current;
			if (current.zoom <= IMAGE_ZOOM_FIT) return;
			const bounds = measure();
			const next = { x: current.pan.x + dx, y: current.pan.y + dy };
			commit({ zoom: current.zoom, pan: bounds ? clampImagePan(next, current.zoom, bounds.image, bounds.viewport) : next });
		},
		[commit, measure],
	);

	return {
		zoom: view.zoom,
		dragging,
		canZoomIn: view.zoom < IMAGE_ZOOM_MAX,
		canZoomOut: view.zoom > IMAGE_ZOOM_MIN,
		imageRef,
		// translate 在 scale 之后作用（transform 函数从右往左应用），位移单位就是屏幕像素
		imageStyle: { transform: `translate3d(${view.pan.x}px, ${view.pan.y}px, 0) scale(${view.zoom / IMAGE_ZOOM_FIT})` },
		handlers: { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag },
		zoomIn,
		zoomOut,
		reset,
		panBy,
	};
}
