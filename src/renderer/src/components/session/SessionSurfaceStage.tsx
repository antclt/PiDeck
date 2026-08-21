import { ChevronDown } from "lucide-react";
import { useAtomValue } from "jotai";
import type { SessionTimelineController } from "../../hooks/useSessionTimelineController";
import type { SessionMessageTimelineProps } from "./SessionMessageTimeline";
import { SessionMessageTimeline } from "./SessionMessageTimeline";
import { sessionHistoryMutationOverlayBySessionIdAtomFamily } from "../../atoms";
import { t, type TranslationKey } from "../../i18n";

const HISTORY_OVERLAY_COPY: Record<string, TranslationKey> = {
	stopping: "message.historyOverlay.stopping",
	mutating: "message.historyOverlay.mutating",
	reloading: "message.historyOverlay.reloading",
	activating: "message.historyOverlay.activating",
	forking: "message.historyOverlay.forking",
};

/**
 * 中栏表面：只承载对话时间线。轨迹复盘已迁到右侧抽屉独立 tab。
 */
export function SessionSurfaceStage(props: {
	sessionId: string;
	sessionTimeline: SessionTimelineController;
	timelineProps: Omit<SessionMessageTimelineProps, "sessionId" | "controller">;
	isRestarting: boolean;
}) {
	const { sessionId, sessionTimeline, timelineProps, isRestarting } = props;
	const mutationKind = useAtomValue(
		sessionHistoryMutationOverlayBySessionIdAtomFamily(sessionId),
	);
	const overlayVisible = isRestarting || Boolean(mutationKind);
	const overlayLabel = isRestarting
		? t("app.restarting")
		: mutationKind
			? t(HISTORY_OVERLAY_COPY[mutationKind] ?? "message.historyOverlay.mutating")
			: t("app.restarting");
	return (
		<div className="relative h-full min-h-0">
			<SessionMessageTimeline
				sessionId={sessionId}
				controller={sessionTimeline}
				{...timelineProps}
			/>

			{sessionTimeline.showScrollToBottom && (
				<button
					className="scroll-to-bottom-btn"
					onClick={sessionTimeline.scrollToBottom}
					title={t("app.scrollToBottom")}
					aria-label={t("app.scrollToBottom")}
				>
					<ChevronDown size={18} />
				</button>
			)}
			{/* 重启 / 历史改写遮罩：opacity 过渡 + loader 旋转走合成器，始终挂载以便淡出。 */}
			<div
				className={`absolute inset-0 z-30 flex flex-col items-center justify-center gap-2.5 bg-bg-panel/70 transition-opacity duration-200 ${overlayVisible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
				role={overlayVisible ? "status" : undefined}
				aria-hidden={!overlayVisible}
			>
				<div className="loader" />
				<span className="text-body text-text-secondary">{overlayLabel}</span>
			</div>
		</div>
	);
}
