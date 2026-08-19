import { t } from "../../i18n";

/**
 * 黑底 π 品牌标。默认 32（错误页）；起始页 / 空态可放大。
 * 独立成文件，避免 Web 空态为了 LogoMark 拖进整棵会话组件树。
 */
export function LogoMark({ size = 32 }: { size?: number } = {}) {
	const glyph = Math.round(size * 0.5625);
	return (
		<div
			className="logo-mark relative grid place-items-center overflow-hidden rounded-md bg-black text-white shadow-sm ring-1 ring-white/15"
			style={{ width: size, height: size }}
			aria-label={t("app.logoLabel")}
		>
			{/* 独立银灰渐变，浅色/深色主题下都保持黑底白标对比。 */}
			<svg viewBox="140 140 520 520" width={glyph} height={glyph} aria-hidden="true">
				<defs>
					<linearGradient id="logo-mark-silver" x1="0.2" y1="0" x2="0.8" y2="1">
						<stop stopColor="#ffffff" />
						<stop offset="0.5" stopColor="#f4f4f5" />
						<stop offset="1" stopColor="#a7a8ab" />
					</linearGradient>
				</defs>
				<path
					fill="url(#logo-mark-silver)"
					fillRule="evenodd"
					d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
				/>
				<path fill="url(#logo-mark-silver)" d="M517.36 400H634.72V634.72H517.36Z" />
			</svg>
		</div>
	);
}
