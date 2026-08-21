import type { AgentBackend } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { Avatar, AvatarFallback } from "../../ui-shadcn/avatar";
import { DshLogo, PiLogo } from "../SessionSourceBadge";
import { formatTime } from "../TimelineFormat";

/**
 * AI 回复行头：用 shadcn Avatar + 署名标出当前运行时（Pi / DSH）。
 *
 * 业务规则：
 * - 时间线必须同时展示 Pi 与 DSH。Pi 虽是默认后端，但回复气泡需要明确“是谁在说话”，
 *   不能沿用侧栏 `SessionBackendMark`「Pi 不署名」的降噪策略。
 * - 头像走品牌内联 SVG（Fallback），不拉远程图，保证离线会话也能辨认。
 */
export function TurnAuthorHeader(props: {
	backend?: AgentBackend;
	endedAt: number;
}) {
	const backend: AgentBackend = props.backend ?? "pi";
	const isDsh = backend === "dsh";
	const name = t(isDsh ? "sessionBackend.dsh" : "sessionBackend.pi");

	return (
		<div
			className="mb-1 flex items-center gap-2"
			data-turn-author={backend}
		>
			<Avatar aria-hidden="true" className="bg-muted text-foreground">
				{/* 无 AvatarImage：品牌 logo 是矢量资源，失败态就是正常态。 */}
				<AvatarFallback delayMs={0} className="bg-transparent text-current">
					{isDsh ? (
						<DshLogo className="size-4" />
					) : (
						<PiLogo className="size-4" />
					)}
				</AvatarFallback>
			</Avatar>
			<div className="inline-flex min-w-0 items-baseline gap-2 text-muted-foreground tabular-nums">
				<span className="shrink-0 text-control font-medium leading-none text-foreground">
					{name}
				</span>
				<time className="shrink-0 font-mono text-body leading-none">
					{formatTime(props.endedAt)}
				</time>
			</div>
		</div>
	);
}
