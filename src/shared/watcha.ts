/**
 * 爱猹收（watcha）「请作者喝咖啡」按次付费共享契约。
 *
 * 钱流：用户 → 爱猹收 → 我们；用户买「次数包」，每次新会话扣 1 次。
 * 平台文档：https://pay.watcha.cn/agent.md
 *
 * 关键点：`/v1/entitlements/*` 只认服务端 API Key，**不能**放进 Electron 客户端，
 * 所以桌面端只调我们自己的边缘代理（见 deploy/watcha-edge/worker.mjs），
 * 由它代持 Key 并只透传白名单字段。本文件只放契约，不放任何密钥。
 */

/** 边缘代理地址（部署 worker 后若换域名，只改这一处）。 */
export const WATCHA_EDGE_URL = "https://pideck-pay.caoayu.top";

/** 查询余额 / 购买入口。 */
export const WATCHA_ACCESS_PATH = "/access";

/** 单次请求超时（代理内部最多重试两次、每次 5s，客户端留足余量）。 */
export const WATCHA_REQUEST_TIMEOUT_MS = 20_000;

/** 支付码缓存时长：5 分钟内重复打开弹窗复用同一张码，过期自动重取。 */
export const WATCHA_QR_CACHE_MS = 5 * 60 * 1000;

/** 响应体上界（正常响应不足 1KB，超过即视为异常）。 */
export const WATCHA_MAX_BYTES = 64 * 1024;

/**
 * 权益状态：
 * - granted：已经支持过（remaining 是累计支持的次数）；
 * - purchase_required：还没支持过，响应里有购买入口；
 * - unavailable：商品下架或渠道异常（失败关闭用，不拦截使用）。
 *
 * 注意：按次扣减已移除——这是纯打赏，不跟会话或用量绑定，remaining 只作展示。
 */
export type WatchaAccessState = "granted" | "purchase_required" | "unavailable";

/** 一次余额快照（`remaining` 只是快照，真实扣减以 consume 的返回为准）。 */
export type WatchaAccessSnapshot = {
	access: WatchaAccessState;
	remaining: number;
	/** 当次购买链接（短期票据，不持久化）。 */
	purchaseUrl?: string;
	/** 购买页二维码图片地址（可选）。 */
	qrCodeUrl?: string;
};

/** 失败原因码（主进程不带 i18n，渲染层按码翻译）。 */
export type WatchaErrorCode = "not-configured" | "timeout" | "network" | "http" | "bad-response";

export type WatchaAccessResult = { ok: true; snapshot: WatchaAccessSnapshot } | { ok: false; code: WatchaErrorCode; detail?: string };
