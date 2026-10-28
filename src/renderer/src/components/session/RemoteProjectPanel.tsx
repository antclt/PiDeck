import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, FilePlus2, FileText, Folder, FolderPlus, Link2, Loader2, Plus, RefreshCw, Search, TerminalSquare, Trash2, Upload } from "lucide-react";
import type { FileTreeNode } from "../../../../shared/types";
import type { RemoteEntryKind } from "../../../../shared/types/remoteFiles";
import { desktopApi } from "../../desktopApi";
import { useRemoteProjectEntries } from "../../hooks/useRemoteProjectEntries";
import { useRemoteProjectSearch, REMOTE_SEARCH_UNWIRED_CODE } from "../../hooks/useRemoteProjectSearch";
import { useRemoteProjectTransfer } from "../../hooks/useRemoteProjectTransfer";
import { moveDestination, remoteDropOnBlankArea, remoteDropRoute, REMOTE_ENTRY_DRAG_TYPE } from "../../utils/remoteEntryDrag";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { isRemoteHostNotConnectedCode as isNotConnectedCode } from "./remoteProjectEntries";
import { createRequestGate } from "./remoteRequestGate";
import { RemoteFileEditor } from "../workspace/RemoteFileEditor";
import { RemoteProjectEntryDialogs, type RemoteEntryDialog } from "./RemoteProjectEntryDialogs";
import { RemoteTrashPanel } from "./RemoteTrashPanel";
import { remoteFileEntryKeepsInput } from "./remoteFileManagementState";
import { FileTreeNodeRow } from "./FileTreeRows";
import { useRemoteFileTree } from "../../hooks/useRemoteFileTree";
import { fileTreeNodeKey } from "../../utils/fileTreeLazy";
import type { RemoteSearchEntryView } from "./remoteProjectSearchState";
import { RemoteProjectSearchBar } from "./RemoteProjectSearchBar";

/**
 * 远端项目目录浏览 + 文件名搜索 + 文本编辑 + 文件管理（Phase 5 文件面）。
 *
 * 与设置页的「远端工作区」不同：这个视图的根来自 ProjectStore 中该项目持有的 canonical remotePath，
 * 因此跨重启恢复；渲染层只给 projectId 与相对路径，主进程解析 host/root 并串行切换会话。
 *
 * 文件管理（新建/重命名/移动/删除/回收站）只在远端项目面板出现：命令与状态机在
 * useRemoteProjectEntries，弹框、行菜单、回收站与 testid 在 §10.2 冻结。失败与空目录分开呈现，
 * 未知结果消息保留到用户显式刷新；本机 FileTree/右键菜单不受影响。
 */
