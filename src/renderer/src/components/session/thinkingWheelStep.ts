export const THINKING_WHEEL_STEP_THRESHOLD = 50;

export const THINKING_WHEEL_IDLE_RESET_MS = 150;

/**
 * 行模式（deltaMode=1，Firefox/Linux 的鼠标滚轮是这种）的每行折算像素。
 * 不能用 CSS 的 16px 行高：后面要跟 THINKING_WHEEL_STEP_THRESHOLD(50) 比较，
 * 16px/行 时「鼠标一格 = 3 行」只有 48px，永远够不到阈值 —— 一格乃至连续多格都不跳档，
 * 整个变成「死的」。取 40px/行（浏览器/社区通用口径）才能让两种 deltaMode 下都是「一格一档」。
 */
export const THINKING_WHEEL_LINE_HEIGHT = 40;

export const THINKING_WHEEL_PAGE_HEIGHT = 800;

export function normalizeWheelDelta(delta: number, deltaMode = 0): number {
	if (deltaMode === 1) return delta * THINKING_WHEEL_LINE_HEIGHT;
	if (deltaMode === 2) return delta * THINKING_WHEEL_PAGE_HEIGHT;
	return delta;
}

export type WheelStepState = { accumulated: number; at: number };

export function accumulateWheelStep(state: WheelStepState, rawDelta: number, now: number, deltaMode = 0): { step: -1 | 0 | 1; next: WheelStepState } {
	const delta = normalizeWheelDelta(rawDelta, deltaMode);
	const fresh = now - state.at > THINKING_WHEEL_IDLE_RESET_MS;
	if (!Number.isFinite(delta) || delta === 0) return { step: 0, next: state };
	const sameDirection = !fresh && Math.sign(delta) === Math.sign(state.accumulated);
	const base = fresh || !sameDirection ? 0 : state.accumulated;
	const accumulated = base + delta;
	if (Math.abs(accumulated) < THINKING_WHEEL_STEP_THRESHOLD) return { step: 0, next: { accumulated, at: now } };
	return { step: accumulated < 0 ? 1 : -1, next: { accumulated: 0, at: now } };
}
