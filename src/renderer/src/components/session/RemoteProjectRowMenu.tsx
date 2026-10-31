import { useEffect, useRef } from "react";
import type { FileTreeNode } from "../../../../shared/types";
import { t } from "../../i18n";

/**
 * 远端文件树的行右键菜单（从 RemoteProjectPanel 抽出，面板必须守住 440 行单文件红线）。
 *
 * 与本地文件树同一种交互：用 fixed 定位而不是 Radix 的 ContextMenu——行组件已经把指针坐标交出来，
 * 这里只需要一个能被点击外部/Escape 关掉的浮层；坐标按视口夹紧，贴边右键时菜单不会被裁掉。
 */
export function RemoteProjectRowMenu(props: { menu: { node: FileTreeNode; x: number; y: number }; busy: boolean; onClose: () => void; onDownload: () => void; onRename: () => void; onDelete: () => void }) {
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