export function RemoteProjectPanel(props: { projectId: string; projectName: string; onOpenTerminal?: () => void; onCreateSession?: () => void; onBack?: () => void }) {
	const tree = useRemoteFileTree(props.projectId);
	const [file, setFile] = useState<{ projectId: string; path: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	const [entryDialog, setEntryDialog] = useState<RemoteEntryDialog | null>(null);
	const [trashOpen, setTrashOpen] = useState(false);
	/** 行右键菜单：与本地文件树同一种交互（不再给每一行常驻一个「…」按钮）。 */
	const [rowMenu, setRowMenu] = useState<{ node: FileTreeNode; x: number; y: number } | null>(null);
	/** 内部拖动悬停的目录（只做视觉反馈；落点判定仍由行组件读 dataTransfer）。 */
	const [dragOverDir, setDragOverDir] = useState<string | null>(null);
	const [trashReloadToken, setTrashReloadToken] = useState(0);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	/** 请求代次闸门；组件卸载时作废所有在途结果。 */
	const gateRef = useRef(createRequestGate());
	/** 搜索状态机（自带代次闸门）；切项目由 hook 负责作废旧结果。 */
	const { state: search, run: runSearch, reset: resetSearch } = useRemoteProjectSearch(desktopApi, props.projectId);

	useEffect(
		() => () => {
			gateRef.current.invalidate();
		},
		[],
	);

	const searching = search.phase !== "idle";
	const busy = tree.loadingDirs.size > 0;

	// 传输关注点（上传 / 拖放 / 下载）整块在 hook 里，面板只保留接线：这个文件已经同时管导航、
	// 搜索、写操作弹框与回收站，再塞传输就越过「单文件 ≤400 行」的目标。
	const transfer = useRemoteProjectTransfer({ projectId: props.projectId, directory: tree.currentDir, reload: () => tree.refresh(), setError, searching });

	const files = useRemoteProjectEntries({ projectId: props.projectId, reload: () => tree.refresh() });

	// 切换项目：树由 hook 自行重置，这里只清掉面板自己的临时状态。
	useEffect(() => {
		setFile(null);
		setError(null);
		setEntryDialog(null);
		setTrashOpen(false);
		setRowMenu(null);
	}, [props.projectId]);

	/** 搜索失败文案：未接线 / 主机未连接 / 稳定码三种，分别给出用户能行动的说法。 */
	const searchFailedText = (code: string | null): string => {
		if (code === null) return t("project.remote.requestFailed");
		if (code === REMOTE_SEARCH_UNWIRED_CODE) return t("project.remote.searchUnwired");
		return isNotConnectedCode(code) ? t("project.remote.notConnectedHint") : t("project.remote.searchFailed", { code });
	};

	/** 点开一条搜索结果：远端 path 本来就是相对项目根的，直接拆段导航；搜索态随之清空。 */
	const openResult = useCallback(
		(entry: RemoteSearchEntryView) => {
			resetSearch();
			setQuery("");
			if (entry.kind === "directory") {
				// 目录结果：在树里展开到它（含全部祖先），而不是切到一个只显示这一层的列表。
				void tree.reveal(entry.path);
				return;
			}
			gateRef.current.invalidate();
			setError(null);
			setFile({ projectId: props.projectId, path: entry.path });
		},
		[props.projectId, resetSearch, tree],
	);

	const bumpTrash = useCallback(() => setTrashReloadToken((value) => value + 1), []);
	/**
	 * 写操作失败时按稳定码决定弹框去留（§10.3）：目标已存在/条目已变化/名字非法保留输入便于重试，
	 * 其余（受保护路径、未知结果、权限/连接）关闭弹框，避免用户对着不可能成功的输入反复提交。
	 */
	const closeDialogAfter = useCallback((result: { ok: true } | { ok: false; code: string }, afterSuccess?: () => void) => {
		if (result.ok) {
			setEntryDialog(null);
			afterSuccess?.();
		} else if (!remoteFileEntryKeepsInput(result.code)) setEntryDialog(null);
	}, []);

	const submitNew = useCallback(
		(entryKind: RemoteEntryKind, parent: string, name: string) => {
			void files.createEntry(parent, entryKind, name).then((result) => closeDialogAfter(result));
		},
		[files, closeDialogAfter],
	);
	const submitRename = useCallback(
		(source: string, target: string) => {
			void files.renameEntry(source, target).then((result) => closeDialogAfter(result, bumpTrash));
		},
		[files, closeDialogAfter, bumpTrash],
	);
	const submitDelete = useCallback(
		(path: string) => {
			void files.deleteEntry(path).then((result) => closeDialogAfter(result, bumpTrash));
		},
		[files, closeDialogAfter, bumpTrash],
	);
	const submitPrune = useCallback(
		(ids: string[]) => {
			void files.pruneTrash(ids).then((result) => closeDialogAfter(result, bumpTrash));
		},
		[files, closeDialogAfter, bumpTrash],
	);
	const restoreTrash = useCallback(
		(trashId: string) => {
			void files.restoreTrash(trashId).then((result) => closeDialogAfter(result, bumpTrash));
		},
		[files, closeDialogAfter, bumpTrash],
	);

	/**
	 * 把拖动的条目移动到目标目录。
	 *
	 * 复用 rename（服务端本来就是同目录树内的 rename）：不新增 IPC，也不放宽版本令牌与边界校验。
	 * 拖到自己身上/自己的子目录由服务端 `assertRemoteProjectEntryMove` 拒绝，这里只拦「拖到同一目录」。
	 */
	const moveInto = useCallback(
		(sourcePath: string, targetDirectory: string) => {
			const destination = moveDestination(sourcePath, targetDirectory);
			if (destination === null) return;
			void files.renameEntry(sourcePath, destination).then((result) => {
				if (result.ok) void tree.refresh();
			});
		},
		[files, tree],
	);

	const openRowDialog = (node: FileTreeNode, kind: "rename" | "delete"): void => {
		const path = node.relativePath;
		setEntryDialog(kind === "rename" ? { kind: "rename", source: path } : { kind: "delete", path, entryKind: node.type });
	};

	const dialogErrorText = files.outcome?.kind === "failed" && remoteFileEntryKeepsInput(files.outcome.code) ? files.outcome.text : null;
	const trashOutcomeText = files.outcome !== null && (files.outcome.operation === "restore" || files.outcome.operation === "prune") ? files.outcome : null;
	const fileOutcomeText = files.outcome !== null && files.outcome.operation !== "restore" && files.outcome.operation !== "prune" ? files.outcome.text : "";

	return (
		<div
			ref={scrollRef}
			className={`files-panel flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 py-3 ${transfer.dragActive ? "outline outline-2 -outline-offset-2 outline-primary/60" : ""}`}
			data-testid="remote-project-drop"
			onDragOver={(event) => {
				// 内部拖动也接受 drop（不 preventDefault 就不会派发 drop）：落在空白处 = 当前目录，
				// 条目本来就在这里，因此是个 no-op。这样「拖到空白」不会显示禁止光标，也不会被误当上传。
				const route = remoteDropRoute({ hasFiles: event.dataTransfer.types.includes("Files"), hasEntryMarker: event.dataTransfer.types.includes(REMOTE_ENTRY_DRAG_TYPE) });
				if (route === "move") {
					event.preventDefault();
					event.dataTransfer.dropEffect = "move";
					return;
				}
				transfer.onDragOver(event);
			}}
			onDragLeave={transfer.onDragLeave}
			onDrop={(event) => {
				// 两条路径由纯函数判定（`remoteEntryDrag.ts`）：内部拖动落在空白处既不是移动也不算上传；
				// 只有从系统拖进来的文件会走上传。
				const route = remoteDropRoute({ hasFiles: event.dataTransfer.types.includes("Files"), hasEntryMarker: event.dataTransfer.types.includes(REMOTE_ENTRY_DRAG_TYPE) });
				if (remoteDropOnBlankArea(route)) {
					event.preventDefault();
					return;
				}
				transfer.onDrop(event);
			}}
		>
			{/* 工具行与本地文件面板同密度：图标按钮贴右，返回/新建会话/终端保留为图标动作，不额外做一条「远端项目」标题栏。 */}
			<div data-testid="remote-file-toolbar" className="flex h-8 shrink-0 items-center gap-1 border-b border-border/40 px-2">
				{props.onBack ? (
					<Button variant="ghost" size="icon-sm" data-testid="remote-project-back" aria-label={t("project.remote.back")} title={t("project.remote.back")} onClick={props.onBack}>
						<ArrowLeft className="size-4" aria-hidden="true" />
					</Button>
				) : null}
				{props.onCreateSession ? (
					<Button variant="ghost" size="icon-sm" data-testid="remote-project-new-session" aria-label={t("project.remote.newSession")} title={t("project.remote.newSession")} onClick={props.onCreateSession}>
						<Plus className="size-4" aria-hidden="true" />
					</Button>
				) : null}
				{props.onOpenTerminal ? (
					<Button variant="ghost" size="icon-sm" aria-label={t("app.terminal")} title={t("app.terminal")} onClick={props.onOpenTerminal}>
						<TerminalSquare className="size-4" aria-hidden="true" />
					</Button>
				) : null}
				<span className="min-w-0 flex-1 truncate px-1 text-label text-muted-foreground">{props.projectName}</span>
				{!searching && !searchOpen ? (
					<>
						<Button type="button" size="icon-sm" variant="ghost" data-testid="remote-file-create" aria-label={t("remoteFileEntry.newFile")} title={t("remoteFileEntry.newFile")} disabled={files.busy || busy} onClick={() => setEntryDialog({ kind: "new", entryKind: "file", parent: tree.currentDir })}>
							<FilePlus2 className="size-4" />
						</Button>
						<Button type="button" size="icon-sm" variant="ghost" data-testid="remote-file-mkdir" aria-label={t("remoteFileEntry.newFolder")} title={t("remoteFileEntry.newFolder")} disabled={files.busy || busy} onClick={() => setEntryDialog({ kind: "new", entryKind: "directory", parent: tree.currentDir })}>
							<FolderPlus className="size-4" />
						</Button>
						<Button type="button" size="icon-sm" variant="ghost" data-testid="remote-file-upload" aria-label={t("remoteFileEntry.uploadAction")} title={t("remoteFileEntry.uploadAction")} disabled={files.busy || busy} onClick={transfer.uploadFiles}>
							<Upload className="size-4" />
						</Button>
						<Button
							type="button"
							size="icon-sm"
							variant="ghost"
							aria-label={t("project.remote.searchPlaceholder")}
							title={t("project.remote.searchPlaceholder")}
							aria-pressed={searchOpen}
							disabled={busy}
							onClick={() => {
								setSearchOpen((open) => {
									if (open) {
										resetSearch();
										setQuery("");
									}
									return !open;
								});
							}}
						>
							<Search className="size-4" />
						</Button>
						<Button type="button" size="icon-sm" variant="ghost" data-testid="remote-trash-toggle" aria-label={t("remoteTrash.title")} title={t("remoteTrash.title")} aria-expanded={trashOpen} disabled={files.busy} onClick={() => setTrashOpen((open) => !open)}>
							<Trash2 className="size-4" />
						</Button>
						<Button type="button" size="icon-sm" variant="ghost" aria-label={t("common.refresh")} title={t("common.refresh")} disabled={busy} onClick={() => void tree.refresh()}>
							<RefreshCw className="size-4" />
						</Button>
					</>
				) : null}
			</div>
			{searchOpen ? (
				<RemoteProjectSearchBar
					query={query}
					busy={busy}
					onQueryChange={setQuery}
					onSubmit={() => void runSearch(query)}
					onClose={() => {
						resetSearch();
						setQuery("");
						setSearchOpen(false);
					}}
				/>
			) : null}
			{/* 写操作结果/未知提示：固定单行高度，避免布局抖动；读失败只影响目录列表，不覆盖这条回执。 */}
			<p data-testid="remote-file-outcome" aria-live="polite" className="h-5 truncate text-label text-muted-foreground">
				{fileOutcomeText}
			</p>
			{/* 失败提示独立于空目录提示：列出失败时绝不显示「这个目录是空的」；搜索态下由搜索自己报告错误。 */}
			{error !== null && !searching ? <p className="text-label text-muted-foreground">{error}</p> : null}
			{!searching ? (
				<div className="flex flex-col">
					{/* 根层读失败：远端错误只报稳定码对应的人话，不伪造空目录。 */}
					{tree.error !== null ? <p className="px-2 py-1 text-label text-muted-foreground">{isNotConnectedCode(tree.error) ? t("project.remote.notConnectedHint") : t("project.remote.listFailed", { code: tree.error })}</p> : null}
					{tree.listed && tree.error === null && tree.nodes.length === 0 ? <p className="px-2 py-1 text-label text-muted-foreground">{t("project.remote.empty")}</p> : null}
					{tree.nodes.map((node) => (
						<FileTreeNodeRow
							key={fileTreeNodeKey(node)}
							node={node}
							depth={0}
							expandedDirs={tree.expanded}
							activeEditorFile={file?.path ?? null}
							onToggleDirectory={(key) => tree.toggle(key)}
							onFileContextMenu={(target, x, y) => setRowMenu({ node: target, x, y })}
							onViewFile={(target) => {
								// 远端节点的打开凭据是 target（项目作用域相对路径），不是本机 path。
								const relativePath = typeof target === "string" ? target : target.relativePath;
								if (relativePath.length === 0) return;
								gateRef.current.invalidate();
								setError(null);
								setFile({ projectId: props.projectId, path: relativePath });
							}}
							onMoveFiles={(sourcePaths, targetDirectory) => {
								const source = sourcePaths[0];
								if (source !== undefined) moveInto(source, targetDirectory);
							}}
							dragOverDir={dragOverDir}
							onDragOverDirChange={setDragOverDir}
							scrollRef={scrollRef}
							remoteDragType={REMOTE_ENTRY_DRAG_TYPE}
						/>
					))}
				</div>
			) : (
				<div className="flex flex-col gap-1">
					{search.phase === "searching" ? (
						<p className="flex items-center gap-1 text-label text-muted-foreground">
							<Loader2 className="size-3.5 animate-pideck-spin" />
							{t("project.remote.searching")}
						</p>
					) : null}
					{search.phase === "error" ? <p className="text-label text-muted-foreground">{searchFailedText(search.errorCode)}</p> : null}
					{search.phase === "empty" ? <p className="text-label text-muted-foreground">{t("project.remote.searchEmpty")}</p> : null}
					{search.phase === "results" ? (
						<>
							<p className="text-label text-muted-foreground">{t("project.remote.searchSummary", { count: search.entries.length, scanned: search.scanned })}</p>
							{/* truncated 如实来自主进程：被截断就必须明说，绝不呈现成完整结果。 */}
							{search.truncated ? (
								<p className="flex items-start gap-1 text-label text-muted-foreground">
									<AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
									{t("project.remote.searchTruncated")}
								</p>
							) : null}
							<ul className="flex flex-col gap-0.5">
								{search.entries.map((entry) => (
									<li key={entry.path} className="shrink-0">
										<button type="button" className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-label hover:bg-muted/60" disabled={busy || entry.kind === "other"} onClick={() => openResult(entry)}>
											{entry.kind === "directory" ? <Folder className="size-3.5 shrink-0" /> : entry.kind === "file" ? <FileText className="size-3.5 shrink-0" /> : <Link2 className="size-3.5 shrink-0" />}
											<span className="min-w-0 flex-1 truncate">{entry.name}</span>
											<span className="min-w-0 max-w-[45%] truncate font-mono text-muted-foreground">{entry.path}</span>
											{entry.bytes !== undefined ? <span className="shrink-0 text-muted-foreground">{entry.bytes} B</span> : null}
											{entry.kind === "other" ? <span className="shrink-0 text-muted-foreground">{t("project.remote.linkNotFollowed")}</span> : null}
										</button>
									</li>
								))}
							</ul>
						</>
					) : null}
				</div>
			)}
			{rowMenu !== null ? (
				<RemoteRowMenu
					menu={rowMenu}
					busy={files.busy || busy}
					onClose={() => setRowMenu(null)}
					onDownload={() => {
						transfer.downloadFile(rowMenu.node.relativePath);
						setRowMenu(null);
					}}
					onRename={() => {
						openRowDialog(rowMenu.node, "rename");
						setRowMenu(null);
					}}
					onDelete={() => {
						openRowDialog(rowMenu.node, "delete");
						setRowMenu(null);
					}}
				/>
			) : null}
			{!searching ? <RemoteTrashPanel projectId={props.projectId} open={trashOpen} reloadToken={trashReloadToken} busy={files.busy} outcome={trashOutcomeText} onRestore={restoreTrash} onRequestPrune={(ids, count) => setEntryDialog({ kind: "prune", ids, count })} /> : null}
			{file !== null && file.projectId === props.projectId ? <RemoteFileEditor key={JSON.stringify([file.projectId, file.path])} projectId={file.projectId} path={file.path} /> : null}
			<RemoteProjectEntryDialogs dialog={entryDialog} busy={files.busy} errorText={dialogErrorText} onClose={() => setEntryDialog(null)} onCreate={submitNew} onRename={submitRename} onDelete={submitDelete} onPrune={submitPrune} />
		</div>
	);
}

/**
 * 行右键菜单：与本地文件树同一种交互。
 *
 * 用 fixed 定位而不是 Radix 的 ContextMenu：行组件已经把指针坐标交出来，这里只需要一个
 * 能被点击外部/Escape 关掉的浮层；坐标按视口夹紧，贴边右键时菜单不会被裁掉。
 */
function RemoteRowMenu(props: { menu: { node: FileTreeNode; x: number; y: number }; busy: boolean; onClose: () => void; onDownload: () => void; onRename: () => void; onDelete: () => void }) {
	const ref = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const onPointerDown = (event: MouseEvent) => {
			if (ref.current?.contains(event.target as Node)) return;
			props.onClose();
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") props.onClose();
		};
		window.addEventListener("mousedown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("mousedown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [props]);
	const isFile = props.menu.node.type === "file";
	const style = {
		left: Math.min(props.menu.x, Math.max(0, window.innerWidth - 200)),
		top: Math.min(props.menu.y, Math.max(0, window.innerHeight - 140)),
	};
	return (
		<div ref={ref} role="menu" data-testid="remote-file-row-menu" style={style} className="fixed z-50 flex min-w-[180px] flex-col rounded-md border border-border-subtle bg-bg-panel p-1 shadow-md">
			{isFile ? (
				<button type="button" role="menuitem" data-testid="remote-file-row-download" disabled={props.busy} className="flex h-7 items-center rounded-sm px-2 text-left text-body hover:bg-bg-hover disabled:opacity-50" onClick={props.onDownload}>
					{t("remoteFileEntry.downloadAction")}
				</button>
			) : null}
			<button type="button" role="menuitem" data-testid="remote-file-row-rename" disabled={props.busy} className="flex h-7 items-center rounded-sm px-2 text-left text-body hover:bg-bg-hover disabled:opacity-50" onClick={props.onRename}>
				{t("remoteFileEntry.renameAction")}
			</button>
			<button type="button" role="menuitem" data-testid="remote-file-row-delete" disabled={props.busy} className="flex h-7 items-center rounded-sm px-2 text-left text-body text-destructive hover:bg-bg-hover disabled:opacity-50" onClick={props.onDelete}>
				{t("remoteFileEntry.deleteAction")}
			</button>
		</div>
	);
}
