/**
 * 爱猹收权益代理（Cloudflare Worker）。
 *
 * 唯一职责：把桌面端的一次「查余额 / 扣 1 次」转成爱猹收的服务端调用。
 * 服务端 API Key 只存在于本 Worker 的环境变量里 —— Electron 客户端永远拿不到它。
 *
 * 一个路由（只接受 POST，只读 JSON）：
 * - POST /access   body { user_id }  → { access, remaining, purchaseUrl?, qrCodeUrl? }
 *
 * 不提供 /consume：这是纯打赏，不跟会话或用量绑定，平台侧的次数只作展示。
 *
 * 设计边界：
 * - 路由与上游地址都是常量，请求体里不接受任何 URL（否则就是开放代理）；
 * - entitlement_id、API Key 由环境变量注入，客户端无法指定权益；
 * - 上游响应只透传白名单字段，不整包回传（避免把内部标识漏给客户端）；
 * - 上游超时 10s；任何异常都按「失败」返回，不猜成功；
 * - 不记录 API Key、购买票据、用户 ID 到日志。
 *
 * 环境变量：
 *   WATCHA_API_KEY     爱猹收「产品服务端」Key（沙箱/正式各一把）
 *   WATCHA_ENTITLEMENT 该环境商品的 entitlement.id
 */

const UPSTREAM = "https://pay.watcha.cn";
const ACCESS_PATH = "/access";
const UPSTREAM_ATTEMPT_TIMEOUT_MS = 5_000;

/** 用户 ID 只允许 URL 安全字符：它会进购买票据，不允许任何分隔/注入字符。 */
const USER_ID_RE = /^[A-Za-z0-9._-]{6,80}$/;
function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

/** 只放行 https 与支付宝深链，其余协议一律丢弃（平台文档明确这两种）。 */
function safeUrl(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "alipays:") return undefined;
		return value;
	} catch {
		return undefined;
	}
}

async function readJson(request) {
	const raw = await request.text();
	if (raw.length > 4096) return null;
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * 调上游。跨境链路实测 8–11 秒且偶发失败，所以：
 * - 单个请求超时收紧到 6s，避免一次卡死拖满整个响应；
 * - 传输层失败重试一次（总预算 12s 内），成功响应不重试；
 * - 4xx/5xx 不重试：那是业务结果，重试只会放大问题。
 */
async function callUpstream(env, path, payload) {
	let lastError;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const response = await fetch(`${UPSTREAM}${path}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${env.WATCHA_API_KEY}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(UPSTREAM_ATTEMPT_TIMEOUT_MS),
			});
			let body = null;
			try {
				body = await response.json();
			} catch {
				body = null;
			}
			return { status: response.status, body };
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError ?? new Error("upstream unreachable");
}

async function handleAccess(env, request) {
	const body = await readJson(request);
	const userId = body?.user_id;
	if (typeof userId !== "string" || !USER_ID_RE.test(userId)) return json({ error: "invalid_user_id" }, 400);

	let result;
	try {
		result = await callUpstream(env, "/v1/entitlements/access", {
			entitlement_id: env.WATCHA_ENTITLEMENT,
			user_id: userId,
		});
	} catch {
		return json({ error: "upstream_unreachable" }, 502);
	}
	if (result.status !== 200 || !result.body) return json({ error: "upstream", status: result.status }, 502);

	const access = result.body.access;
	if (access !== "granted" && access !== "purchase_required" && access !== "unavailable") {
		return json({ error: "unknown_access" }, 502);
	}
	const purchase = result.body.purchase;
	return json({
		access,
		remaining: typeof result.body.entitlement?.remaining === "number" ? result.body.entitlement.remaining : 0,
		...(safeUrl(purchase?.url) ? { purchaseUrl: safeUrl(purchase.url) } : {}),
		...(safeUrl(purchase?.qr_code_url) ? { qrCodeUrl: safeUrl(purchase.qr_code_url) } : {}),
	});
}

export default {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		if (pathname === "/health") return json({ ok: true });
		if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
		if (pathname === ACCESS_PATH) return handleAccess(env, request);
		return json({ error: "not_found" }, 404);
	},
};
