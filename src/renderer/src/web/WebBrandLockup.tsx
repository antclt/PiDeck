/**
 * WebBrandLockup — Web 端品牌区（与桌面 AppParts.BrandLockup 同视觉）。
 *
 * 不直接复用 AppParts.BrandLockup 是为了避免把桌面端整棵渲染组件树
 * （SurfaceComponents / atoms / desktopApi 等）拖进 Web 包；这里只复用
 * JumpingSpiderLogo（正式几何跳蛛标，无桌面业务依赖）。
 */
import { JumpingSpiderLogo } from "../components/app/JumpingSpiderLogo";

export function WebBrandLockup() {
	return (
		<div className="brand-lockup flex h-9 min-w-0 items-center gap-2.5" aria-label="phids">
			<JumpingSpiderLogo className="size-5 shrink-0" />
			<span
				className="brand-wordmark translate-x-0.5 truncate text-[18px] font-[PiDeckDepartureMono] font-normal leading-none text-zinc-950 dark:text-white"
				aria-hidden="true"
			>
				phids
			</span>
		</div>
	);
}
