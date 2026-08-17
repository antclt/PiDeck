import type { SessionRecord } from "../../shared/types";

/**
 * DSH 外部会话同步（跨工具兼容深化）：把 DSH_HOME 里由 dsh-web 等其他工具创建的
 * host 根会话映射进 PiDeck catalog，侧栏即可直接查看/加载/续聊。
 *
 * 本模块只做编排与纯策略（选项目、过滤已导入、标题归一），不碰 Electron：
 * - 幂等由 SessionCatalog.createDraft 的 dshSessionId 去重保证（重复导入只更新不新增）；
 * - 目标项目按 cwd 匹配已注册项目，无 cwd / 未匹配的进入「外部会话」兑底项目；
 * - 标题优先取 host list 投影，缺失时经 resolveHostTitle 从 host 历史投影补全，
 *   仍缺失则用兜底标题（mainCopy session.dshUntitled）。
 */

/** host sessions.list 的一行外部根会话（DshHost.listForeignSessions 的返回形状）。 */
export type DshForeignSessionItem = {
	dshSessionId: string;
	title?: string;
	cwd?: string;
	updatedAt?: number;
};

/** 一次同步的结果统计（供配置页提示/日志）。 */
export type DshForeignSyncResult = {
	/** 本轮实际导入的会话数（含重复导入被去重吸收的——语义上仍是「已入册」）。 */
	imported: number;
	/** 已在 catalog 中、本轮跳过的会话数（仅在传入 knownIds 时统计）。 */
	skipped: number;
};

export type DshForeignSyncDeps = {
	/** host 侧外部根会话清单。 */
	listForeignSessions: () => Promise<DshForeignSessionItem[]>;
	/** 按目录找已注册项目（无匹配返回 null）。 */
	findProjectByPath: (cwd: string) => { id: string } | null;
	/** 兑底项目（无 cwd / 未匹配目录时使用；惰性创建一次）。 */
	ensureFallbackProject: () => Promise<{ id: string }>;
	/** catalog 映射写入（幂等：同 dshSessionId 已存在时更新并返回既有记录）。 */
	createDraft: (input: {
		projectId: string;
		title: string;
		environment: "native" | "wsl";
		backend: "dsh";
		dshSessionId: string;
	}) => Promise<SessionRecord>;
	/** 当前环境（native/wsl）。 */
	getEnvironment: () => "native" | "wsl";
	/** list 投影缺失标题时的兜底标题（i18n：DSH 会话）。 */
	fallbackTitle: string;
	/** host 侧标题补全（按会话 id 从历史投影读取；缺省不补全）。 */
	resolveHostTitle?: (dshSessionId: string) => Promise<string | undefined>;
	/** 单条导入失败回调（不阻断其余会话；缺省静默）。 */
	onError?: (dshSessionId: string, error: unknown) => void;
};

/** 标题归一：空串/纯空白视为缺失。 */
export function normalizeForeignTitle(title: string | undefined): string | undefined {
	return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

/** catalog 中已映射的 host 会话 id 集合（导入过滤/去重用）。 */
export function knownForeignSessionIds(
	entries: ReadonlyArray<{ dshSessionId?: string }>,
): Set<string> {
	const known = new Set<string>();
	for (const entry of entries) {
		if (entry.dshSessionId) known.add(entry.dshSessionId);
	}
	return known;
}

/** 按 cwd 过滤出尚未导入的外部会话（纯函数）。 */
export function splitForeignSessions(
	items: readonly DshForeignSessionItem[],
	knownIds: ReadonlySet<string>,
): { pending: DshForeignSessionItem[]; imported: DshForeignSessionItem[] } {
	const pending: DshForeignSessionItem[] = [];
	const imported: DshForeignSessionItem[] = [];
	for (const item of items) {
		(knownIds.has(item.dshSessionId) ? imported : pending).push(item);
	}
	return { pending, imported };
}

/**
 * 决定外部会话的目标项目（纯策略）：
 * cwd 命中已注册项目 → 该项目；无 cwd 或未命中 → 兑底项目。
 * 返回是否按目录匹配（matched），供日志区分归属来源。
 */
export function pickProjectForForeignSession(
	item: DshForeignSessionItem,
	findProjectByPath: (cwd: string) => { id: string } | null,
	fallbackProjectId: string,
): { projectId: string; matched: boolean } {
	if (item.cwd) {
		const matched = findProjectByPath(item.cwd);
		if (matched) return { projectId: matched.id, matched: true };
	}
	return { projectId: fallbackProjectId, matched: false };
}

/** 解析最终标题：list 投影 > host 历史投影补全 > 兜底标题。 */
export async function resolveForeignSessionTitle(
	item: DshForeignSessionItem,
	fallbackTitle: string,
	resolveHostTitle?: (dshSessionId: string) => Promise<string | undefined>,
): Promise<string> {
	const projected = normalizeForeignTitle(item.title);
	if (projected) return projected;
	if (resolveHostTitle) {
		const hostTitle = await resolveHostTitle(item.dshSessionId);
		const normalized = normalizeForeignTitle(hostTitle);
		if (normalized) return normalized;
	}
	return fallbackTitle;
}

/**
 * 导入单个外部会话（幂等）。item 未给出时按 dshSessionId 从清单反查；
 * 目标项目与标题按上面的策略解析，最后经 createDraft 落 catalog（重复导入被吸收）。
 */
export async function importForeignSession(
	deps: DshForeignSyncDeps,
	dshSessionId: string,
	item?: DshForeignSessionItem,
): Promise<SessionRecord> {
	let target = item;
	if (!target) {
		const items = await deps.listForeignSessions();
		target = items.find((candidate) => candidate.dshSessionId === dshSessionId);
	}
	if (!target) throw new Error(`Foreign DSH session not found: ${dshSessionId}`);
	const fallbackProject = await deps.ensureFallbackProject();
	const { projectId } = pickProjectForForeignSession(
		target,
		deps.findProjectByPath,
		fallbackProject.id,
	);
	const title = await resolveForeignSessionTitle(target, deps.fallbackTitle, deps.resolveHostTitle);
	return deps.createDraft({
		projectId,
		title,
		environment: deps.getEnvironment(),
		backend: "dsh",
		dshSessionId,
	});
}

/**
 * 全量同步外部会话：把 catalog 尚未映射的 host 根会话全部导入（自动发现）。
 * 单条失败只记日志不阻断其余；knownIds 缺省时全部交给 createDraft 幂等吸收。
 */
export async function syncForeignSessions(
	deps: DshForeignSyncDeps,
	knownIds?: ReadonlySet<string>,
): Promise<DshForeignSyncResult> {
	const items = await deps.listForeignSessions();
	let imported = 0;
	let skipped = 0;
	if (knownIds) {
		const { pending, imported: alreadyImported } = splitForeignSessions(items, knownIds);
		skipped = alreadyImported.length;
		for (const item of pending) {
			try {
				await importForeignSession(deps, item.dshSessionId, item);
				imported += 1;
			} catch (error) {
				deps.onError?.(item.dshSessionId, error);
			}
		}
	} else {
		for (const item of items) {
			try {
				await importForeignSession(deps, item.dshSessionId, item);
				imported += 1;
			} catch (error) {
				deps.onError?.(item.dshSessionId, error);
			}
		}
	}
	return { imported, skipped };
}
