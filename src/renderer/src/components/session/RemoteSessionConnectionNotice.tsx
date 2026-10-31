import { useAtomValue } from "jotai";
import { CloudAlert, CloudOff, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { remoteHostIdentityIndexAtom } from "../../atoms/remote-host-atoms";
import { sessionRecordByIdAtomFamily } from "../../atoms/session-selectors";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { resolveRemoteHostConnectionTone } from "../../utils/remoteHostIdentity";
import { Button } from "../ui-shadcn/button";

/**
 * 远端会话的主机连接条。
 *
 * 语义边界：只回答「这台主机现在通不通」，不声称会话 runtime 的状态。主机断开时，当前会话的
 * 远端读取/发送可能失败，因此给一句实话 + 一个重连入口；重连成功也不假装历史/运行中的 turn
 * 已经恢复——恢复会话仍走用户自己的重发/重启。
 *
 * 数据来源：会话 record 的 ssh locator 给出 hostId；主机目录与状态由侧栏的
 * `useRemoteHostIdentityIndex` 统一维护（一次 list + main 推送），本组件只读 atom、不自己发请求。
 */
export function RemoteSessionConnectionNotice(props: { sessionId: string }) {
	const record = useAtomValue(sessionRecordByIdAtomFamily(props.sessionId));
	const hostId = record?.locator?.kind === "ssh" ? record.locator.hostId : undefined;
	const index = useAtomValue(remoteHostIdentityIndexAtom);
	const identity = hostId === undefined ? undefined : index[hostId];
	const [busy, setBusy] = useState(false);
	const [errorCode, setErrorCode] = useState<string | null>(null);
	if (hostId === undefined || identity === undefined) return null;
	const tone = resolveRemoteHostConnectionTone(identity.state);
	if (tone === "online") return null;

	const reconnect = async () => {
		setBusy(true);
		setErrorCode(null);
		try {
			const result = await desktopApi.remoteHosts.connect(hostId);
			// 失败只报稳定码；状态条本身仍由推送更新，不在本地伪造 connected。
			if (!result.ok) setErrorCode(result.code);
		} catch {
			setErrorCode("REMOTE_CONNECTION_FAILED");
		} finally {
			setBusy(false);
		}
	};

	const connecting = tone === "connecting";
	const copyKey = connecting ? "session.remoteConnection.connecting" : tone === "error" ? "session.remoteConnection.error" : "session.remoteConnection.offline";
	return (
		<div role="status" data-testid="remote-session-connection-notice" data-tone={tone} className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-subtle px-3 py-1.5 text-caption", connecting ? "bg-bg-panel" : "bg-warning/10")}>
			{connecting ? <LoaderCircle className="size-3 shrink-0 animate-pideck-spin text-warning" aria-hidden="true" /> : tone === "error" ? <CloudAlert className="size-3 shrink-0 text-destructive" aria-hidden="true" /> : <CloudOff className="size-3 shrink-0 text-warning" aria-hidden="true" />}
			<span className="shrink-0 font-medium text-foreground">{t(copyKey)}</span>
			<span className="min-w-0 text-muted-foreground">{t("session.remoteConnection.hint")}</span>
			{connecting ? null : (
				<Button size="sm" variant="ghost" className="ml-auto shrink-0" disabled={busy} onClick={() => void reconnect()}>
					{busy ? t("session.remoteConnection.reconnecting") : t("session.remoteConnection.reconnect")}
				</Button>
			)}
			{errorCode !== null ? <span className="shrink-0 text-warning">{t("session.remoteConnection.reconnectFailed", { code: errorCode })}</span> : null}
		</div>
	);
}
