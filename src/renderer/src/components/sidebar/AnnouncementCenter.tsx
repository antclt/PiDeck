/**
 * 公告中心：侧栏底栏入口按钮（含未读圆点）+ 弹窗列表 + 公告详情弹窗。
 *
 * 公告分三类（AnnouncementCategory）：
 * - flash 临时通知（时点性）：系统维护/活动截止等，读完即从列表移除（不值得回查），强提醒；
 * - notice 公告（正式广播）：版本发布/行为变更等，读后折叠进「已读归档」可回查；
 * - guide 指南（常驻参考）：新手教程/功能说明，始终显示在「使用指南」区，不参与未读/红点/toast。
 *
 * 设计要点：
 * - 列表按「临时通知 → 公告 → 使用指南 → 已读归档」分区，各区内部发布时间倒序（新的在前）；
 * - 未读（flash + notice）+ 指南默认只展开前 VISIBLE_LIMIT 条，超出走「展示更多公告 (N)」/「收起」；
 * - 已读归档默认折叠成一行计数（看过后不该占主列表），可展开回看；已读 flash 不归档、直接消失；
 * - 红点/角标与列表未读标记共用 unreadAnnouncementsAtom（仅统计 flash+notice，见 atoms）；
 * - 打开弹窗即标记全部已读（公告是低频广播，不做逐条已读的复杂交互）；
 * - 列表卡片只展示清洗后的短摘要（announcementExcerpt），完整正文放「查看详情」
 *   弹窗经 MarkdownStream 渲染——公告是外部数据，全量 md 渲染走会话消息同一套
 *   sanitize 管线（streamdown 默认 rehype-sanitize），不新增注入面；
 * - 手动刷新失败静默提示（showNotice），不打断浏览。
 */
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { ChevronDown, ChevronRight, Megaphone, RefreshCw } from "lucide-react";
import {
	unreadAnnouncementsAtom,
	announcementStateAtom,
	announcementCenterOpenAtom,
	announcementNotificationEnabledAtom,
} from "../../atoms/announcement-atoms";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { announcementExcerpt } from "../../utils/announcementExcerpt";
import { showNotice } from "../../utils/notice";
import { MarkdownStream } from "../session/MarkdownStream";
import { Button } from "../ui-shadcn/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "../ui-shadcn/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui-shadcn/tooltip";
import type { AnnouncementItem } from "../../../../shared/types/announcement";

/** 未读通知 + 使用指南的默认展示上限；超出走「展示更多公告」，不全量展开。 */
const VISIBLE_LIMIT = 5;

/** 公告级别 → 视觉锚点类（tone-* 保留锚点，颜色规则走既有 token 状态规则）。 */
function levelToneClass(level: AnnouncementItem["level"]): string {
	switch (level) {
		case "critical":
			return "tone-critical";
		case "warn":
			return "tone-warn";
		default:
			return "tone-info";
	}
}

/** 分区小标题（未读通知/使用指南/已读通知），保持整页结构可扫读。 */
function SectionLabel(props: { children: ReactNode; count?: number }) {
	const { children, count } = props;
	return (
		<div className="flex items-baseline gap-1.5 px-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70 first:mt-0 mt-1">
			<span>{children}</span>
			{count !== undefined && count > 0 && (
				<span className="text-muted-foreground/50">({count})</span>
			)}
		</div>
	);
}

/** 单条公告卡片：标题 + 级别锚点 + 清洗后的短摘要 + 「查看详情」入口。 */
function AnnouncementCard(props: {
	item: AnnouncementItem;
	unread: boolean;
	onViewDetail: (item: AnnouncementItem) => void;
}) {
	const { item, unread, onViewDetail } = props;
	return (
		<article
			className={cn(
				"rounded-lg border border-border/50 bg-muted/30 p-3",
				unread && "border-[var(--color-accent)]/50",
			)}
		>
			<header className="flex items-center gap-2">
				{unread && (
					<span
						className="size-2 shrink-0 rounded-full bg-[var(--color-accent)]"
						aria-hidden="true"
					/>
				)}
				<h4 className={cn("text-sm font-medium leading-snug", levelToneClass(item.level))}>
					{item.title}
				</h4>
			</header>
			{/* 列表卡片不渲染 md（公告是外部数据）：摘要清洗标记 + 折叠空白 + 截断，
			   完整正文放详情弹窗经 MarkdownStream 的 sanitize 管线渲染 */}
			<p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
				{announcementExcerpt(item.body)}
			</p>
			<footer className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground/80">
				<time dateTime={item.publishedAt}>{item.publishedAt.slice(0, 10)}</time>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-auto p-0 text-[11px] text-muted-foreground/80 hover:text-foreground"
					onClick={() => onViewDetail(item)}
				>
					{t("announcements.viewDetail")}
				</Button>
			</footer>
		</article>
	);
}

/**
 * 公告详情弹窗：完整正文经 MarkdownStream 渲染（light 模式，公告正文是外部数据，
 * 走会话消息同一套 sanitize 管线；light 关闭图表/代码高亮等重渲染，静态场景更省内存）。
 */
