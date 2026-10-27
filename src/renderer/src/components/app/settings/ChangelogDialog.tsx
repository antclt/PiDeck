import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, RefreshCw } from "lucide-react";
import type { ChangelogPayload } from "../../../../../shared/types";
import { desktopApi } from "../../../desktopApi";
import { formatI18nDateTime, t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { ScrollArea } from "../../ui-shadcn/scroll-area";
import { MarkdownStream } from "../../session/MarkdownStream";
import { splitChangelogVersions } from "./changelogSections";

type LoadState = { status: "loading" } | { status: "ready"; payload: ChangelogPayload & { markdown: string } } | { status: "unavailable"; pageUrl: string };

/**
 * 更新日志弹窗。
 *
 * 「关于」弹框与设置页更新卡片两处共用同一个组件与同一条 IPC —— 不做两份实现，
 * 否则两处的降级行为/渲染管线迟早分叉。
 *
 * ## 渲染安全边界
 *
 * CHANGELOG 是**外部数据**（来自 atomgit/GitHub raw，且主进程已确认不是 HTML 壳）。
 * 正文一律经 MarkdownStream 渲染，与会话消息、公告详情同一套 streamdown sanitize
 * 管线；禁止绕过它直接塞 dangerouslySetInnerHTML。
 *
 * ## 降级策略
 *
 * 主进程拉取失败（所有源都挂 / 内容校验不通过）时返回 markdown=null。此时不报错、
 * 不阻塞，直接展示「打开浏览器查看」入口——拿不到更新日志不该打断用户。
 *
 * ## 默认只渲染最新一个版本
 *
 * 整本 CHANGELOG 实测 164K 字符 / 57 个版本，而首个版本段只占 0.9%（约 1.4K 字符）。
 * 一次性把全文交给 MarkdownStream 时，即使走 light（关掉高亮/mermaid/数学），
 * marked 解析 + sanitize + 一次 commit 出数万节点的成本仍与长度线性相关，
 * 打开弹窗那一瞬明显卡顿。因此默认只渲染首个 `## ` 版本段（切分见
 * changelogSections.ts），并给「查看全部 {count} 个版本」才渲染全文；
 * 展开后由 MarkdownStream 的 settled 渐进分块兜底（light 场景同样生效，
 * 见 MarkdownStream settledChunks），不会一次 commit 冻结。
 *
 * 「展开」态在每次重新打开时复位：否则上次展开过全文的用户，下次打开又要卡一次。
 *
 * ## 与外层 MorphPopover 的关系（「关于」入口）
 *
 * 「关于」面板内的「更新日志」入口打开本弹窗时会同时收起面板（AboutPopover 受控
 * MorphPopover），二者不同时存活，因此该入口不再需要 dismissExemptOnOutside。
 * 本 prop 仍保留：仅当入口本身位于另一个自带外点关闭、且保持打开的浮层内部时开启。
 */
export function ChangelogDialog(props: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * 打开时豁免外层浮层（如 MorphPopover）的外部点击关闭。
	 * 仅在入口本身位于另一个自带外点关闭的浮层内部时需要开启，见文件头注释。
	 */
	dismissExemptOnOutside?: boolean;
}) {
	const [state, setState] = useState<LoadState>({ status: "loading" });
	// 默认只渲染最新一个版本：整本 CHANGELOG 实测 164K 字符一次进渲染管线会卡顿，
	// 用户通常只关心刚发的版本；「查看全部版本」才付全量渲染成本。
	const [showAllVersions, setShowAllVersions] = useState(false);

	// ready 时按版本切分一次（164K 字符逐行扫描毫秒级）；loading/unavailable 无需切分。
	const split = useMemo(() => {
		if (state.status !== "ready") return null;
		return splitChangelogVersions(state.payload.markdown);
	}, [state]);

	// forceRefresh=false：主进程 TTL 内直接回本地缓存（零网络秒开）；
	// true：「刷新」按钮语义，跳过缓存强制拉最新，成功覆盖本地缓存。
	const load = useCallback(async (forceRefresh = false) => {
		setState({ status: "loading" });
		try {
			const payload = await desktopApi.app.getChangelog(undefined, forceRefresh);
			if (payload.markdown) {
				setState({
					status: "ready",
					payload: { ...payload, markdown: payload.markdown },
				});
				return;
			}
			setState({ status: "unavailable", pageUrl: payload.pageUrl });
		} catch {
			// IPC 本身异常（主进程已尽力，走到这里属意外）：同样降级而不是抛给用户。
			setState({
				status: "unavailable",
				pageUrl: DEFAULT_PAGE_URL,
			});
		}
	}, []);

	// 打开时才拉取，关闭即复位：避免每次渲染都打网络，也保证下次打开是新鲜内容。
	// 展开态一并复位：下次打开回到「只看最新版本」。
	useEffect(() => {
		if (!props.open) return;
		setShowAllVersions(false);
		void load();
	}, [props.open, load]);

	const openInBrowser = useCallback((url: string) => {
		void desktopApi.app.openExternal(url, true).catch(() => undefined);
	}, []);

	// 三个渲染分支（全文 / 导语 / 最新版本段）共用的 MarkdownStream 参数。
	const changelogStreamProps = {
		isStreaming: false,
		light: true,
		onOpenExternal: (url: string) => openInBrowser(url),
	} as const;

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent
				/* DialogContent 基础类自带 `sm:max-w-lg`。Tailwind v4 按**类名字母序**产出
				   规则，`[760px]`（`[`）排在 `lg`（`l`）之前 → 基础类的 max-width 反而胜出，
				   弹窗在 ≥640px 视口下被压回 512px。所以这里必须写成字母序在 `lg` 之后的
				   形式（`min(...)`，`m` > `l`），与 SettingsModal / ConfigModal 的既有做法同源：
				   只写 `sm:max-w-[760px]` 是无效的（实测产物中该规则排在 lg 之前）。
				   上限同时兜住窄视口，不会把弹窗顶出屏幕。 */
				className="flex max-h-[80vh] flex-col overflow-hidden sm:max-w-[min(760px,calc(100vw-48px))]"
				dismissExemptOnOutside={props.dismissExemptOnOutside}
			>
				<DialogHeader>
					<DialogTitle>{t("changelog.title")}</DialogTitle>
					<DialogDescription>{state.status === "ready" ? t("changelog.subtitleVersions", { count: state.payload.versionCount }) : t("changelog.subtitle")}</DialogDescription>
				</DialogHeader>

				{state.status === "loading" && <p className="py-8 text-center text-caption text-muted-foreground">{t("changelog.loading")}</p>}

				{state.status === "unavailable" && (
					<div className="flex flex-col items-center gap-3 py-8">
						<p className="text-caption text-muted-foreground">{t("changelog.unavailable")}</p>
						<Button variant="secondary" size="sm" onClick={() => openInBrowser(state.pageUrl)}>
							<ExternalLink size={12} aria-hidden="true" />
							{t("changelog.openInBrowser")}
						</Button>
					</div>
				)}

				{state.status === "ready" && split && (
					<>
						{/* 固定高度 + 内部滚动：默认只渲染最新一个版本（首个 `## ` 段），
						    「查看全部版本」展开才渲染全文——全文 164K 字符单次进渲染管线会卡顿，
						    且大多数时候用户只关心刚发的版本。展开后的全文由 MarkdownStream 内部
						    的 settled 渐进分块兜底（light 场景同样生效），不会一次 commit 冻结。
						    MarkdownStream 传 light：更新日志是静态只读场景，关掉代码高亮/
						    mermaid/数学等重插件（组件内注释亦为此场景预留了该开关）。

						    外层必须显式挂 `markdown-body`：MarkdownStream 自身不挂这个类
						    （会话里由 AssistantText 挂），而正文的「压缩宽内容」全靠
						    .markdown-body 的 overflow-x: clip + 子元素 min-width:0
						    （见 styles/timeline.css）。不挂的话长段落会被判成不可断行的
						    单行文本，横向撑破弹窗——既不出换行也不出滚动条。 */}
						<ScrollArea className="h-[52vh] rounded-md border border-border-subtle">
							<div className="markdown-body px-4 py-3 text-chat text-text-primary">
								{showAllVersions || split.sections.length <= 1 ? (
									<MarkdownStream {...changelogStreamProps} text={state.payload.markdown} />
								) : (
									<>
										{split.intro !== "" && <MarkdownStream {...changelogStreamProps} text={split.intro} />}
										<MarkdownStream {...changelogStreamProps} text={split.sections[0]} />
									</>
								)}
							</div>
						</ScrollArea>
						{/* 展开/收起固定在滚动区外（不随内容滚走）：全文展开后收起不用滚到几百屏之外。 */}
						{split.sections.length > 1 && (
							<div className="flex justify-center">
								<Button variant="ghost" size="sm" onClick={() => setShowAllVersions((value) => !value)}>
									{showAllVersions ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
									{showAllVersions
										? t("changelog.showLatestOnly")
										: t("changelog.showAllVersions", {
												count: split.sections.length,
											})}
								</Button>
							</div>
						)}
						<div className="flex items-center justify-between gap-2">
							{/* 诊断信息：内容来源 + 抓取时间（TTL 内秒开的本地缓存也能看出来源与新旧）；
							    stale（网络失败退回旧缓存）时额外提示可刷新取最新。 */}
							<span className="text-caption text-muted-foreground/70">
								{t("changelog.sourceLabel", {
									source: state.payload.source === "github" ? "GitHub" : state.payload.source === "atomgit" ? "AtomGit" : "—",
								})}
								{state.payload.fetchedAt
									? ` · ${t("changelog.updatedAt", {
											time: formatI18nDateTime(state.payload.fetchedAt),
										})}`
									: ""}
							</span>
							<div className="flex gap-2">
								{state.payload.stale && <span className="self-center text-caption text-muted-foreground">{t("changelog.staleNotice")}</span>}
								<Button variant="ghost" size="sm" onClick={() => void load(true)}>
									<RefreshCw size={12} aria-hidden="true" />
									{t("changelog.reload")}
								</Button>
								<Button variant="ghost" size="sm" onClick={() => openInBrowser(state.payload.pageUrl)}>
									<ExternalLink size={12} aria-hidden="true" />
									{t("changelog.openInBrowser")}
								</Button>
							</div>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

/**
 * IPC 彻底失败时的兜底地址。
 * 与主进程 ChangelogService.changelogPageUrl 同源（同样指向 AtomGit blob 页）；
 * 主进程返回的 pageUrl 始终可用，此常量只用于 IPC 本身抛错的极端场景。
 */
const DEFAULT_PAGE_URL = "https://atomgit.com/ayuayue/PiDeck/blob/main/CHANGELOG.zh-CN.md";
