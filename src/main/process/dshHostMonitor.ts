/**
 * 拼进程监控里的 DSH host 行。
 * DSH 会话共享一个 utilityProcess，不能按会话拆 pid；会话名只作展示。
 *
 * 本模块不依赖 shared/types barrel：node --test 直接加载 .ts 时目录导入会炸。
 * 稳定 id 与 `shared/types/processMetrics.ts` 的 DSH_HOST_MONITOR_ID 必须保持一致。
 */
export const DSH_HOST_MONITOR_ROW_ID = "dsh-host";

export function buildDshHostMonitorRow(input: {
	pid: number;
	sessions: ReadonlyArray<{ title?: string }>;
}): {
	agentId: string;
	kind: "dsh-host";
	pid: number;
	sessionTitle?: string;
} {
	const titles = input.sessions
		.map((session) => session.title?.trim())
		.filter((title): title is string => Boolean(title));
	return {
		agentId: DSH_HOST_MONITOR_ROW_ID,
		kind: "dsh-host",
		pid: input.pid,
		sessionTitle: titles.length > 0 ? titles.join(" · ") : undefined,
	};
}

/** 进程监控「停止」点到 DSH host 行时用这个稳定 id，不能当 pi agentId 去停。 */
export function isDshHostMonitorId(agentId: string): boolean {
	return agentId === DSH_HOST_MONITOR_ROW_ID;
}
