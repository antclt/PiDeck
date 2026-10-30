import { useEffect, useState } from "react";
import type { RemoteEntryKind } from "../../../../shared/types/remoteFiles";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../ui-shadcn/alert-dialog";
import { Input } from "../ui-shadcn/input";
import { Label } from "../ui-shadcn/label";

/** 当前打开的确认弹框；state 由面板持有，本组件是纯受控视图（§10.2/§10.3）。 */
export type RemoteEntryDialog = { kind: "new"; entryKind: RemoteEntryKind; parent: string } | { kind: "rename"; source: string } | { kind: "delete"; path: string; entryKind: RemoteEntryKind } | { kind: "prune"; ids: string[]; count: number };

export type RemoteProjectEntryDialogsProps = {
	dialog: RemoteEntryDialog | null;
	busy: boolean;
	/** 已知失败且决定保留输入时的错误文案；否则 null。 */
	errorText: string | null;
	onClose: () => void;
	onCreate: (entryKind: RemoteEntryKind, parent: string, name: string) => void;
	onRename: (source: string, target: string) => void;
	onDelete: (path: string) => void;
	onPrune: (ids: string[]) => void;
};

/**
 * 新建 / 重命名 / 删除确认 / 清空回收站四个受控弹框。
 *
 * 只做呈现与事件转发：业务状态（busy/error/unknown）由 useRemoteProjectEntries 与面板拥有，
 * 成功后是否关闭、失败后是否保留输入都在面板决定（§10.3 的「失败按稳定码决定」）。
 * 删除/清空回收站是不可逆危险动作：走 AlertDialog 模板（与其它域的危险确认一致，
 * Esc/外点只做取消语义，不携带任何确认路径），busy 期间锁全部关闭与提交入口。
 */
