/**
 * 公告中心：侧栏底栏入口按钮（含未读圆点）+ 弹窗列表 + 公告详情弹窗。
 *
 * 设计要点：
 * - 红点/角标与列表未读标记共用 unreadAnnouncementsAtom 派生（单一 owner，见 atoms）；
 * - 打开弹窗即标记全部已读（公告是低频广播，不做逐条已读的复杂交互）；
 * - 列表卡片只展示清洗后的短摘要（announcementExcerpt），完整正文放「查看详情」
 *   弹窗经 MarkdownStream 渲染——公告是外部数据，全量 md 渲染走会话消息同一套
 *   sanitize 管线（streamdown 默认 rehype-sanitize），不新增注入面；
 * - 手动刷新失败静默提示（showNotice），不打断浏览。
 */
import { useCallback, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Megaphone, RefreshCw } from "lucide-react";
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
			<DialogContent className="flex max-h-[75vh] flex-col sm:max-w-xl">
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
 * 未读数 > 0 时按钮显示圆点；打开弹窗即触发全部已读（幂等）。
 */
export function AnnouncementCenter() {
	const [refreshing, setRefreshing] = useState(false);
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
	const unreadCount = unread.length;

	// 入口隐藏：开关关闭 = 用户不要公告，通知与入口一并下线（挂载点不变，侧栏结构稳定）
	if (!notifyEnabled) return null;

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
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
							{/* 未读圆点：与设置按钮更新角标同款式 */}
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
			<DialogContent className="max-h-[70vh] sm:max-w-lg">
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
						(() => {
							// 快照 items 有序（发布时间倒序）；已读集合转 Set 避免 O(n²)
							const readSet = new Set(state?.readIds ?? []);
							return items.map((item) => (
								<AnnouncementCard
									key={item.id}
									item={item}
									unread={!readSet.has(item.id)}
									onViewDetail={viewDetail}
								/>
							));
						})()
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
