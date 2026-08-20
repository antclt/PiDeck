import { memo, useCallback, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, Files } from "lucide-react";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { FileDiff } from "../../agents/file-diff";
import { collectRunFileChanges, fileChangeToDiffLines } from "../TimelineFormat";
import type { AgentRunItem } from "../timeline/types";
import type { DiffFileHandler } from "../ToolCallComponents";
import {
	fileChangesPrefKey,
	MAX_VISIBLE_FILES,
	readFileChangesPref,
	visibleFileCount,
	writeFileChangesPref,
	type TurnFileChangesPref,
} from "./fileChangesUiState";

/**
 * 一轮 agent-run 底部固定的「本轮文件修改」列表：
 * - 数据来自 run.items 内的 write/edit/create/patch 工具调用，run 完成后不再变化
 *   （TurnRow 的 memo 深度比较保证历史 run 不重渲染，因此该列表固定显示、不会被后续消息清除）；
 * - 每行一个 beUI FileDiff：点击行展开内联语法高亮 diff，complete 后自动收起（单文件行交互，保留）；
 * - 行尾按钮在右侧差异查看器中打开（复用工具卡片 diff 链路）；
 * - 标题行右侧的折叠按钮控制整个列表收起/展开，折叠/展开全部偏好按 run 跨卸载记忆
 *   （时间线按 turn 挂载窗口裁剪会卸载 TurnRow，见 fileChangesUiState.ts）；
 * - 默认最多平铺 3 行，超出时行尾出现「展开全部」按钮手动放开（避免一轮十几个文件占满一屏）。
 */
export const TurnFileChanges = memo(function TurnFileChanges(props: {
	run: AgentRunItem;
	/** 流式中：FileDiff 呈现 streaming 态（转圈 + 跟随滚动），完成后自动收起 */
	streaming?: boolean;
	onDiffFile?: DiffFileHandler;
}) {
	const files = useMemo(() => collectRunFileChanges(props.run), [props.run]);
	const prefKey = useMemo(() => fileChangesPrefKey(props.run), [props.run]);
	// 初始偏好从模块级 store 读取（卸载重挂载后恢复），默认展开 + 3 行截断
	const [pref, setPref] = useState<TurnFileChangesPref>(() => {
		const stored = readFileChangesPref(prefKey);
		return stored ?? { collapsed: false, showAll: false };
	});
	/** 更新偏好并回写 store（卸载后按同一 key 找回）。 */
	const updatePref = useCallback((patch: Partial<TurnFileChangesPref>) => {
		setPref((prev) => {
			const next = { ...prev, ...patch };
			writeFileChangesPref(prefKey, next);
			return next;
		});
	}, [prefKey]);
	// 未展开全部时只展示前 3 行（行尾留「展开全部」按钮）；展开后展示全部
	const visibleFiles = files.slice(0, visibleFileCount(files.length, pref.showAll));
	if (files.length === 0) return null;
	return (
		<div className="turn-file-changes w-full min-w-0 [contain:layout_paint]">
			<div className="mb-1.5 flex items-center gap-1.5 text-micro font-medium uppercase tracking-wider text-muted-foreground/60">
				<Files size={12} aria-hidden="true" className="shrink-0" />
				<span>{t("session.turnFileChangesTitle")}</span>
				{/* 折叠/展开按钮：始终显示（有文件即可折叠），点击整体收起/展开列表；
				    收起时按钮仍可见，保证可随时恢复展开 */}
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="size-5 shrink-0 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
					title={pref.collapsed ? t("common.expand") : t("common.collapse")}
					aria-label={pref.collapsed ? t("common.expand") : t("common.collapse")}
					onClick={() => updatePref({ collapsed: !pref.collapsed })}
				>
					{pref.collapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
				</Button>
			</div>
			{!pref.collapsed && (
				<div className="flex max-h-[320px] flex-col gap-0.5 overflow-y-auto overscroll-contain">
					{visibleFiles.map((entry) => (
						<div key={entry.path} className="flex items-center gap-1">
							<FileDiff
								className="min-w-0 flex-1"
								// 同文件多次修改时在路径后附次数（truncate 由 FileDiff 内部处理）
								file={`${entry.path}${entry.count > 1 ? ` ×${entry.count}` : ""}`}
								lines={fileChangeToDiffLines(entry)}
								status={props.streaming ? "streaming" : "complete"}
								defaultOpen={false}
								maxHeight={200}
								language="diff"
							/>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="size-7 shrink-0 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
								title={t("session.openInDiffViewer", { path: entry.path })}
								onClick={() =>
									props.onDiffFile?.(
										entry.path,
										entry.originalContent,
										entry.content,
									)
								}
							>
								<ExternalLink size={13} />
							</Button>
						</div>
					))}
					{files.length > MAX_VISIBLE_FILES && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="mt-0.5 h-6 self-start gap-1 px-1.5 text-micro text-muted-foreground hover:bg-muted hover:text-foreground"
							onClick={() => updatePref({ showAll: !pref.showAll })}
						>
							{pref.showAll
								? t("session.turnFileChangesShowLess")
								: t("session.turnFileChangesShowAll", { count: files.length })}
						</Button>
					)}
				</div>
			)}
		</div>
	);
});
