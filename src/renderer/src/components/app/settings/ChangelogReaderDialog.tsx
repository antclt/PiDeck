import type { ReactNode } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "../../ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { ScrollArea } from "../../ui-shadcn/scroll-area";
import { MarkdownStream } from "../../session/MarkdownStream";
import { formatI18nDateTime, t } from "../../../i18n";

/**
 * Changelog 阅读弹窗共享壳（Wave 2 §5.3）：PiDeck 更新日志与 pi CLI 发布说明
 * 此前各自维护一份同构 JSX——loading / unavailable / ready 三分支、ScrollArea
 * + markdown-body 渲染管线、来源/时间 footer。本组件收敛这部分结构：
 *
 * - 渲染安全边界不变：正文一律经 MarkdownStream sanitize 管线（外部数据），
 *   禁止 dangerouslySetInnerHTML；
 * - 降级语义不变：拉不到内容不打断用户，给「在浏览器查看」入口；
 * - max-width 写法必须保持 `sm:max-w-[min(760px,calc(100vw-48px))]`：
 *   Tailwind v4 按类名字母序产出规则，`min(...)`（m）才能压过 DialogContent
 *   基类的 `sm:max-w-lg`（详见 ChangelogDialog 历史注释）。
 *
 * 差异走 props：标题/副标题、footer 左侧诊断文本、ready 态的正文槽与展开控制。
 */
export type ChangelogShellState =
	| { status: "loading" }
	| { status: "unavailable"; pageUrl: string }
	| { status: "ready"; markdown: string; source?: string | null; fetchedAt?: string | null; pageUrl: string };

export function ChangelogReaderDialog(props: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	subtitle: string;
	state: ChangelogShellState;
	onReload: () => void;
	onOpenExternal: (url: string) => void;
	/** ready 态正文上方/下方的领域内容（版本展开控制等）。 */
	aboveBody?: ReactNode;
	belowBody?: ReactNode;
	/** footer 左侧附加诊断（stale/truncated 提示）。 */
	footerExtra?: ReactNode;
	/** 打开时豁免外层浮层外点关闭（ChangelogDialog「关于」入口场景）。 */
	dismissExemptOnOutside?: boolean;
}) {
	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent
				className="flex max-h-[80vh] flex-col overflow-hidden sm:max-w-[min(760px,calc(100vw-48px))]"
				dismissExemptOnOutside={props.dismissExemptOnOutside}
			>
				<DialogHeader>
					<DialogTitle>{props.title}</DialogTitle>
					<DialogDescription>{props.subtitle}</DialogDescription>
				</DialogHeader>

				{props.state.status === "loading" && <p className="py-8 text-center text-caption text-muted-foreground">{t("changelog.loading")}</p>}

				{props.state.status === "unavailable" && (
					<div className="flex flex-col items-center gap-3 py-8">
						<p className="text-caption text-muted-foreground">{t("changelog.unavailable")}</p>
						<Button variant="secondary" size="sm" onClick={() => props.onOpenExternal(props.state.status === "unavailable" ? props.state.pageUrl : "")}>
							<ExternalLink size={12} aria-hidden="true" />
							{t("changelog.openInBrowser")}
						</Button>
					</div>
				)}

				{props.state.status === "ready" && (
					<>
						{props.aboveBody}
						{/* 固定高度 + 内部滚动；外层必须挂 markdown-body（长内容压缩与 sanitize 样式依赖它，
						    与会话正文同一约定），否则长段落横向撑破弹窗。 */}
						<ScrollArea className="h-[52vh] rounded-md border border-border-subtle">
							<div className="markdown-body px-4 py-3 text-chat text-text-primary">
								<MarkdownStream text={props.state.markdown} isStreaming={false} light onOpenExternal={(url) => props.onOpenExternal(url)} />
							</div>
						</ScrollArea>
						{props.belowBody}
						<div className="flex items-center justify-between gap-2">
							<span className="text-caption text-muted-foreground/70">
								{t("changelog.sourceLabel", { source: props.state.source ?? "—" })}
								{props.state.fetchedAt ? ` · ${t("changelog.updatedAt", { time: formatI18nDateTime(props.state.fetchedAt) })}` : ""}
							</span>
							<div className="flex items-center gap-2">
								{props.footerExtra}
								<Button variant="ghost" size="sm" onClick={props.onReload}>
									<RefreshCw size={12} aria-hidden="true" />
									{t("changelog.reload")}
								</Button>
								<Button variant="ghost" size="sm" onClick={() => props.onOpenExternal(props.state.status === "ready" ? props.state.pageUrl : "")}>
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
