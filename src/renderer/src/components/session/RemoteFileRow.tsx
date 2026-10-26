import { FileText, Folder, Link2, MoreHorizontal } from "lucide-react";
import type { RemoteWorkspaceEntry } from "../../../../shared/types/remoteHost";
import { t } from "../../i18n";
import { REMOTE_ENTRY_DRAG_TYPE, remoteDropRoute } from "../../utils/remoteEntryDrag";
import { Button } from "../ui-shadcn/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";

/**
 * 远端目录里的一行条目：打开 / 拖出去移动 / 收起放（落点）/ 行菜单（下载、重命名、删除）。
 *
 * 从 `RemoteProjectPanel` 抽出来的理由：这些 handler 让面板单文件越过 400 行目标，而它们只依赖
 * 「条目、当前目录、拖动状态」三样，与面板的导航/搜索/回收站无关。
 */
export function RemoteFileRow(props: {
	entry: RemoteWorkspaceEntry;
	/** 条目相对项目根的路径（拖拽与下载都用它）。 */
	path: string;
	busy: boolean;
	filesBusy: boolean;
	/** 当前高亮的落点（目录相对路径；`""` = 根）。 */
	dropTarget: string | null;
	onOpen: () => void;
	onDragStartEntry: (entry: { path: string; kind: "file" | "directory" }) => void;
	onDragEndEntry: () => void;
	onDropTargetChange: (target: string | null) => void;
	onDropInto: (targetDirectory: string) => void;
	onDownload: () => void;
	onRename: () => void;
	onDelete: () => void;
}) {
	const { entry, path, busy, filesBusy, dropTarget } = props;
	const isDirectoryTarget = entry.kind === "directory";
	// 判据与面板根节点同源：看 dataTransfer 里的内部标记，而不是只看 React 状态。
	// 用状态（`dragging`）判断会在「拖动源行被列表刷新卸载、dragend 丢失」时残留下来，
	// 之后从资源管理器拖文件经过目录行就会被误判成内部移动，触发一次意外写。
	const acceptsDrop = (event: { dataTransfer: DataTransfer }) => isDirectoryTarget && remoteDropRoute({ hasEntryMarker: event.dataTransfer.types.includes(REMOTE_ENTRY_DRAG_TYPE), hasFiles: event.dataTransfer.types.includes("Files") }) === "move";
	return (
		<li
			className={`flex shrink-0 items-center gap-1 rounded ${dropTarget === path ? "bg-muted/60 outline outline-1 -outline-offset-1 outline-primary/60" : ""}`}
			onDragOver={(event) => {
				// 只接受内部拖动：从资源管理器拖文件进来上传时这里不该拦截，否则 drop 会被吃掉。
				if (!acceptsDrop(event)) return;
				event.preventDefault();
				event.stopPropagation();
				// 不给 dropEffect 时 Chromium 对自定义类型显示「禁止」光标，看着像放不了。
				event.dataTransfer.dropEffect = "move";
				props.onDropTargetChange(path);
			}}
			onDragLeave={(event) => {
				// 只在真正离开这个可放置区域时清高亮：从其内部子节点移出也会触发 dragleave。
				if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
				if (dropTarget === path) props.onDropTargetChange(null);
			}}
			onDrop={(event) => {
				if (!acceptsDrop(event)) return;
				event.preventDefault();
				event.stopPropagation();
				props.onDropTargetChange(null);
				props.onDropInto(path);
			}}
		>
			<button
				type="button"
				className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left text-label hover:bg-muted/60"
				disabled={busy || entry.kind === "other"}
				draggable={entry.kind !== "other" && !busy}
				onDragStart={(event) => {
					if (entry.kind === "other") return;
					props.onDragStartEntry({ path, kind: entry.kind });
					event.dataTransfer.effectAllowed = "move";
					// 放一个标记：面板根的 drop 靠它区分「内部移动」与「从系统拖文件上传」。
					event.dataTransfer.setData(REMOTE_ENTRY_DRAG_TYPE, path);
				}}
				onDragEnd={props.onDragEndEntry}
				onClick={props.onOpen}
			>
				{isDirectoryTarget ? <Folder className="size-3.5 shrink-0" /> : entry.kind === "file" ? <FileText className="size-3.5 shrink-0" /> : <Link2 className="size-3.5 shrink-0" />}
				<span className="min-w-0 flex-1 truncate">{entry.name}</span>
				{entry.bytes !== undefined ? <span className="shrink-0 text-muted-foreground">{entry.bytes} B</span> : null}
				{/* 符号链接不跟随：helper 把它报为 other，这里如实禁用而不是假装能打开。 */}
				{entry.kind === "other" ? <span className="shrink-0 text-muted-foreground">{t("project.remote.linkNotFollowed")}</span> : null}
			</button>
			{entry.kind !== "other" ? (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button type="button" size="sm" variant="ghost" data-testid="remote-file-row-menu" aria-label={t("remoteFileEntry.renameTitle")} disabled={filesBusy || busy}>
							<MoreHorizontal className="size-4" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{entry.kind === "file" ? (
							<DropdownMenuItem data-testid="remote-file-row-download" onSelect={props.onDownload}>
								{t("remoteFileEntry.downloadAction")}
							</DropdownMenuItem>
						) : null}
						<DropdownMenuItem data-testid="remote-file-row-rename" onSelect={props.onRename}>
							{t("remoteFileEntry.renameAction")}
						</DropdownMenuItem>
						<DropdownMenuItem data-testid="remote-file-row-delete" variant="destructive" onSelect={props.onDelete}>
							{t("remoteFileEntry.deleteAction")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
		</li>
	);
}
