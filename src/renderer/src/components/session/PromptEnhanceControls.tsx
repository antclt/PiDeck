import { useEffect, useRef } from "react";
import { Sparkles, Square } from "lucide-react";
import type { PromptEnhanceView } from "../../hooks/usePromptEnhance";
import { t } from "../../i18n";
import { Button } from "../motion/button";
import { Loader } from "../motion/loader";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui-shadcn/tooltip";

/**
 * 提示词增强控件（底栏入口 + 输入框上方流式预览面板）。
 *
 * 动效语言与语音转写控件同源（28px 胶囊、beui motion Button/Loader、形状区分状态），
 * 但多一层「看得见的进度」：预览面板把流式文本逐字展示在输入框正上方，
 * 原稿仍在下方输入框里，两者同屏对照；任意时刻可点 ■ 停止。
 * 三态不看文字也能区分：
 * - idle：✦ 图标按钮；
 * - starting（模型未吐首字）：中性胶囊 + helix loader；
 * - streaming（预览增长中）：主色胶囊 + 面板 + 呼吸光标 + 字数跳动。
 */
const BAR_BUTTON_CLASS = "size-7 rounded-md text-foreground hover:bg-muted/60";
const RUNNING_PILL_CLASS = "flex h-7 items-center gap-1 rounded-md bg-muted/60 pr-0.5 pl-1.5";

/** 预览自动跟随滚动：流式增长时贴底，用户上滚查阅时不抢滚动条。 */
function usePreviewAutoScroll(preview: string) {
	const ref = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		// 只有本来就在底部附近时才跟随，避免打断用户往上翻。
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
		if (nearBottom) el.scrollTop = el.scrollHeight;
	}, [preview]);
	return ref;
}

export function PromptEnhanceControls(props: { disabled?: boolean; view: PromptEnhanceView; modelLabel?: string; onStart: () => void; onCancel: () => void }) {
	const running = props.view.phase !== "idle";
	const previewRef = usePreviewAutoScroll(running ? props.view.preview : "");
	const startTip = props.modelLabel ? `${t("enhance.start")} · ${props.modelLabel}` : t("enhance.start");
	const busyLabel = props.view.phase === "starting" ? t("enhance.starting") : `${t("enhance.streaming")} · ${t("enhance.chars", { count: props.view.chars })}`;

	return (
		<>
			{running ? (
				<div className="absolute right-3 bottom-full left-3 z-30 mb-2" role="status" aria-live="polite">
					<div className="overflow-hidden rounded-xl border border-border/60 bg-popover/95 shadow-lg backdrop-blur-sm">
						<div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-3 py-1.5 text-xs">
							<Sparkles className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
							<span className="shrink-0 font-medium text-popover-foreground">{t("enhance.panelTitle")}</span>
							{props.modelLabel ? <span className="truncate text-muted-foreground">{props.modelLabel}</span> : null}
							<span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{t("enhance.chars", { count: props.view.chars })}</span>
						</div>
						<div ref={previewRef} className="max-h-40 overflow-y-auto px-3 py-2 text-sm break-words whitespace-pre-wrap text-popover-foreground">
							{props.view.phase === "starting" ? (
								<span className="animate-pulse text-muted-foreground">{t("enhance.starting")}</span>
							) : (
								<>
									{props.view.preview}
									{/* 呼吸光标：不依赖字符数量也能看出「还在写」。 */}
									<span className="animate-pulse text-primary" aria-hidden="true">
										▍
									</span>
								</>
							)}
						</div>
					</div>
				</div>
			) : null}
			{running ? (
				<div className={RUNNING_PILL_CLASS}>
					<Loader variant="helix" size={13} speed={1.1} label={busyLabel} className={props.view.phase === "starting" ? "text-muted-foreground" : "text-primary"} />
					<span className="text-caption max-w-40 truncate whitespace-nowrap text-muted-foreground" aria-hidden="true">
						{busyLabel}
					</span>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button type="button" variant="ghost" size="icon" aria-label={t("enhance.stop")} className="size-7 shrink-0 rounded-md text-destructive hover:bg-destructive/15 hover:text-destructive" onClick={props.onCancel}>
								<Square className="size-3" fill="currentColor" aria-hidden="true" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("enhance.stop")}</TooltipContent>
					</Tooltip>
				</div>
			) : (
				<Tooltip>
					<TooltipTrigger asChild>
						<Button type="button" variant="ghost" size="icon" ripple disabled={props.disabled} aria-label={t("enhance.start")} className={BAR_BUTTON_CLASS} onClick={props.onStart}>
							<Sparkles className="size-3.5" aria-hidden="true" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{startTip}</TooltipContent>
				</Tooltip>
			)}
		</>
	);
}
