/**
 * 用官方 `sessionProjectionCache.coldSnapshot` 回写缺标题的投影缓存。
 *
 * dsh-web 冷列表（sessions.list 未 attach）只读 `session_projcache` 的
 * `cachedSnapshot`，不 fold 日志。PiDeck 以前没挂投影缓存插件，标题只写在
 * `session/title` 日志里，dsh-web 侧栏就会退回 workspace / 目录名。
 *
 * 这里不手写 session_projcache.json：只调用官方 cold-read ladder
 *（缓存行 + persistence.readFrom 尾部 + restore + fail-soft 回写）。
 * 仅在我们自己的 host 已 boot 之后跑；不 attach、不抢 session log。
 * 配置页按钮与 host 启动后台任务共用同一套决策：历史会话只要缓存缺
 * 非空 title，就会 coldSnapshot；不是「只修新会话」。
 */
import { isForeignRootSession, scanDshSessionHeaders } from "./dshForeignSessionScan";
import { readSessionProjectionTitles } from "./dshProjectionCache";

/** sessions.list / persistence.list 用到的最小 header。 */
export type ProjectionBackfillMeta = {
	id: string;
	origin?: string;
	parentSession?: string;
	delegationDepth?: number;
};

/** cachedSnapshot 的最小形状：只看 values.title。 */
export type ProjectionBackfillSnapshot = {
	values?: Record<string, unknown>;
};

/** 官方 persistence + projection-cache 的窄接口，便于单测替身。 */
export type ProjectionCacheBackfillDeps = {
	list: () => Promise<ProjectionBackfillMeta[]>;
	cachedSnapshot: (meta: ProjectionBackfillMeta) => ProjectionBackfillSnapshot | undefined;
	coldSnapshot: (sessionId: string) => Promise<unknown>;
	log?: (message: string) => void;
};

/** 子代理 / 委托会话不进侧栏，不必为它们回写标题。 */
export function isRootSessionMeta(meta: ProjectionBackfillMeta): boolean {
	if (meta.origin === "subagent") return false;
	if (meta.parentSession) return false;
	if ((meta.delegationDepth ?? 0) > 0) return false;
	return Boolean(meta.id);
}

/**
 * 冷列表缺非空 title 才回写。
 * 已有真实标题的行不要 coldSnapshot：避免每次启动把整段日志再 fold 一遍。
 */
export function shouldBackfillProjectionTitle(
	snapshot: ProjectionBackfillSnapshot | undefined,
): boolean {
	const title = snapshot?.values?.title;
	return typeof title !== "string" || !title.trim();
}

export type ProjectionCacheBackfillResult = {
	attempted: number;
	failed: number;
};

/** 磁盘预览：缓存缺标题的根会话（不启动 host）。 */
export type MissingProjectionTitlePreview = {
	missing: number;
	titled: number;
	samples: Array<{ dshSessionId: string; loggedTitle?: string; cwd?: string }>;
};

/**
 * 只读对照磁盘 header / 日志折叠标题 与 session_projcache。
 * 用来告诉用户「有多少历史会话 dsh-web 会显示成目录名」。
 * 不写文件、不 attach。
 */
export function previewMissingProjectionTitles(
	dshHome: string,
	sampleLimit = 8,
): MissingProjectionTitlePreview {
	const cacheTitles = readSessionProjectionTitles(dshHome);
	const samples: MissingProjectionTitlePreview["samples"] = [];
	let missing = 0;
	let titled = 0;
	for (const header of scanDshSessionHeaders(dshHome).filter(isForeignRootSession)) {
		if (cacheTitles.get(header.id)) {
			titled += 1;
			continue;
		}
		missing += 1;
		if (samples.length < sampleLimit) {
			samples.push({
				dshSessionId: header.id,
				...(header.loggedTitle ? { loggedTitle: header.loggedTitle } : {}),
				...(header.cwd ? { cwd: header.cwd } : {}),
			});
		}
	}
	return { missing, titled, samples };
}

/**
 * 串行 coldSnapshot 缺标题的根会话。
 * 串行是为了不并行解开多份 zstd 日志把 utilityProcess 打满；单条失败跳过。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function asBackfillMeta(value: unknown): ProjectionBackfillMeta | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || !value.id) return undefined;
	return {
		id: value.id,
		...(typeof value.origin === "string" ? { origin: value.origin } : {}),
		...(typeof value.parentSession === "string" ? { parentSession: value.parentSession } : {}),
		...(typeof value.delegationDepth === "number" && Number.isFinite(value.delegationDepth)
			? { delegationDepth: value.delegationDepth }
			: {}),
	};
}

function asCachedSnapshot(value: unknown): ProjectionBackfillSnapshot | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return undefined;
	const values = value.values;
	if (values === undefined) return {};
	if (!isRecord(values)) return {};
	return { values };
}

/**
 * 从官方 boot Context 上摘 persistence / projection-cache。
 * hostEntry 不 import 整份 DSH Context 类型（utilityProcess CJS 包体 / 循环依赖），
 * 只认运行时服务形状；缺任一服务就跳过，不自己写 JSON。
 */
export function bindProjectionCacheBackfillDeps(
	ctx: unknown,
	log?: (message: string) => void,
): ProjectionCacheBackfillDeps | undefined {
	if (!isRecord(ctx)) return undefined;
	const persistence = ctx.sessionPersistence;
	const cache = ctx.sessionProjectionCache;
	if (!isRecord(persistence) || typeof persistence.list !== "function") return undefined;
	if (!isRecord(cache) || typeof cache.cachedSnapshot !== "function" || typeof cache.coldSnapshot !== "function") {
		return undefined;
	}
	const listFn = persistence.list.bind(persistence);
	const snapshotFn = cache.cachedSnapshot.bind(cache);
	const coldFn = cache.coldSnapshot.bind(cache);
	return {
		list: async () => {
			const items = await listFn();
			if (!Array.isArray(items)) return [];
			const metas: ProjectionBackfillMeta[] = [];
			for (const item of items) {
				const meta = asBackfillMeta(item);
				if (meta) metas.push(meta);
			}
			return metas;
		},
		cachedSnapshot: (meta) => asCachedSnapshot(snapshotFn(meta)),
		coldSnapshot: (sessionId) => Promise.resolve(coldFn(sessionId)),
		log,
	};
}

export async function backfillMissingProjectionTitles(
	deps: ProjectionCacheBackfillDeps,
): Promise<ProjectionCacheBackfillResult> {
	let metas: ProjectionBackfillMeta[];
	try {
		metas = await deps.list();
	} catch (error) {
		deps.log?.(`projection title backfill: list failed: ${String(error)}`);
		return { attempted: 0, failed: 0 };
	}
	let attempted = 0;
	let failed = 0;
	for (const meta of metas) {
		if (!isRootSessionMeta(meta)) continue;
		if (!shouldBackfillProjectionTitle(deps.cachedSnapshot(meta))) continue;
		attempted += 1;
		try {
			await deps.coldSnapshot(meta.id);
		} catch (error) {
			failed += 1;
			deps.log?.(`projection title backfill: coldSnapshot "${meta.id}" failed: ${String(error)}`);
		}
	}
	return { attempted, failed };
}
