import { isForeignRootSession, scanDshSessionHeaders } from "./dshForeignSessionScan";
import {
	accountedSessionIds,
	findWorkspaceByCwd,
	readWorkspaceRegistry,
	type DshWorkspaceRecord,
} from "./dshWorkspaceRegistry";

/**
 * 把 dsh-web「未分组」里本该入账的根会话，经官方 API 认领回已有 workspace。
 *
 * 官方规则（dsh-workspace README）：
 * - 后续只按 cwd 创建的会话永远留在 Ungrouped；
 * - 认领必须 `sessions.create({ workspaceId, sessionId })`，host 内部 attachSession
 *   会校验 header.cwd realpath === workspace.path；
 * - 没有公开 attachSession RPC，禁止手写 workspace.json。
 *
 * 只认领「cwd 已经对应现有 workspace」的根会话：
 * - 子代理 / 带 parent / delegationDepth>0 不认领（不是侧栏根会话）；
 * - cwd 对不上任何已注册 workspace 的不认领（不得为此新建组，避免污染 dsh-web）；
 * - 已经在某个 workspace.sessionIds 里的跳过。
 *
 * 必须在 **我们自己的 host 已就绪** 时调用。dsh-web 还占着同一 DSH_HOME 时
 * 不要跑——双 host 会抢 session log。
 */

export type UngroupedAdoptCandidate = {
	dshSessionId: string;
	cwd: string;
	workspaceId: string;
	workspaceTitle?: string;
};

export type UngroupedAdoptResult = {
	adopted: number;
	failed: number;
};

export type UngroupedAdoptDeps = {
	/** 只读扫磁盘 header（含 cwd / origin / parent / depth）。 */
	scanHeaders: () => Array<{
		id: string;
		cwd?: string;
		origin?: string;
		parentSession?: string;
		delegationDepth?: number;
	}>;
	/** 只读官方 workspace 注册表。 */
	listWorkspaces: () => DshWorkspaceRecord[];
	/**
	 * 官方认领：sessions.create({ workspaceId, sessionId })。
	 * host 会对已存在会话做 adopt + attachSession，不会新建日志。
	 */
	adoptIntoWorkspace: (input: { workspaceId: string; sessionId: string }) => Promise<void>;
	onError?: (dshSessionId: string, error: unknown) => void;
};

/** 从磁盘 header + 官方注册表筛出可认领的未分组根会话（纯策略）。 */
export function listUngroupedAdoptCandidates(
	headers: ReadonlyArray<{
		id: string;
		cwd?: string;
		origin?: string;
		parentSession?: string;
		delegationDepth?: number;
	}>,
	workspaces: readonly DshWorkspaceRecord[],
): UngroupedAdoptCandidate[] {
	const accounted = accountedSessionIds(workspaces);
	const candidates: UngroupedAdoptCandidate[] = [];
	for (const header of headers) {
		if (!isForeignRootSession({
			id: header.id,
			updatedAt: 0,
			...(header.cwd ? { cwd: header.cwd } : {}),
			...(header.origin ? { origin: header.origin } : {}),
			...(header.parentSession ? { parentSession: header.parentSession } : {}),
			...(header.delegationDepth !== undefined ? { delegationDepth: header.delegationDepth } : {}),
		})) continue;
		if (accounted.has(header.id)) continue;
		if (!header.cwd) continue;
		const workspace = findWorkspaceByCwd(workspaces, header.cwd);
		// cwd 对不上已有 workspace：官方不会自动建组，我们也不替用户新建。
		if (!workspace) continue;
		candidates.push({
			dshSessionId: header.id,
			cwd: header.cwd,
			workspaceId: workspace.workspaceId,
			...(workspace.title ? { workspaceTitle: workspace.title } : {}),
		});
	}
	return candidates;
}

/** 读 DSH_HOME 磁盘，列出可认领的未分组根会话（不启动 host）。 */
export function listUngroupedAdoptCandidatesFromDisk(dshHome: string): UngroupedAdoptCandidate[] {
	return listUngroupedAdoptCandidates(
		scanDshSessionHeaders(dshHome),
		readWorkspaceRegistry(dshHome),
	);
}

/** 逐条官方认领；单条失败不阻断其余。 */
export async function adoptUngroupedSessions(
	deps: UngroupedAdoptDeps,
): Promise<UngroupedAdoptResult> {
	const candidates = listUngroupedAdoptCandidates(deps.scanHeaders(), deps.listWorkspaces());
	let adopted = 0;
	let failed = 0;
	for (const candidate of candidates) {
		try {
			await deps.adoptIntoWorkspace({
				workspaceId: candidate.workspaceId,
				sessionId: candidate.dshSessionId,
			});
			adopted += 1;
		} catch (error) {
			failed += 1;
			deps.onError?.(candidate.dshSessionId, error);
		}
	}
	return { adopted, failed };
}
