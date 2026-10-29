/**
 * 爱猹收打赏代理 —— 自建 Node 版（与 worker.mjs 同一份契约）。
 *
 * 为什么有这一版：Cloudflare 边缘到 pay.watcha.cn 实测 5–12 秒、约 2/5 超时，
 * 放到国内/香港 VPS 上跑这个 60 行服务就能把链路拉回正常水平。
 *
 * 用法：
 *   WATCHA_API_KEY=xxx WATCHA_ENTITLEMENT=ent_xxx PORT=8787 node server.mjs
 *
 * 只提供 POST /access 与 GET /health；不扣次数，不碰模型。
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8787);
const UPSTREAM = "https://pay.watcha.cn";
const API_KEY = process.env.WATCHA_API_KEY ?? "";
const ENTITLEMENT = process.env.WATCHA_ENTITLEMENT ?? "";
const ATTEMPT_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 4096;

/** 用户 ID 只允许 URL 安全字符：它会进购买票据。 */
const USER_ID_RE = /^[A-Za-z0-9._-]{6,80}$/;

function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(payload);
}

/** 只放行 https 与支付宝深链。 */
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

async function readJson(req) {
	let raw = "";
	for await (const chunk of req) {
		raw += chunk;
		if (raw.length > MAX_BODY_BYTES) return null;
	}
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

/** 上游调用：单次 5s 超时，传输层失败重试一次；4xx/5xx 不重试。 */
async function callUpstream(path, payload) {
	let lastError;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const response = await fetch(`${UPSTREAM}${path}`, {
				method: "POST",
				headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
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

async function handleAccess(req, res) {
	const body = await readJson(req);
	const userId = body?.user_id;
	if (typeof userId !== "string" || !USER_ID_RE.test(userId)) return json(res, 400, { error: "invalid_user_id" });

	let result;
	try {
		result = await callUpstream("/v1/entitlements/access", { entitlement_id: ENTITLEMENT, user_id: userId });
	} catch {
		return json(res, 502, { error: "upstream_unreachable" });
	}
	if (result.status !== 200 || !result.body) return json(res, 502, { error: "upstream", status: result.status });

	const access = result.body.access;
	if (access !== "granted" && access !== "purchase_required" && access !== "unavailable") return json(res, 502, { error: "unknown_access" });
	const purchase = result.body.purchase;
	return json(res, 200, {
		access,
		remaining: typeof result.body.entitlement?.remaining === "number" ? result.body.entitlement.remaining : 0,
		...(safeUrl(purchase?.url) ? { purchaseUrl: purchase.url } : {}),
		...(safeUrl(purchase?.qr_code_url) ? { qrCodeUrl: purchase.qr_code_url } : {}),
	});
}

if (!API_KEY || !ENTITLEMENT) {
	console.error("缺少 WATCHA_API_KEY 或 WATCHA_ENTITLEMENT，拒绝启动。");
	process.exit(1);
}

createServer((req, res) => {
	const { pathname } = new URL(req.url ?? "/", "http://localhost");
	if (req.method === "GET" && pathname === "/health") return json(res, 200, { ok: true });
	if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
	if (pathname === "/access") {
		void handleAccess(req, res).catch(() => json(res, 500, { error: "internal" }));
		return;
	}
	return json(res, 404, { error: "not_found" });
}).listen(PORT, () => {
	console.log(`watcha-edge (node) listening on :${PORT}`);
});
