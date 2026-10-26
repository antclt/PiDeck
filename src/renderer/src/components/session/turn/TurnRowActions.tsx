import { Clock, Share, SquarePen, Star, Trash } from "lucide-react";
import type { RefObject } from "react";
import type { ChatMessage } from "../../../../../shared/types";
import { t } from "../../../i18n";
import type { AgentRunItem } from "../timeline/types";
import { Button } from "../../ui-shadcn/button";
import { LiveDuration } from "../LiveDuration";
import { CopyMenu } from "../SurfaceComponents";
import { formatDuration } from "../TimelineFormat";

export type TurnRowActionsProps = {
	run: AgentRunItem;
	/** 整轮回复正文（Markdown 源码）；为空时整栏只剩耗时/模型。 */
	mergedText: string;
	editing: boolean;
	containsImageGen: boolean;
	/** 惰性求值的纯文本（`stripMarkdown` 走正则，只在点「复制为文本」时才跑）。 */
	resolvePlainText: () => string;
	/** 复制为图片的截取目标（整轮 `<article>`）。 */
	targetRef: RefObject<HTMLElement | null>;
	replyFavorited: boolean;
	replyMessageId: string | null;
	onFavoriteReply?: (text: string, messageId: string | null) => void;
	onEnterMultiSelect?: () => void;
	/** 进入编辑态；undefined = 不显示编辑按钮（流式中 / 无可编辑目标 / 上层没给回调）。 */
	onStartEdit?: () => void;
	/** 删除本轮回复；undefined = 不显示删除按钮，判据同上。 */
	onDeleteReply?: () => void;
	showDuration: boolean;
	isRunLive: boolean;
	effectiveStart: number;
	duration: number;
	showTurnModel: boolean;
	turnModel?: ChatMessage["model"];
};

/**
 * 轮尾操作栏：复制（文本 / 图片）/ 收藏 / 多选 / 编辑 / 删除，以及行末的耗时与模型名。
 *
 * 为什么单独一个组件：TurnRow 是「一轮怎么组织」，这里是「一轮结束后给用户哪些动作」。
 * 抽出来之前这段 60 多行的 JSX 与折叠栏、最终回答、文件清单挤在同一个 return 里，
 * TurnRow 已经越过单文件行数红线（AGENTS.md §6：超 600 行必须评估拆分）。
 *
 * 两条纪律写在搬移前，搬完照旧生效：
 * 1. 耗时与模型名排在**行末**（用户视线在底部），全轮只有一个耗时显示点；
 * 2. 半透明降噪必须盖住整行——按钮图标与行末数字同一层，否则「图标偏淡、数字偏深」。
 */
export function TurnRowActions(props: TurnRowActionsProps) {
	const showActions = Boolean(props.mergedText) && !props.editing;
	if (!showActions && !props.showDuration && !props.showTurnModel) return null;
	return (
		<div className={`flex min-h-6 items-center gap-1${showActions ? " opacity-55 transition-opacity hover:opacity-100 focus-within:opacity-100" : ""}`}>
			{showActions && (
				<>
					{!props.containsImageGen && <CopyMenu resolveText={props.resolvePlainText} markdown={props.mergedText} targetRef={props.targetRef} />}
					{/* 收藏整轮回复：与复制同源（Markdown 源码），快照落本机收藏页；入口不依赖编辑权限。
						    已收藏显示实心星（与右键菜单同一身份），再点即取消。 */}
					{props.onFavoriteReply && (
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className="turn-row-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
							aria-pressed={props.replyFavorited}
							onClick={() => props.onFavoriteReply?.(props.mergedText, props.replyMessageId)}
							title={props.replyFavorited ? t("favorites.unsaveMessage") : t("favorites.saveMessage")}
							aria-label={props.replyFavorited ? t("favorites.unsaveMessage") : t("favorites.saveMessage")}
						>
							<Star size={14} className={props.replyFavorited ? "fill-current" : undefined} />
						</Button>
					)}
					<Button type="button" variant="ghost" size="icon-sm" className="turn-row-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={props.onEnterMultiSelect} title={t("app.multiSelectEnter")}>
						<Share size={14} />
					</Button>
					{props.onStartEdit && (
						<Button type="button" variant="ghost" size="icon-sm" className="turn-row-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={props.onStartEdit} title={t("common.edit")}>
							<SquarePen size={14} />
						</Button>
					)}
					{props.onDeleteReply && (
						<Button type="button" variant="ghost" size="icon-sm" className="turn-row-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={props.onDeleteReply} title={t("common.delete")}>
							<Trash size={14} />
						</Button>
					)}
				</>
			)}
			{props.showDuration && (
				/* 图标尺寸 14 对齐同行按钮图标（原独占一行时是 12）；
					   pl-[7px] 等于 size-7 按钮里 14px 图标的水平内缩量：时钟与前一个按钮图标的间距
					   7+gap-1+7 与按钮之间的一致，不再比按钮之间更近。 */
				<div className="flex items-center gap-1.5 pl-[7px] text-muted-foreground">
					<Clock size={14} className="shrink-0" aria-hidden="true" />
					{/* 耗时数字与行头时间一致用界面字体（见 TurnAuthorHeader 注释）；tabular-nums 保持跳动不抖 */}
					<span className="text-body leading-none tabular-nums">
						{props.isRunLive && props.run.askPending ? formatDuration(Math.max(0, (props.run.askPendingAt ?? props.effectiveStart) - props.effectiveStart)) : props.isRunLive ? <LiveDuration startedAt={props.effectiveStart} isStreaming /> : formatDuration(props.duration)}
					</span>
				</div>
			)}
			{props.showTurnModel && props.turnModel && (
				/* 本轮实际使用的模型（provider + modelId）跟在耗时后面：同一会话内用户会频繁换模型，
					   只在输入框显示当前模型不足以回看历史轮；流式中不显示，回复结束才落定。
					   保留等宽字体与限宽截断以区别于耗时读数（text-body + 等宽数字），但去掉灰底
					   ——每轮都有的元信息 chip 会给时间线添碎（2026-10 去底，ZCode 模型名即裸暗字）。
					   title 给全量 provider/model。 */
				<span className="ml-1 min-w-0 max-w-[16rem] truncate font-mono text-chat-detail leading-none text-text-tertiary" title={`${props.turnModel.provider}/${props.turnModel.modelId}`} data-turn-model={props.turnModel.modelId}>
					{props.turnModel.modelId}
				</span>
			)}
		</div>
	);
}
