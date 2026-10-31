import { useAtomValue } from "jotai";
import { LoaderCircle } from "lucide-react";
import { remoteHostIdentityIndexAtom } from "../../atoms/remote-host-atoms";
import { t, type TranslationKey } from "../../i18n";
import { cn } from "../../lib/utils";
import { REMOTE_HOST_TONE_DOT_CLASS, resolveRemoteHostConnectionTone, type RemoteHostConnectionTone } from "../../utils/remoteHostIdentity";

/** 状态点文案：与 `resolveRemoteHostConnectionTone` 的四个语义一一对应。 */
const TONE_COPY: Record<RemoteHostConnectionTone, TranslationKey> = {
	online: "sidebar.remoteProject.connection.online",
	connecting: "sidebar.remoteProject.connection.connecting",
	offline: "sidebar.remoteProject.connection.offline",
	error: "sidebar.remoteProject.connection.error",
};

/**
 * 远端项目行尾的「服务器名 + 连接状态点」。
 *
 * 只读共享 atom（目录由 `useRemoteHostIdentityIndex` 一次拉取，状态由 main 推送），每行不自己发查询。
 * 语义边界：这里只表示**主机连接**，不表示 Agent 是否在跑（后者仍是行内的运行指示）；主机 ready
 * 不代表每条会话 runtime 都 ready，两者不合并。
 */
export function RemoteProjectHostTag(props: { hostId: string; testId?: string; className?: string }) {
	const index = useAtomValue(remoteHostIdentityIndexAtom);
	const identity = index[props.hostId];
	// 目录还没到（首次挂载/功能未启用）时不占位，也不编一个「未知主机」闪一下；状态推送先到则只画点。
	if (identity === undefined) return null;
	const tone = resolveRemoteHostConnectionTone(identity.state);
	const host = identity.label.trim();
	const accessibleHost = host.length > 0 ? host : t("sidebar.remoteProject.unknownHost");
	const stateLabel = t(TONE_COPY[tone]);
	const hint = t("sidebar.remoteProject.connectionHint", { host: accessibleHost, state: stateLabel });
	return (
		<span role="img" aria-label={hint} title={hint} data-testid={props.testId ?? "remote-project-host"} data-tone={tone} className={cn("ml-1 flex min-w-0 max-w-[9.5rem] shrink items-center gap-1 text-micro text-muted-foreground", props.className)}>
			{host.length > 0 ? (
				<span aria-hidden="true" className="min-w-0 truncate">
					{host}
				</span>
			) : null}
			{tone === "connecting" ? <LoaderCircle aria-hidden="true" className="size-2.5 shrink-0 animate-pideck-spin text-warning" /> : <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", REMOTE_HOST_TONE_DOT_CLASS[tone])} />}
		</span>
	);
}
