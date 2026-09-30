/**
 * Web 服务访问 URL 拼接工具：处理 IPv6 方括号、token URL 编码与通配绑定回退。
 */

export function bracketIpv6Host(host: string): string {
	if (host.includes(":") && !host.startsWith("[")) {
		return `[${host}]`;
	}
	return host;
}

export function buildWebAccessUrl(
	host: string,
	port: number,
	token: string,
	requiresAuth: boolean,
): string {
	const displayHost = bracketIpv6Host(host);
	let url = `http://${displayHost}:${port}`;
	if (requiresAuth && token) {
		url += `?token=${encodeURIComponent(token)}`;
	}
	return url;
}

export function previewHostFromBinding(host: string): string {
	if (host === "0.0.0.0" || host === "::") {
		return "127.0.0.1";
	}
	return host;
}
