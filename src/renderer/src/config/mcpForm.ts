/**
 * MCP 配置表单辅助：KEY=value 文本与对象互转、参数拆分。
 * 放独立模块是为了可单测，并避免 McpTab 继续变长。
 */

import type { McpConfigFile, McpConfigLayerKind, McpConfigSnapshot, McpServerListItem } from "../../../shared/types/mcp";

const SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** 与主进程 mcpConfig.isMcpServerName 同一规则，避免渲染层 import 主进程模块。 */
export function isMcpServerName(name: string): boolean {
	const trimmed = name.trim();
	return trimmed.length > 0 && !/[\\/]/.test(trimmed) && SERVER_NAME_RE.test(trimmed);
}

export function argsToText(args: string[] | undefined): string {
	return (args ?? []).join(" ");
}

export function textToArgs(text: string): string[] | undefined {
	const parts = text.trim().split(/\s+/).filter(Boolean);
	return parts.length > 0 ? parts : undefined;
}

/** 把 env/headers 编成每行 KEY=value；空对象返回空串。 */
export function recordToText(record: Record<string, string> | undefined): string {
	if (!record) return "";
	return Object.entries(record)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n");
}

/** 浅合并丢掉 undefined，避免覆盖层把下层 command/url 冲空。 */
export function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) (out as Record<string, unknown>)[key] = item;
	}
	return out;
}

/**
 * 主进程已按优先级合并六层；本函数只把本地可写草稿叠回显示列表，
 * 让未保存编辑立即生效（项目层不再参与：MCP 页固定全局作用域）。
 */
export function buildMcpDisplayServers(snapshot: McpConfigSnapshot, writable: McpConfigFile): McpServerListItem[] {
	const writableServers = writable.mcpServers ?? {};
	const writableScope: McpConfigLayerKind = snapshot.layers.find((layer) => layer.path === snapshot.writablePath)?.kind ?? "pi-agent";
	const seen = new Set<string>();
	const items = snapshot.servers.map((item) => {
		seen.add(item.name);
		const overlay = writableServers[item.name];
		if (!overlay) {
			// 草稿里没有但磁盘可写层有 = 用户在本层删了它，保存后才生效：标记待删除。
			// 下层（如全局）还有同名定义时改标「回退为继承」——保存后条目不会消失，只是换层。
			const pendingDelete = Boolean(snapshot.writableFile.mcpServers?.[item.name]);
			if (!pendingDelete) return item;
			return { ...item, pendingDelete: true, revertsToInherited: snapshot.lowerLayerNames.includes(item.name) };
		}
		// pi 语义：同名条目由可写层**整体替换**，不是字段级合并。
		return {
			...item,
			definition: overlay,
			originPath: snapshot.writablePath,
			originScope: writableScope,
			ownedByWritable: true,
		};
	});
	for (const [name, definition] of Object.entries(writableServers)) {
		if (seen.has(name)) continue;
		items.push({
			name,
			definition,
			originPath: snapshot.writablePath,
			originScope: writableScope,
			ownedByWritable: true,
		});
	}
	return items.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * 解析 KEY=value 行。空行忽略；没有 `=` 的行当作值为空的 key。
 * 业务规则：等号后整段都是 value（允许再含 `=`）。
 */
export function textToRecord(text: string): Record<string, string> | undefined {
	const out: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const eq = line.indexOf("=");
		const key = (eq === -1 ? line : line.slice(0, eq)).trim();
		if (!key) continue;
		out[key] = eq === -1 ? "" : line.slice(eq + 1);
	}
	return Object.keys(out).length > 0 ? out : undefined;
}
