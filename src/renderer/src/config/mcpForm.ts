/**
 * MCP 配置表单辅助：KEY=value 文本与对象互转、参数拆分。
 * 放独立模块是为了可单测，并避免 McpTab 继续变长。
 */

const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** 与主进程 mcpConfig.isMcpServerName 同一规则，避免渲染层 import 主进程模块。 */
export function isMcpServerName(name: string): boolean {
	const trimmed = name.trim();
	return trimmed.length > 0 && trimmed.length <= 64 && !/[\\/]/.test(trimmed) && SERVER_NAME_RE.test(trimmed);
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
