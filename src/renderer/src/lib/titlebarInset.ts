/**
 * 自定义标题栏的顶部拖拽热区让位。
 *
 * 为什么需要：`.window-drag-layer` 是一条 fixed 的透明矩形（高度 `--window-drag-height`，
 * frameless 下 40px），带 `-webkit-app-region: drag`。Electron 把页面报上来的 app-region
 * 矩形按顺序合成一张 SkRegion（drag 并集、no-drag 差集，`ui/gfx/draggable_region.h`），
 * 矩形集合来自 Blink 按布局树（DOM 顺序）遍历，**与 z-index 无关**：浮层（菜单/下拉/弹出框）
 * portal 到 body 后有 `--z-popover`(960) 高于热区的 900，画得上去却点不动——点击被当成拖窗口。
 *
 * Radix 的碰撞检测默认边界是整个视口，长菜单在下方空间不足时会 flip 到上方再被 shift/size
 * clamp 到视口上沿（top ≈ 热区内），首项正好落进热区 → 「只有第一项点不动」。
 * 把热区高度作为碰撞边界的顶部 padding，浮层就根本不会被排进热区
 * （实测：热区 40px 时首项从 19px 抬到 44px）。
 *
 * 取值就是热区高度，**不额外加呼吸间距**：标题栏里按钮的下拉菜单自然顶边 ≈ 触发器底边 + 4
 * ≈ 36–40，多留 8px 会把菜单推离触发器；热区本身是透明的，贴住它的下沿没有视觉代价。
 *
 * 兜底：即使排布仍然重叠（子菜单 SubContent 不走 portal、也不经过本函数），
 * `foundation.css` 里的 `[data-radix-popper-content-wrapper] *` no-drag 规则保证点击不被吞。
 *
 * 原生标题栏下 `--window-drag-height` 为 0px：返回 undefined，调用方行为与未接入时完全一致。
 */
export function titlebarCollisionPadding(): { top: number } | undefined {
	if (typeof window === "undefined") return undefined;
	const dragHeight = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--window-drag-height"));
	if (!Number.isFinite(dragHeight) || dragHeight <= 0) return undefined;
	return { top: dragHeight };
}
