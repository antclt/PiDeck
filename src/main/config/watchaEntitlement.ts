/**
 * 爱猹收打赏主进程实现（「请作者喝咖啡」）。
 *
 * 只做一件事：查一次权益快照（POST ${WATCHA_EDGE_URL}/access，body { user_id }），
 * 拿到当次购买入口。**不扣减**——纯打赏，不跟会话或用量绑定。
 *
 * 边界：
 * - 服务端 API Key 在边缘代理里，本进程不持有任何平台密钥；
 * - URL 由常量拼装，渲染层不传地址（否则就是开放代理）；
 * - 超时 20s、响应 64KB 截断、只解析白名单字段；
 * - 失败返回错误码：不拦用户使用，但也不谎报成功；
 * - 结果缓存 5 分钟且并发合并：跨境链路慢，关于弹层一打开就预取，点进去就是现成的。
 *   票据有效期以分钟计（沙箱实测 20 分钟），5 分钟缓存不会拿到过期链接；
 *   到账轮询必须传 force=true 绕过缓存，否则永远看不到余额变化。
 */
import { WATCHA_ACCESS_PATH, WATCHA_EDGE_URL, WATCHA_MAX_BYTES, WATCHA_REQUEST_TIMEOUT_MS, type WatchaAccessResult, type WatchaAccessSnapshot, type WatchaErrorCode } from "../../shared/watcha";

/** 请求形状（与 usageProbeRequest 兼容；测试注入 stub）。 */
export type WatchaRequest = (url: string, init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string; timeoutMs: number; maxBytes: number }) => Promise<{ status: number; raw: string } | { error: "timeout" | "network" }>;

export type WatchaEntitlementDeps = {
	/** 稳定用户 ID（本机安装级；没有账号体系时唯一可行的主键）。 */
	resolveUserId: () => Promise<string>;
	/** HTTP 传输（默认 usageProbeRequest：走 Electron net，服从系统代理）。 */
	request: WatchaRequest;
	/** 端点覆盖（测试用；生产恒为 WATCHA_EDGE_URL）。 */
	baseUrl?: string;
	/** 快照缓存时长，默认 60s（测试注入 0 关缓存）。 */
	cacheTtlMs?: number;
	/** 时钟（测试注入）。 */
	now?: () => number;
};

/** 解析 /access 响应（纯函数，可单测）。未知状态视为 bad-response（失败关闭）。 */
export function parseWatchaAccessBody(body: unknown): WatchaAccessSnapshot | null {
	if (!body || typeof body !== "object") return null;
	const raw = body as Record<string, unknown>;
	const access = raw.access;
	if (access !== "granted" && access !== "purchase_required" && access !== "unavailable") return null;
	const remaining = typeof raw.remaining === "number" && Number.isFinite(raw.remaining) ? Math.max(0, Math.floor(raw.remaining)) : 0;
	const purchaseUrl = typeof raw.purchaseUrl === "string" && raw.purchaseUrl ? raw.purchaseUrl : undefined;
	const qrCodeUrl = typeof raw.qrCodeUrl === "string" && raw.qrCodeUrl ? raw.qrCodeUrl : undefined;
	return { access, remaining, ...(purchaseUrl ? { purchaseUrl } : {}), ...(qrCodeUrl ? { qrCodeUrl } : {}) };
}

export class WatchaEntitlementStore {
	private readonly deps: WatchaEntitlementDeps;
	private readonly baseUrl: string;
	private readonly cacheTtlMs: number;
	private readonly now: () => number;
	private cached: { snapshot: WatchaAccessSnapshot; at: number } | null = null;
	private inflight: Promise<WatchaAccessResult> | null = null;

	constructor(deps: WatchaEntitlementDeps) {
		this.deps = deps;
		this.baseUrl = (deps.baseUrl ?? WATCHA_EDGE_URL).replace(/\/+$/, "");
		this.cacheTtlMs = deps.cacheTtlMs ?? 5 * 60_000;
		this.now = deps.now ?? Date.now;
	}

	/**
	 * 查打赏快照（只读）。
	 * - force=false：命中缓存直接返回（弹窗打开/预取走这条，省一次跨境请求）；
	 * - force=true：跳过缓存（到账轮询必须用，否则读到的永远是旧余额）。
	 * 并发请求始终合并成一次，避免连点刷新打出多个跨境请求。
	 */
	async access(options?: { force?: boolean }): Promise<WatchaAccessResult> {
		if (!options?.force && this.cached && this.now() - this.cached.at < this.cacheTtlMs) {
			return { ok: true, snapshot: this.cached.snapshot };
		}
		if (this.inflight) return this.inflight;
		this.inflight = this.fetchAccess().finally(() => {
			this.inflight = null;
		});
		const result = await this.inflight;
		if (result.ok) this.cached = { snapshot: result.snapshot, at: this.now() };
		return result;
	}

	private async fetchAccess(): Promise<WatchaAccessResult> {
		const userId = await this.deps.resolveUserId();
		const response = await this.deps.request(this.baseUrl + WATCHA_ACCESS_PATH, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ user_id: userId }),
			timeoutMs: WATCHA_REQUEST_TIMEOUT_MS,
			maxBytes: WATCHA_MAX_BYTES,
		});
		if ("error" in response) return { ok: false, code: response.error as WatchaErrorCode };
		if (response.status !== 200) return { ok: false, code: "http", detail: String(response.status) };
		let body: unknown;
		try {
			body = JSON.parse(response.raw) as unknown;
		} catch {
			return { ok: false, code: "bad-response" };
		}
		const snapshot = parseWatchaAccessBody(body);
		if (!snapshot) return { ok: false, code: "bad-response" };
		return { ok: true, snapshot };
	}
}
