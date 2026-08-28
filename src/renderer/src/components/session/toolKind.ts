/**
 * Classify tool sources for the timeline badge.
 *
 * A bare `server_tool` name is intentionally not treated as MCP: pi-mcp-adapter
 * uses that shape for direct tools by default, but ordinary extensions can use
 * the same shape. Only the reserved `mcp` and `mcp__...` namespaces are
 * authoritative from the tool name alone.
 */
export type ToolKind = "mcp-proxy" | "mcp-direct" | "builtin" | "extension";

const BUILT_IN_TOOLS = new Set(["bash", "edit", "find", "grep", "ls", "read", "write"]);
const MCP_DIRECT_PREFIX = "mcp__";

/** Return the most specific source classification available from a tool name. */
export function getToolKind(toolName: string): ToolKind {
	const key = toolName.toLowerCase();
	if (key === "mcp") return "mcp-proxy";
	if (key.startsWith(MCP_DIRECT_PREFIX) && key.length > MCP_DIRECT_PREFIX.length) return "mcp-direct";
	if (BUILT_IN_TOOLS.has(key)) return "builtin";
	return "extension";
}

/** Return a source badge only when the name carries an authoritative MCP marker. */
export function getToolKindLabel(toolName: string): string {
	const kind = getToolKind(toolName);
	return kind === "mcp-proxy" || kind === "mcp-direct" ? "MCP" : "";
}
