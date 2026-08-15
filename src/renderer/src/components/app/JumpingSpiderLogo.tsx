/**
 * JumpingSpiderLogo — 品牌临时 logo：卡通跳蛛（跳蛛科 Salticidae）。
 *
 * 纯 SVG、只依赖 className，桌面与 Web 品牌区共用；正式品牌 logo 到位后整体替换。
 * 特征取舍（正面视角，突出跳蛛辨识点）：
 * - 头胸（大圆）与腹部（椭圆）分体，8 条腿 + 脸前一对短触肢；
 * - 两只大前中眼（白底黑瞳 + 高光）是跳蛛标志性特征，两侧各一只小眼。
 * 颜色走 currentColor（跟随字标明暗），瞳孔固定深色保证两种主题下都有对比。
 */
export function JumpingSpiderLogo(props: { className?: string }) {
	return (
		<svg viewBox="0 0 32 32" fill="none" className={props.className} aria-hidden="true">
			{/* 左侧 4 条腿：上两对上扬、下两对下垂 */}
			<path d="M7.5 15.5C3.5 14 1.5 11 2 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
			<path d="M6.5 17.5C2.5 16.5 0.5 15 0.5 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
			<path d="M6.5 20C3 20 1 21 1 23.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
			<path d="M7.5 22C4.5 23 3.5 25 4.5 27.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
			{/* 右侧 4 条腿（镜像） */}
			<path d="M24.5 15.5C28.5 14 30.5 11 30 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
			<path d="M25.5 17.5C29.5 16.5 31.5 15 31.5 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
			<path d="M25.5 20C29 20 31 21 31 23.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
			<path d="M24.5 22C27.5 23 28.5 25 27.5 27.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
			{/* 脸前一对短触肢 */}
			<path d="M12 14.5C10 16.5 9 18.5 10 20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
			<path d="M20 14.5C22 16.5 23 18.5 22 20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
			{/* 腹部 */}
			<ellipse cx="16" cy="22.5" rx="7" ry="7.5" fill="currentColor" />
			{/* 头胸 */}
			<circle cx="16" cy="10" r="6.8" fill="currentColor" />
			{/* 两只大前中眼：白底 + 黑瞳 + 高光 */}
			<circle cx="12.3" cy="9" r="3" fill="#ffffff" />
			<circle cx="19.7" cy="9" r="3" fill="#ffffff" />
			<circle cx="12.3" cy="9" r="1.5" fill="#141414" />
			<circle cx="19.7" cy="9" r="1.5" fill="#141414" />
			<circle cx="11.4" cy="8.1" r="0.55" fill="#ffffff" />
			<circle cx="18.8" cy="8.1" r="0.55" fill="#ffffff" />
			{/* 两侧小眼 */}
			<circle cx="7" cy="7.5" r="1.1" fill="#ffffff" />
			<circle cx="25" cy="7.5" r="1.1" fill="#ffffff" />
			<circle cx="7" cy="7.5" r="0.55" fill="#141414" />
			<circle cx="25" cy="7.5" r="0.55" fill="#141414" />
		</svg>
	);
}
