/**
 * WebRewindPanel — 回退检查点面板（P1）。
 *
 * 与桌面 RewindPanel 同语义的 Web 版（Dialog 而非抽屉）：
 * - 打开时拉取检查点分页（fetchRewindCheckpoints，新→旧）
 * - 点击「查看差异」拉取 unified diff 展示
 * - 恢复时选择范围（files / conversation / all；conversation 与 all 会 fork 新会话），
 *   成功后回调 onRestored（WebChatApp 负责刷新会话列表/切换 fork 产物）。
 * 需要 runtime 存活（无 runtime 时入口按钮已隐藏）。
 */
import { useCallback, useEffect, useState } from "react";
import { History, Loader2 } from "lucide-react";
import type { RewindCheckpointPage, RewindCheckpointSummary, RewindRestoreResult, RewindRestoreScope, SessionRuntimeTarget } from "../../../shared/types";
import { Button } from "@/components/ui-shadcn/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui-shadcn/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui-shadcn/select";
import { t } from "@/i18n";
import { fetchRewindCheckpoints, fetchRewindDiff, restoreRewind } from "./webApi";

export function WebRewindPanel(props: { sessionId: string; target: SessionRuntimeTarget; open: boolean; onClose: () => void; onRestored: (result: RewindRestoreResult) => void }) {
	const [checkpoints, setCheckpoints] = useState<RewindCheckpointSummary[]>([]);
	const [loading, setLoading] = useState(false);
	const [diffFor, setDiffFor] = useState<string | null>(null);
	const [diffText, setDiffText] = useState<string>("");
	const [diffLoading, setDiffLoading] = useState(false);
	const [scope, setScope] = useState<RewindRestoreScope>("files");
	const [restoring, setRestoring] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const page = await fetchRewindCheckpoints(props.sessionId, props.target, 30);
			setCheckpoints(page.items ?? []);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	}, [props.sessionId, props.target]);

	useEffect(() => {
		if (props.open) void load();
	}, [props.open, load]);

	const viewDiff = async (checkpointId: string) => {
		if (diffFor === checkpointId) {
			setDiffFor(null);
			return;
		}
		setDiffFor(checkpointId);
		setDiffLoading(true);
		try {
			setDiffText(await fetchRewindDiff(props.sessionId, props.target, checkpointId));
		} catch (cause) {
			setDiffText(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setDiffLoading(false);
		}
	};

	const restore = async (checkpointId: string) => {
		setRestoring(checkpointId);
		setError(null);
		try {
			const result = await restoreRewind(props.sessionId, props.target, checkpointId, scope);
			props.onRestored(result);
			props.onClose();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setRestoring(null);
		}
	};

	return (
		<Dialog open={props.open} onOpenChange={(open) => (!open ? props.onClose() : undefined)}>
			<DialogContent className="flex max-h-[80vh] w-[min(720px,calc(100vw-24px))] flex-col gap-3">
				<DialogHeader className="flex-row items-center gap-2 space-y-0">
					<History className="size-4 text-muted-foreground" aria-hidden="true" />
					<DialogTitle className="text-sm">{t("web.rewindTitle")}</DialogTitle>
					<Select value={scope} onValueChange={(next) => setScope(next as RewindRestoreScope)}>
						<SelectTrigger size="sm" className="ml-auto h-7 w-44 text-caption" aria-label={t("web.rewindRestore")}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="files">{t("web.rewindScopeFiles")}</SelectItem>
							<SelectItem value="conversation">{t("web.rewindScopeConversation")}</SelectItem>
							<SelectItem value="all">{t("web.rewindScopeAll")}</SelectItem>
						</SelectContent>
					</Select>
				</DialogHeader>
				{error ? <div className="rounded-md bg-danger/10 px-3 py-2 text-caption text-danger">{error}</div> : null}
				<div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
					{loading ? (
						<div className="flex items-center justify-center gap-2 py-8 text-caption text-muted-foreground">
							<Loader2 className="size-4 animate-pideck-spin" aria-hidden="true" />
						</div>
					) : checkpoints.length === 0 ? (
						<div className="py-8 text-center text-caption text-muted-foreground">{t("web.rewindEmpty")}</div>
					) : (
						<ul className="flex flex-col gap-1.5">
							{checkpoints.map((checkpoint) => (
								<li key={checkpoint.id} className="rounded-lg border border-border bg-card px-3 py-2">
									<div className="flex min-w-0 items-center gap-2">
										<div className="min-w-0 flex-1">
											<div className="truncate text-control text-foreground">{checkpoint.description || checkpoint.id}</div>
											<div className="text-micro text-muted-foreground">{new Date(checkpoint.timestamp).toLocaleString()}</div>
										</div>
										<Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-caption text-muted-foreground" onClick={() => void viewDiff(checkpoint.id)}>
											{t("web.rewindViewDiff")}
										</Button>
										<Button type="button" size="sm" className="h-7 px-2.5 text-caption" disabled={restoring !== null} onClick={() => void restore(checkpoint.id)}>
											{restoring === checkpoint.id ? <Loader2 className="size-3.5 animate-pideck-spin" aria-hidden="true" /> : t("web.rewindRestore")}
										</Button>
									</div>
									{diffFor === checkpoint.id ? (
										diffLoading ? (
											<div className="mt-2 flex items-center gap-2 text-micro text-muted-foreground">
												<Loader2 className="size-3 animate-pideck-spin" aria-hidden="true" />
											</div>
										) : (
											<pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted/60 p-2 text-micro leading-relaxed whitespace-pre-wrap">{diffText || "—"}</pre>
										)
									) : null}
								</li>
							))}
						</ul>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
