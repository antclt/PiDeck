import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, Eye, EyeOff, Folder, Link2, LoaderCircle, RefreshCw } from "lucide-react";
import type { RemoteDirectoryEntry } from "../../../../shared/types/remoteHost";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { Button } from "../ui-shadcn/button";
import { isVisibleRemoteDirectory, remoteParentPath, remotePathSegments } from "./remoteDirectoryPath";

/**
 * 远端目录浏览器（项目登记用）。
 *
 * 只读：调用 `remoteHosts.listDirs`，服务端只返回目录名与是否符号链接。导航本身不构成授权——
 * 用户点「解析路径」后仍由主进程做 canonical 复核、确认推送与回答时重检。
 *
 * 代次闸门：快速连点目录时，旧请求的迟到结果不能覆盖新目录；卸载/换主机同样作废。
 */
export function RemoteDirectoryPicker(props: { hostId: string; value: string; onChange: (path: string) => void; disabled?: boolean }) {
	const [current, setCurrent] = useState("");
	const [entries, setEntries] = useState<RemoteDirectoryEntry[]>([]);
	const [truncated, setTruncated] = useState(false);
	const [loading, setLoading] = useState(false);
	const [errorCode, setErrorCode] = useState<string | null>(null);
	const [showHidden, setShowHidden] = useState(false);
	const gateRef = useRef(0);
	const onChangeRef = useRef(props.onChange);
	onChangeRef.current = props.onChange;

	const load = useCallback(
		async (target?: string) => {
			const gate = ++gateRef.current;
			setLoading(true);
			setErrorCode(null);
			let result: Awaited<ReturnType<typeof desktopApi.remoteHosts.listDirs>>;
			try {
				result = await desktopApi.remoteHosts.listDirs(props.hostId, target);
			} catch {
				if (gate !== gateRef.current) return;
				setLoading(false);
				setErrorCode("REMOTE_LIST_DIRS_PROBE_FAILED");
				return;
			}
			if (gate !== gateRef.current) return;
			setLoading(false);
			if (!result.ok) {
				// 目标是文件/已消失：退回父目录，而不是把用户卡在错误上（父目录同样由服务端校验）。
				if (result.code === "REMOTE_LIST_DIRS_NOT_A_DIRECTORY" && target !== undefined) {
					const parent = remoteParentPath(target);
					if (parent !== target) {
						void load(parent);
						return;
					}
				}
				setErrorCode(result.code);
				return;
			}
			setCurrent(result.path);
			setEntries(result.entries);
			setTruncated(result.truncated);
			onChangeRef.current(result.path);
		},
		[props.hostId],
	);

	// 只在主机变化时重新定位：导航写入的 value 不应该反过来触发一次额外的远端请求。
	useEffect(() => {
		setEntries([]);
		setCurrent("");
		setErrorCode(null);
		void load(props.value.trim().length > 0 ? props.value.trim() : undefined);
	}, [props.hostId, load]);

	const visible = entries.filter((entry) => isVisibleRemoteDirectory(entry.name, showHidden));
	const segments = remotePathSegments(current);
	const errorText =
		errorCode === null
			? null
			: errorCode === "SSH_HOST_NOT_READY" || errorCode === "SSH_HOST_DISCONNECTED" || errorCode === "SSH_CONNECTION_FAILED"
				? t("sidebar.remoteEnroll.dirNotConnected")
				: errorCode === "REMOTE_LIST_DIRS_NOT_A_DIRECTORY"
					? t("sidebar.remoteEnroll.dirNotADirectory")
					: t("sidebar.remoteEnroll.dirFailed", { code: errorCode });

	return (
		<div data-testid="remote-directory-picker" data-current-path={current} className="flex flex-col gap-1.5 rounded-lg border border-border-subtle bg-bg-panel p-2">
			<div className="flex min-w-0 items-center gap-1">
				<Button type="button" variant="ghost" size="icon-xs" className="shrink-0" aria-label={t("sidebar.remoteEnroll.dirParent")} title={t("sidebar.remoteEnroll.dirParent")} disabled={props.disabled || loading || current === "" || current === "/"} onClick={() => void load(remoteParentPath(current))}>
					<ChevronLeft className="size-3.5" aria-hidden="true" />
				</Button>
				<nav aria-label={t("sidebar.remoteEnroll.dirCurrentPath")} className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-label">
					{segments.map((segment, index) => (
						<span key={segment.path} className="inline-flex items-center">
							{index > 0 ? <span className="px-0.5 text-muted-foreground">/</span> : null}
							<button type="button" className="rounded px-0.5 hover:bg-bg-hover disabled:opacity-60" disabled={props.disabled || loading} onClick={() => void load(segment.path)}>
								{segment.label}
							</button>
						</span>
					))}
				</nav>
				<Button type="button" variant="ghost" size="icon-xs" className="shrink-0" aria-label={t("sidebar.remoteEnroll.dirRefresh")} title={t("sidebar.remoteEnroll.dirRefresh")} disabled={props.disabled || loading || current === ""} onClick={() => void load(current)}>
					<RefreshCw className={cn("size-3.5", loading && "animate-pideck-spin")} aria-hidden="true" />
				</Button>
				<Button type="button" variant="ghost" size="icon-xs" className="shrink-0" aria-pressed={showHidden} aria-label={t("sidebar.remoteEnroll.dirShowHidden")} title={t("sidebar.remoteEnroll.dirShowHidden")} disabled={props.disabled} onClick={() => setShowHidden((shown) => !shown)}>
					{showHidden ? <EyeOff className="size-3.5" aria-hidden="true" /> : <Eye className="size-3.5" aria-hidden="true" />}
				</Button>
			</div>

			{loading ? (
				<p className="flex items-center gap-1 px-1 py-2 text-label text-muted-foreground">
					<LoaderCircle className="size-3 animate-pideck-spin" aria-hidden="true" />
					{t("sidebar.remoteEnroll.dirLoading")}
				</p>
			) : errorText !== null ? (
				<p className="px-1 py-2 text-label text-muted-foreground">{errorText}</p>
			) : visible.length === 0 ? (
				<p className="px-1 py-2 text-label text-muted-foreground">{t("sidebar.remoteEnroll.dirEmpty")}</p>
			) : (
				<ul className="flex max-h-52 flex-col gap-0.5 overflow-y-auto">
					{visible.map((entry) => (
						<li key={entry.name}>
							<button
								type="button"
								data-testid="remote-directory-entry"
								data-symlink={entry.isSymlink ? "true" : undefined}
								className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-body hover:bg-bg-hover disabled:opacity-60"
								disabled={props.disabled}
								onClick={() => void load(current === "/" ? `/${entry.name}` : `${current}/${entry.name}`)}
							>
								<Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
								<span className="min-w-0 flex-1 truncate">{entry.name}</span>
								{entry.isSymlink ? <Link2 className="size-3 shrink-0 text-muted-foreground" aria-label={t("sidebar.remoteEnroll.dirSymlink")} /> : null}
							</button>
						</li>
					))}
				</ul>
			)}
			{truncated && !loading && errorCode === null ? <p className="px-1 text-label text-muted-foreground">{t("sidebar.remoteEnroll.dirTruncated")}</p> : null}
		</div>
	);
}