function AnnouncementDetailDialog(props: {
	item: AnnouncementItem | null;
	onClose: () => void;
}) {
	const { item, onClose } = props;
	return (
		<Dialog
			open={item !== null}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<DialogContent className="flex max-h-[80vh] flex-col sm:max-w-2xl">
				{item && (
					<>
						<DialogHeader>
							<DialogTitle className={levelToneClass(item.level)}>{item.title}</DialogTitle>
							<DialogDescription>
								{t("announcements.publishedAt", {
									time: item.publishedAt.slice(0, 10),
								})}
							</DialogDescription>
						</DialogHeader>
						<div className="min-h-0 flex-1 overflow-y-auto pr-1">
							<MarkdownStream
								text={item.body}
								isStreaming={false}
								light
								// 正文里的外链走系统浏览器（与列表弹窗历史行为一致），失败静默
								onOpenExternal={(url, forceSystem) => {
									void desktopApi.app
										.openExternal(url, forceSystem)
										.catch(() => undefined);
								}}
							/>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

/**
 * 公告中心入口 + 弹窗。挂在侧栏底栏 Dock（与设置/反馈并排）。
 * 未读数（仅 notice）> 0 时按钮显示圆点；打开弹窗即触发全部已读（幂等）。
 */
export function AnnouncementCenter() {
	const [refreshing, setRefreshing] = useState(false);
	// 「展示更多」开关：未读+指南合计超过 VISIBLE_LIMIT 时控制展开全部
	const [showAllActive, setShowAllActive] = useState(false);
	// 已读通知区默认折叠成一行计数，只看一眼就用不着撑开长列表
	const [showRead, setShowRead] = useState(false);
	// 详情弹窗受控状态：null = 关闭；打开时与列表弹窗并存（列表在上层 Dialog）
	const [detailItem, setDetailItem] = useState<AnnouncementItem | null>(null);
	// 弹窗开关提升为 atom：toast「查看」按钮需要远程打开公告中心（单一 owner，见 announcement-atoms）
	const open = useAtomValue(announcementCenterOpenAtom);
	const setOpen = useSetAtom(announcementCenterOpenAtom);
	const state = useAtomValue(announcementStateAtom);
	const unread = useAtomValue(unreadAnnouncementsAtom);
	// 「公告通知」开关关闭时整个公告入口隐藏（用户明确不要公告），
	// 同一开关也控制 toast 弹出（见 useAnnouncementNotifier），数据源单一
	const notifyEnabled = useAtomValue(announcementNotificationEnabledAtom);
	// 打开弹窗即已读：主进程幂等合并，重复调用安全
	const markAllRead = useCallback(() => {
		void desktopApi.announcements.markAllRead().catch(() => undefined);
	}, []);

	const refresh = useCallback(() => {
		setRefreshing(true);
		desktopApi.announcements
			.refresh()
			.then(() => undefined)
			.catch(() => {
				// 结构化错误提示：手动刷新是用户显式操作，失败必须可感知（但不打断浏览）
				showNotice(t("announcements.refreshFailed"), 4000, "error");
			})
			.finally(() => setRefreshing(false));
	}, []);

	// 打开详情视为已浏览（与打开列表弹窗语义一致，markAllRead 幂等可重复调用）
	const viewDetail = useCallback(
		(item: AnnouncementItem) => {
			setDetailItem(item);
			markAllRead();
		},
		[markAllRead],
	);

	const items = state?.items ?? [];
	const readSet = new Set(state?.readIds ?? []);
	// 类别路由：flash=时点信息（读完即焚，不归档）/ notice=正式广播（读后进归档区）/ guide=常驻指南（不参与未读）
	const unreadFlashes = items.filter((item) => item.category === "flash" && !readSet.has(item.id));
	const unreadNotices = items.filter((item) => item.category === "notice" && !readSet.has(item.id));
	const readNotices = items.filter((item) => item.category === "notice" && readSet.has(item.id));
	const guides = items.filter((item) => item.category === "guide");
	// 主展示区 = 未读临时通知 + 未读公告 + 使用指南（新的在前，快照已按发布时间倒序）
	const activeItems = [...unreadFlashes, ...unreadNotices, ...guides];
	const activeVisible = showAllActive ? activeItems : activeItems.slice(0, VISIBLE_LIMIT);
	const hiddenCount = Math.max(0, activeItems.length - VISIBLE_LIMIT);
	const unreadCount = unread.length;

	// 入口隐藏：开关关闭 = 用户不要公告，通知与入口一并下线（挂载点不变，侧栏结构稳定）
	if (!notifyEnabled) return null;

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				// 关闭时复位展开状态，下次打开回到默认折叠视图
				if (!next) {
					setShowAllActive(false);
					setShowRead(false);
				}
				// 关闭/打开都视为「已浏览」：打开瞬间标记，弹窗内未读点即时消隐
				if (next && unreadCount > 0) markAllRead();
			}}
		>
			<Tooltip delayDuration={300}>
				<TooltipTrigger asChild>
					<DialogTrigger asChild>
						<div className="relative size-full">
							<Button
								type="button"
								variant="ghost"
								className="size-full rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
								title={t("announcements.title")}
								aria-label={
									unreadCount > 0
										? t("announcements.unreadAria", { count: String(unreadCount) })
										: t("announcements.title")
								}
							>
								<Megaphone className="size-4" />
							</Button>
							{/* 未读圆点：与设置按钮更新角标同款式；仅 notice 计入（guide 常驻不打扰） */}
							{unreadCount > 0 && (
								<span
									className="pointer-events-none absolute right-1 top-1 size-2 rounded-full bg-[var(--color-accent)]"
									aria-hidden="true"
								/>
							)}
						</div>
					</DialogTrigger>
				</TooltipTrigger>
				<TooltipContent side="right" sideOffset={6}>
					{unreadCount > 0
						? t("announcements.unreadBadge", { count: String(unreadCount) })
						: t("announcements.title")}
				</TooltipContent>
			</Tooltip>
			<DialogContent className="flex max-h-[80vh] flex-col sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{t("announcements.title")}</DialogTitle>
					<DialogDescription>
						{state?.fetchedAt
							? t("announcements.fetchedAt", {
									time: new Date(state.fetchedAt).toLocaleString(),
								})
							: t("announcements.notFetched")}
					</DialogDescription>
				</DialogHeader>
				<div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pr-1">
					{items.length === 0 ? (
						<p className="py-8 text-center text-sm text-muted-foreground">
							{t("announcements.empty")}
						</p>
					) : (
						<>
							{/* 临时通知：已读即焚（不归档），时点信息看完就该消失 */}
							{unreadFlashes.length > 0 && (
								<section className="flex flex-col gap-2.5">
									<SectionLabel count={unreadFlashes.length}>
										{t("announcements.section.flash")}
									</SectionLabel>
									{activeVisible
										.filter((item) => item.category === "flash")
										.map((item) => (
											<AnnouncementCard
												key={item.id}
												item={item}
												unread
												onViewDetail={viewDetail}
											/>
										))}
								</section>
							)}
							{/* 公告：未读时展示，读后进归档区 */}
							{unreadNotices.length > 0 && (
								<section className="flex flex-col gap-2.5">
									<SectionLabel count={unreadNotices.length}>
										{t("announcements.section.notice")}
									</SectionLabel>
									{activeVisible
										.filter((item) => item.category === "notice")
										.map((item) => (
											<AnnouncementCard
												key={item.id}
												item={item}
												unread
												onViewDetail={viewDetail}
											/>
										))}
								</section>
							)}
							{/* 使用指南：常驻参考，不参与未读，始终展示 */}
							{guides.length > 0 && (
								<section className="flex flex-col gap-2.5">
									<SectionLabel count={guides.length}>
										{t("announcements.section.guides")}
									</SectionLabel>
									{activeVisible
										.filter((item) => item.category === "guide")
										.map((item) => (
											<AnnouncementCard
												key={item.id}
												item={item}
												unread={false}
												onViewDetail={viewDetail}
											/>
										))}
								</section>
							)}
							{/* 展示更多 / 收起：未读+指南合计超过上限时出现，避免大全量展开 */}
							{hiddenCount > 0 && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="self-center text-xs text-muted-foreground hover:text-foreground"
									onClick={() => setShowAllActive((v) => !v)}
								>
									{showAllActive
										? t("announcements.collapse")
										: t("announcements.showMore", { count: String(hiddenCount) })}
								</Button>
							)}
							{/* 已读归档：公告读过折叠成一行（看过后不该占主列表）；flash 已读不归档直接消失 */}
							{readNotices.length > 0 && (
								<section className="flex flex-col gap-2.5">
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="h-auto justify-start gap-1 self-start px-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70 hover:bg-transparent hover:text-foreground"
										onClick={() => setShowRead((v) => !v)}
										aria-expanded={showRead}
									>
										{showRead ? (
											<ChevronDown className="size-3.5" />
										) : (
											<ChevronRight className="size-3.5" />
										)}
										{t("announcements.section.read")}
										<span className="text-muted-foreground/50">({readNotices.length})</span>
									</Button>
									{showRead &&
										readNotices.map((item) => (
											<AnnouncementCard
												key={item.id}
												item={item}
												unread={false}
												onViewDetail={viewDetail}
											/>
										))}
								</section>
							)}
						</>
					)}
				</div>
				<DialogFooter className="items-center gap-2">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={refresh}
						disabled={refreshing}
					>
						<RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
						{t("announcements.refresh")}
					</Button>
					{unreadCount > 0 && (
						<Button type="button" variant="ghost" size="sm" onClick={markAllRead}>
							{t("announcements.markAllRead")}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
			{/* 详情弹窗（嵌套 Dialog）：列表弹窗之上展示完整正文，关闭只复位本弹窗 */}
			<AnnouncementDetailDialog item={detailItem} onClose={() => setDetailItem(null)} />
		</Dialog>
	);
}