export function RemoteProjectEntryDialogs(props: RemoteProjectEntryDialogsProps) {
	const { dialog, busy, errorText } = props;
	const [name, setName] = useState("");
	const [renameValue, setRenameValue] = useState("");
	useEffect(() => {
		if (dialog?.kind === "new") setName("");
		if (dialog?.kind === "rename") setRenameValue(dialog.source);
	}, [dialog]);
	if (dialog === null) return null;
	const newFileTitle = dialog.kind === "new" && dialog.entryKind === "file";
	const dialogKey = dialog.kind === "new" ? "new" : dialog.kind;
	const parentLabel = dialog.kind === "new" ? (dialog.parent === "" ? "/" : dialog.parent) : "";
	return (
		<>
			{dialog.kind === "new" ? (
				<Dialog
					open
					onOpenChange={(next) => {
						if (!next) props.onClose();
					}}
				>
					<DialogContent data-testid="remote-file-new-dialog">
						<DialogHeader>
							<DialogTitle>{newFileTitle ? t("remoteFileEntry.newFile") : t("remoteFileEntry.newFolder")}</DialogTitle>
							<DialogDescription>
								{t("remoteFileEntry.parentLabel")}: <span className="font-mono">{parentLabel}</span>
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-1.5">
							<Label htmlFor="remote-file-new-name">{t("remoteFileEntry.nameLabel")}</Label>
							<Input id="remote-file-new-name" data-testid="remote-file-new-name" aria-label={t("remoteFileEntry.nameLabel")} value={name} autoFocus disabled={busy} onChange={(event) => setName(event.target.value)} />
						</div>
						{errorText !== null ? <p className="text-label text-destructive">{errorText}</p> : null}
						<DialogFooter>
							<Button variant="ghost" data-testid="remote-file-new-cancel" disabled={busy} onClick={props.onClose}>
								{t("common.cancel")}
							</Button>
							<Button data-testid="remote-file-new-confirm" disabled={busy || name.trim().length === 0} onClick={() => props.onCreate(dialog.entryKind, dialog.parent, name.trim())}>
								{t("remoteFileEntry.createAction")}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			) : null}

			{dialog.kind === "rename" ? (
				<Dialog
					open
					onOpenChange={(next) => {
						if (!next) props.onClose();
					}}
				>
					<DialogContent data-testid="remote-file-rename-dialog">
						<DialogHeader>
							<DialogTitle>{t("remoteFileEntry.renameTitle")}</DialogTitle>
							<DialogDescription className="font-mono">{dialog.source}</DialogDescription>
						</DialogHeader>
						<div className="grid gap-1.5">
							<Label htmlFor="remote-file-rename-input">{t("remoteFileEntry.nameLabel")}</Label>
							<Input id="remote-file-rename-input" data-testid="remote-file-rename-input" aria-label={t("remoteFileEntry.nameLabel")} value={renameValue} autoFocus disabled={busy} onChange={(event) => setRenameValue(event.target.value)} />
						</div>
						{errorText !== null ? <p className="text-label text-destructive">{errorText}</p> : null}
						<DialogFooter>
							<Button variant="ghost" data-testid="remote-file-rename-cancel" disabled={busy} onClick={props.onClose}>
								{t("common.cancel")}
							</Button>
							<Button data-testid="remote-file-rename-confirm" disabled={busy || renameValue.trim().length === 0 || renameValue.trim() === dialog.source} onClick={() => props.onRename(dialog.source, renameValue.trim())}>
								{t("remoteFileEntry.renameAction")}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			) : null}

			{dialog.kind === "delete" ? (
				<AlertDialog
					open
					onOpenChange={(next) => {
						if (!next && !busy) props.onClose();
					}}
				>
					<AlertDialogContent data-testid="remote-file-delete-dialog">
						<AlertDialogHeader>
							<AlertDialogTitle>{dialog.entryKind === "file" ? t("remoteFileEntry.deleteTitleFile") : t("remoteFileEntry.deleteTitleFolder")}</AlertDialogTitle>
							<AlertDialogDescription>{dialog.entryKind === "file" ? t("remoteFileEntry.deleteBody") : t("remoteFileEntry.deleteBodyFolder")}</AlertDialogDescription>
						</AlertDialogHeader>
						<p className="break-all font-mono text-label">{dialog.path}</p>
						{errorText !== null ? (
							<p className="text-label text-destructive" role="alert">
								{errorText}
							</p>
						) : null}
						<AlertDialogFooter>
							<AlertDialogCancel data-testid="remote-file-delete-cancel" disabled={busy} onClick={props.onClose}>
								{t("common.cancel")}
							</AlertDialogCancel>
							<AlertDialogAction data-testid="remote-file-delete-confirm" disabled={busy} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => props.onDelete(dialog.path)}>
								{t("remoteFileEntry.deleteAction")}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			) : null}

			{dialog.kind === "prune" ? (
				<AlertDialog
					open
					onOpenChange={(next) => {
						if (!next && !busy) props.onClose();
					}}
				>
					<AlertDialogContent data-testid="remote-trash-prune-dialog">
						<AlertDialogHeader>
							<AlertDialogTitle>{t("remoteTrash.pruneConfirmTitle")}</AlertDialogTitle>
							<AlertDialogDescription>{t("remoteTrash.pruneConfirmBody")}</AlertDialogDescription>
						</AlertDialogHeader>
						{errorText !== null ? (
							<p className="text-label text-destructive" role="alert">
								{errorText}
							</p>
						) : null}
						<AlertDialogFooter>
							<AlertDialogCancel data-testid="remote-trash-prune-cancel" disabled={busy} onClick={props.onClose}>
								{t("common.cancel")}
							</AlertDialogCancel>
							<AlertDialogAction data-testid="remote-trash-prune-confirm" disabled={busy} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => props.onPrune(dialog.ids)}>
								{t("remoteTrash.pruneAction")}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			) : null}
			<span className="hidden" aria-hidden="true" data-dialog-kind={dialogKey} />
		</>
	);
}
