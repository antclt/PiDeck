/**
 * pideck-projection-cache-bridge：主进程经 fetch 桥调用官方 coldSnapshot 回写。
 *
 * 投影缓存服务只活在 utilityProcess 的 host Context 里，主进程不能直接
 * `ctx.sessionProjectionCache.coldSnapshot`。这里复用 plugin/command 桥的
 * POST { method, params } → { ok, value|error } 信封，只暴露 backfill。
 * 不手写 session_projcache.json，不 attach 会话。
 */

import {
	backfillMissingProjectionTitles,
	bindProjectionCacheBackfillDeps,
	type ProjectionCacheBackfillResult,
} from "./dshProjectionCacheBackfill";

/** 桥 RPC 路径（hostEntry fetch 路由拦截）。 */
export const PIDECK_PROJECTION_CACHE_BRIDGE_PATH = "/pideck-projection/rpc";

type BridgeResult<T> = { ok: true; value: T } | { ok: false; error: string };

type BridgeCtx = {
	sessionPersistence?: unknown;
	sessionProjectionCache?: unknown;
};

/** 分发：目前只有 backfill（历史 + 新会话共用同一决策）。 */
export async function projectionCacheBridgeRpc(
	ctx: unknown,
	method: unknown,
): Promise<BridgeResult<ProjectionCacheBackfillResult>> {
	if (method !== "backfill") {
		return { ok: false, error: `unknown projection cache method: ${String(method)}` };
	}
	const deps = bindProjectionCacheBackfillDeps(ctx, (message) => {
		console.log(`[dsh-projection-bridge] ${message}`);
	});
	if (!deps) {
		return { ok: false, error: "session projection cache is not mounted" };
	}
	const value = await backfillMissingProjectionTitles(deps);
	return { ok: true, value };
}

/** hostEntry fetch 路由：POST JSON { method }。 */
export async function handleProjectionCacheBridgeFetch(
	ctx: BridgeCtx,
	init?: { method?: string; body?: string },
): Promise<Response> {
	const result = await (async (): Promise<BridgeResult<ProjectionCacheBackfillResult>> => {
		if ((init?.method ?? "GET").toUpperCase() !== "POST") {
			return { ok: false, error: "projection cache bridge requires POST" };
		}
		let method: unknown;
		if (init?.body !== undefined && init.body !== "") {
			try {
				const parsed: unknown = JSON.parse(init.body);
				if (!parsed || typeof parsed !== "object") {
					return { ok: false, error: "invalid JSON body" };
				}
				method = (parsed as { method?: unknown }).method;
			} catch {
				return { ok: false, error: "invalid JSON body" };
			}
		}
		return projectionCacheBridgeRpc(ctx, method);
	})();
	return new Response(JSON.stringify(result), {
		status: result.ok ? 200 : 400,
		headers: { "content-type": "application/json" },
	});
}
