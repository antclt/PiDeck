import { Minus, Plus } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";

/**
 * 图片预览浮层的缩放药丸：`− 200% +`。
 *
 * 百分比相对「适配窗口」（见 `imageZoom.ts` 的口径说明），点击数字回 100%——比再放一个
 * 「重置」按钮更省空间，且数字本身就是当前状态，放在它上面符合直觉。
 * 形态刻意用胶囊，与旁边的复制/保存动作条（`rounded-md` 逐钮分段）区分「连续量」与「离散动作」；
 * 底色/边框/模糊与邻条同一套 token（半透明底 + backdrop-blur），两件并排不打架。
 */
export function ImageZoomControls(props: { zoom: number; canZoomIn: boolean; canZoomOut: boolean; onZoomIn: () => void; onZoomOut: () => void; onReset: () => void }) {
	const percent = Math.round(props.zoom);
	const resetLabel = t("app.imageZoomReset", { percent });
	return (
		<div className="flex items-center overflow-hidden rounded-full border border-border/70 bg-background/85 shadow-sm backdrop-blur-sm">
			<Button variant="ghost" size="icon-sm" className="rounded-none text-muted-foreground hover:bg-muted hover:text-foreground" type="button" disabled={!props.canZoomOut} onClick={props.onZoomOut} title={t("app.imageZoomOut")} aria-label={t("app.imageZoomOut")}>
				<Minus size={14} aria-hidden="true" />
			</Button>
			<button
				type="button"
				data-testid="image-zoom-level"
				onClick={props.onReset}
				title={resetLabel}
				aria-label={resetLabel}
				// h-7 + flex 居中：命中区必须撑满药丸高度（文本行只有 16px，父级 items-center 不拉伸，
				// 否则药丸上下各 6px 是点了没反应的死区）
				className="flex h-7 min-w-14 items-center justify-center rounded-none px-1 text-center text-xs font-medium text-foreground tabular-nums transition-colors duration-fast outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50"
			>
				{percent}%
			</button>
			<Button variant="ghost" size="icon-sm" className="rounded-none text-muted-foreground hover:bg-muted hover:text-foreground" type="button" disabled={!props.canZoomIn} onClick={props.onZoomIn} title={t("app.imageZoomIn")} aria-label={t("app.imageZoomIn")}>
				<Plus size={14} aria-hidden="true" />
			</Button>
		</div>
	);
}
