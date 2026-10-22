import { useEffect, useMemo, useState } from "react";
import { Bot, Copy, Loader2, Search, Star, TextQuote, Trash2, UserRound, X } from "lucide-react";
import type { FavoriteEntry, FavoriteRole } from "../../../../shared/types";
import { useFavorites } from "../../hooks/useFavorites";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { writeClipboard } from "../../utils/clipboard";
import { showNotice } from "../../utils/notice";
import { openInSystemBrowser } from "../../utils/openExternal";
import { formatFullDateTime, formatRelativeTime } from "../../utils/relativeTime";
import { MarkdownStream } from "../session/MarkdownStream";
import { stripMarkdown } from "../session/SurfaceParts";
import { Badge } from "../ui-shadcn/badge";
import { Button } from "../ui-shadcn/button";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { Input } from "../ui-shadcn/input";
import { filterFavorites, type FavoriteFilter } from "./favoriteFilters";

/** 筛选 chips：全部 / 回复 / 片段（与智能体分类 chips 同一形态）。 */
const FILTERS: readonly { value: FavoriteFilter; labelKey: "favorites.filterAll" | "favorites.filterMessage" | "favorites.filterSelection" }[] = [
	{ value: "all", labelKey: "favorites.filterAll" },
	{ value: "message", labelKey: "favorites.filterMessage" },
	{ value: "selection", labelKey: "favorites.filterSelection" },
];

function roleLabel(role: FavoriteRole): string {
	if (role === "user") return t("favorites.roleUser");
	if (role === "system") return t("favorites.roleSystem");
	return t("favorites.roleAssistant");
}

/**
 * 「收藏」页面主体：头部（标题 / 条数 / 搜索）+ 筛选 chips + 紧凑列表 + 右侧详情栏。
 *
 * 列表信息密度优先：卡片是两行（元信息 + 两行摘要）、高度约 72px，一屏能扫到更多条；
 * 完整内容（Markdown 渲染）在右侧详情里看——卡片摘要只给剥离 Markdown 的纯文本，
 * 避免列表里出现 ## / 围栏等源码噪声。收藏时间精确到秒常显，hover 给相对时间。
 */
export function FavoritesWorkspace() {
	const { entries, removeFavorite } = useFavorites();
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<FavoriteFilter>("all");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [pendingDelete, setPendingDelete] = useState<FavoriteEntry | null>(null);

	const visible = useMemo(() => filterFavorites(entries ?? [], query, filter), [entries, query, filter]);
	const selectedEntry = useMemo(() => (selectedId ? ((entries ?? []).find((entry) => entry.id === selectedId) ?? null) : null), [entries, selectedId]);
	const hasQuery = query.trim().length > 0;

	// 详情跟随数据：被删除（或列表刷新后不存在）就收起，避免详情栏停在死数据上。
	useEffect(() => {
		if (selectedId && entries && !entries.some((entry) => entry.id === selectedId)) setSelectedId(null);
	}, [entries, selectedId]);

	const handleCopy = async (entry: FavoriteEntry) => {
		const ok = await writeClipboard(entry.text);
		showNotice(ok ? t("copy.success") : t("copy.failed"), ok ? 1200 : 2000, ok ? undefined : "error");
	};

	const requestDelete = (entry: FavoriteEntry) => setPendingDelete(entry);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex shrink-0 flex-col gap-3 border-b border-border/40 px-5 py-3">
				<div className="flex items-start justify-between gap-4">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
								<Star className="size-4" aria-hidden="true" />
							</span>
							<h1 className="truncate text-base font-semibold text-foreground">{t("favorites.title")}</h1>
							{entries ? (
								<Badge variant="neutral" size="sm">
									{t("favorites.count", { count: entries.length })}
								</Badge>
							) : null}
						</div>
						<p className="mt-1 truncate text-xs text-muted-foreground">{t("favorites.subtitle")}</p>
					</div>
				</div>
				<div className="relative">
					<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
					<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("favorites.searchPlaceholder")} aria-label={t("favorites.searchPlaceholder")} size="sm" className="pl-7 text-xs" />
				</div>
			</header>

			<div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/40 px-5 py-2" role="group" aria-label={t("favorites.filterLabel")}>
				{FILTERS.map((item) => (
					<button
						key={item.value}
						type="button"
						aria-pressed={filter === item.value}
						onClick={() => setFilter(item.value)}
						className={cn("inline-flex h-6 items-center rounded-full border px-2.5 text-xs transition-colors", filter === item.value ? "border-primary/40 bg-primary/10 font-medium text-primary" : "border-border/60 text-muted-foreground hover:bg-muted/60 hover:text-foreground")}
					>
						{t(item.labelKey)}
					</button>
				))}
			</div>

			<div className="flex min-h-0 flex-1">
				<div className="min-w-0 flex-1 overflow-y-auto px-3 py-2">
					{entries === null ? (
						<div className="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground">
							<Loader2 className="size-4 animate-pideck-spin" aria-hidden="true" />
							{t("common.loading")}
						</div>
					) : visible.length === 0 ? (
						<div className="flex flex-col items-center gap-2 px-4 py-16 text-center">
							<Star className="size-8 text-muted-foreground/50" aria-hidden="true" />
							<div className="text-sm font-semibold text-foreground">{hasQuery ? t("favorites.noMatch") : t("favorites.emptyTitle")}</div>
							{!hasQuery && <p className="max-w-[360px] text-xs leading-6 text-muted-foreground">{t("favorites.emptyHint")}</p>}
						</div>
					) : (
						<div className="flex flex-col gap-1.5">
							{visible.map((entry) => (
								<FavoriteCard key={entry.id} entry={entry} selected={entry.id === selectedId} onSelect={(item) => setSelectedId((current) => (current === item.id ? null : item.id))} onCopy={(item) => void handleCopy(item)} onRequestDelete={requestDelete} />
							))}
						</div>
					)}
				</div>
				{selectedEntry && <FavoriteDetail entry={selectedEntry} onClose={() => setSelectedId(null)} onCopy={(item) => void handleCopy(item)} onRequestDelete={requestDelete} />}
			</div>

			{pendingDelete && (
				<ConfirmDialog
					title={t("favorites.deleteTitle")}
					message={t("favorites.deleteBody")}
					confirmLabel={t("common.delete")}
					danger
					onCancel={() => setPendingDelete(null)}
					onConfirm={() => {
						const target = pendingDelete;
						setPendingDelete(null);
						void removeFavorite(target.id);
					}}
				/>
			)}
		</div>
	);
}

