/**
 * DSH provider API 密钥引用派生（纯函数，可单测）。
 *
 * 对齐 dsh-web 模型页的派生规则：provider 的密钥 ref 优先用 profile 里显式声明的
 * apiKeyEnv；未声明时按 <ROUTE>_API_KEY 派生（路由 id 转大写、连字符转下划线）。
 * 页面不询问环境变量名——密钥经 credentials.set 写入该 ref 之下。
 */

/** 从 provider profile 推导 API 密钥 ref。 */
export function credentialRefFor(profile: Record<string, unknown> | undefined, routeId: string): string {
	const explicit = typeof profile?.apiKeyEnv === "string" && profile.apiKeyEnv.trim() ? profile.apiKeyEnv.trim() : "";
	if (explicit) return explicit;
	return `${routeId.toUpperCase().replaceAll("-", "_")}_API_KEY`;
}
