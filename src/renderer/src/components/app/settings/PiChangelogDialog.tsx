import { useCallback, useEffect, useState } from "react";
import type { PiReleaseNotesPayload } from "../../../../../shared/types";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { ChangelogReaderDialog, type ChangelogShellState } from "./ChangelogReaderDialog";

type LoadState = { status: "loading" } | { status: "ready"; payload: PiReleaseNotesPayload & { markdown: string } } | { status: "unavailable"; pageUrl: string };

/**
 * pi CLI「更新详情」弹窗：展示 (current, latest] 区间的官方 CHANGELOG 条目。
 *
 * 渲染与降级策略收敛在 ChangelogReaderDialog（Wave 2 §5.3），与 PiDeck 自身
 * 更新日志（ChangelogDialog）同一壳：
 * - 正文是外部数据（jsDelivr/unpkg/GitHub raw），一律经 MarkdownStream sanitize 管线，
 *   禁止 dangerouslySetInnerHTML；
 * - 主进程所有源都失败时 markdown=null，降级为「在浏览器查看」，不打断用户；
 * - 打开时才拉取（主进程按 latestVersion 内存缓存），关闭即复位。
 */
export function PiChangelogDialog(props: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** 当前安装版本（缺失时主进程取最新若干条兜底）。 */
	currentVersion?: string;
	/** 目标版本：钉版拉取该版本的 CHANGELOG。 */
	latestVersion: string;
}) {
	const [state, setState] = useState<LoadState>({ status: "loading" });

	const load = useCallback(async () => {
		setState({ status: "loading" });
		try {
			const payload = await desktopApi.pi.releaseNotes({ latestVersion: props.latestVersion, currentVersion: props.currentVersion });
			if (payload.markdown) {
				setState({ status: "ready", payload: { ...payload, markdown: payload.markdown } });
				return;
			}
			setState({ status: "unavailable", pageUrl: payload.pageUrl });
		} catch {
			// IPC 本身异常（主进程已尽力）：同样降级而不是抛给用户。
			setState({ status: "unavailable", pageUrl: DEFAULT_PAGE_URL });
		}
	}, [props.currentVersion, props.latestVersion]);

	// 打开时才拉取，关闭即复位：保证下次打开是新鲜内容，也避免每次渲染都打网络。
	useEffect(() => {
		if (!props.open) return;
		void load();
	}, [props.open, load]);

	const openInBrowser = useCallback((url: string) => {
		void desktopApi.app.openExternal(url, true).catch(() => undefined);
	}, []);

	const shellState: ChangelogShellState =
		state.status === "ready"
			? {
					status: "ready",
					markdown: state.payload.markdown,
					source: state.payload.source,
					fetchedAt: state.payload.fetchedAt,
					pageUrl: state.payload.pageUrl,
				}
			: state;

	return (
		<ChangelogReaderDialog
			open={props.open}
			onOpenChange={props.onOpenChange}
			title={t("piChangelog.title")}
			subtitle={state.status === "ready" ? t("piChangelog.subtitleVersions", { current: props.currentVersion ?? "?", latest: props.latestVersion, count: state.payload.versionCount }) : t("piChangelog.subtitle", { current: props.currentVersion ?? "?", latest: props.latestVersion })}
			state={shellState}
			onReload={() => void load()}
			onOpenExternal={openInBrowser}
			// 截断提示（超出条数上限时主进程已裁剪）：footer 右侧操作区左侧。
			footerExtra={state.status === "ready" && state.payload.truncated ? <span className="text-caption text-muted-foreground">{t("piChangelog.truncated")}</span> : null}
		/>
	);
}

/** IPC 彻底失败时的兜底地址；与主进程 PiChangelogService 的 pageUrl 同源。 */
const DEFAULT_PAGE_URL = "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md";