/**
 * 紧凑收藏行：单行元信息 + 两行摘要（约 72px）。
 * 摘要对「整条消息」先 stripMarkdown（列表里不该出现 ## / 围栏源码），详情里再按 Markdown 渲染。
 */
function FavoriteCard(props: { entry: FavoriteEntry; selected: boolean; onSelect: (entry: FavoriteEntry) => void; onCopy: (entry: FavoriteEntry) => void; onRequestDelete: (entry: FavoriteEntry) => void }) {
	const entry = props.entry;
	const isSelection = entry.kind === "selection";
	const KindIcon = isSelection ? TextQuote : entry.role === "user" ? UserRound : Bot;
	const preview = useMemo(() => (isSelection ? entry.text : stripMarkdown(entry.text)), [entry.text, isSelection]);
	return (
		<article
			role="button"
			tabIndex={0}
			aria-label={t("favorites.openDetail")}
			aria-pressed={props.selected}
			onClick={() => props.onSelect(entry)}
			onKeyDown={(event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				props.onSelect(entry);
			}}
			className={cn("group flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors", props.selected ? "border-primary/40 bg-primary/5" : "border-border/50 hover:border-border hover:bg-muted/30")}
		>
			<span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
				<KindIcon className="size-3.5" aria-hidden="true" />
			</span>
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 items-center gap-1.5 text-micro text-muted-foreground">
					<span className="shrink-0">{isSelection ? t("favorites.kindSelection") : t("favorites.kindMessage")}</span>
					{entry.role && <span className="shrink-0">· {roleLabel(entry.role)}</span>}
					<span className="min-w-0 truncate" title={entry.sessionTitle ?? undefined}>
						· {entry.sessionTitle ?? t("favorites.sourceUnknown")}
					</span>
					{entry.partial && <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5">{t("favorites.partial")}</span>}
					{entry.truncated && <span className="shrink-0 rounded-sm bg-muted px-1 py-0.5">{t("favorites.truncated")}</span>}
					{/* 收藏时间：精确日期时间常显（用户要「记录时间」），hover 给相对时间便于扫视 */}
					<time className="ml-auto shrink-0 tabular-nums" dateTime={new Date(entry.createdAt).toISOString()} title={formatRelativeTime(entry.createdAt)}>
						{formatFullDateTime(entry.createdAt)}
					</time>
				</div>
				<div className="mt-1 line-clamp-2 text-xs leading-5 break-words text-foreground/90">{preview}</div>
			</div>
			<div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="size-6 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
					title={t("favorites.copy")}
					aria-label={t("favorites.copy")}
					onClick={(event) => {
						event.stopPropagation();
						props.onCopy(entry);
					}}
				>
					<Copy size={13} />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="size-6 rounded-sm text-muted-foreground hover:bg-muted hover:text-[var(--color-danger)]"
					title={t("favorites.delete")}
					aria-label={t("favorites.delete")}
					onClick={(event) => {
						event.stopPropagation();
						props.onRequestDelete(entry);
					}}
				>
					<Trash2 size={13} />
				</Button>
			</div>
		</article>
	);
}

/** 右侧详情栏：Markdown 渲染的完整正文 + 元信息（来源会话 / 收藏时间 / 模型 / 状态标记）+ 复制/删除。 */
function FavoriteDetail(props: { entry: FavoriteEntry; onClose: () => void; onCopy: (entry: FavoriteEntry) => void; onRequestDelete: (entry: FavoriteEntry) => void }) {
	const entry = props.entry;
	const isSelection = entry.kind === "selection";
	return (
		<aside className="flex w-[min(440px,52%)] min-w-[260px] shrink-0 flex-col border-l border-border/40 bg-bg-panel" aria-label={t("favorites.detailTitle")}>
			<div className="flex shrink-0 items-center gap-2 border-b border-border/40 px-3.5 py-2.5">
				<span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
					<Star className="size-3.5" aria-hidden="true" />
				</span>
				<span className="min-w-0 truncate text-xs font-semibold text-foreground">{t("favorites.detailTitle")}</span>
				<Button type="button" variant="ghost" size="icon-sm" className="ml-auto size-7 rounded-sm text-muted-foreground" title={t("common.close")} aria-label={t("common.close")} onClick={props.onClose}>
					<X size={14} />
				</Button>
			</div>
			<div className="flex shrink-0 flex-col gap-1.5 border-b border-border/40 px-3.5 py-3 text-micro text-muted-foreground">
				<div className="flex items-center gap-2">
					<span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/60 px-1.5 py-0.5">
						<TextQuote className="size-3" aria-hidden="true" />
						{isSelection ? t("favorites.kindSelection") : t("favorites.kindMessage")}
					</span>
					{entry.role && <span className="shrink-0">{roleLabel(entry.role)}</span>}
					{entry.partial && <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5">{t("favorites.partial")}</span>}
					{entry.truncated && <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5">{t("favorites.truncated")}</span>}
				</div>
				<DetailMetaRow label={t("favorites.detailSession")} value={entry.sessionTitle ?? t("favorites.sourceUnknown")} />
				<DetailMetaRow label={t("favorites.detailTime")} value={`${formatFullDateTime(entry.createdAt)}（${formatRelativeTime(entry.createdAt)}）`} title={new Date(entry.createdAt).toLocaleString()} />
				{entry.model && <DetailMetaRow label={t("favorites.detailModel")} value={entry.model} />}
			</div>
			{/* 整条消息按 Markdown 渲染（与时间线同一引擎/插件）；划选片段是纯文本，保持原样换行。 */}
			<div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
				{/* markdown-body 是排版容器（与时间线 AnswerOutput 同款）：标题/列表/代码块/表格的间距都靠它。 */}
				{isSelection ? (
					<div className="text-xs leading-6 break-words whitespace-pre-wrap text-foreground">{entry.text}</div>
				) : (
					<div className="markdown-body text-chat text-text-primary">
						<MarkdownStream text={entry.text} isStreaming={false} onOpenExternal={(url) => void openInSystemBrowser(url)} />
					</div>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-1.5 border-t border-border/40 px-3 py-2">
				<Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => props.onCopy(entry)}>
					<Copy size={14} />
					{t("favorites.copy")}
				</Button>
				<Button type="button" variant="ghost" size="sm" className="ml-auto h-7 gap-1.5 text-xs text-muted-foreground hover:text-[var(--color-danger)]" onClick={() => props.onRequestDelete(entry)}>
					<Trash2 size={14} />
					{t("favorites.delete")}
				</Button>
			</div>
		</aside>
	);
}

function DetailMetaRow(props: { label: string; value: string; title?: string }) {
	return (
		<div className="flex items-start gap-2">
			<span className="w-14 shrink-0 text-muted-foreground">{props.label}</span>
			<span className="min-w-0 break-words text-foreground/90" title={props.title}>
				{props.value}
			</span>
		</div>
	);
}
