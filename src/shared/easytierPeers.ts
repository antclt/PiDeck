/**
 * EasyTier 托管网络的输入清洗规则（纯函数、无依赖，便于单测直接导入）。
 * 与设置契约分离：这里只关心「什么样的字符串能安全写进 TOML / 传给 core」。
 */

/** EasyTier 支持的对等节点协议；用于清洗共享节点地址。 */
export const EASYTIER_PEER_PROTOCOLS = ["tcp", "udp", "ws", "wss", "wg", "quic", "faketcp"] as const;

/** 单条共享节点地址的合法形态：协议 + 主机（IPv4/域名/带方括号的 IPv6）+ 端口。 */
const EASYTIER_PEER_PATTERN = /^(tcp|udp|ws|wss|wg|quic|faketcp):\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252}):(\d{1,5})$/;

/**
 * 清洗网络名称：去首尾空白，拒绝控制字符与超长串；允许中文（EasyTier 明确支持）。
 * 空串表示未配置托管网络。
 */
export function sanitizeEasyTierNetworkName(value: unknown): string {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 64) return "";
	return /[\u0000-\u001f\u007f]/.test(trimmed) ? "" : trimmed;
}

/** 清洗网络密钥：去首尾空白，拒绝控制字符，长度 ≤128；空串表示未配置。 */
export function sanitizeEasyTierNetworkSecret(value: unknown): string {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 128) return "";
	return /[\u0000-\u001f\u007f]/.test(trimmed) ? "" : trimmed;
}

/**
 * 清洗共享节点列表：逐条 trim、去重、最多 16 条；缺协议时按 tcp 补全，
 * 非法条目直接丢弃（不阻塞其余有效节点）。返回值始终为新数组。
 */
export function sanitizeEasyTierPeers(value: unknown): string[] {
	const source = Array.isArray(value) ? value : [];
	const seen = new Set<string>();
	const peers: string[] = [];
	for (const item of source) {
		if (typeof item !== "string") continue;
		let entry = item.trim();
		if (!entry) continue;
		if (!entry.includes("://")) entry = "tcp://" + entry;
		const match = EASYTIER_PEER_PATTERN.exec(entry);
		if (!match) continue;
		const port = Number(match[3]);
		if (port < 1 || port > 65535) continue;
		if (seen.has(entry)) continue;
		seen.add(entry);
		peers.push(entry);
		if (peers.length >= 16) break;
	}
	return peers;
}
