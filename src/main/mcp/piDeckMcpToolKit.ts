/** MCP 工具注册的公共外壳：严格参数、安全错误码、统一 structuredContent 信封。 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * 允许原样透出的领域错误码（命中 `error.message` 才返回，其余一律 operation-failed）。
 * 新增能力时在这里登记：未登记的异常文本、路径与堆栈不会回到客户端。
 */
export const PI_DECK_MCP_SAFE_ERRORS = new Set([
	"access-revoked",
	"project-not-authorized",
	"session-not-authorized",
	"session-not-running",
	"runtime-changed",
	"control-disabled",
	"history-unavailable",
	"history-too-large",
	"history-changed",
	"stale-cursor",
	"invalid-offset",
	"agent-not-found",
	"agent-not-deletable",
	"agent-write-disabled",
	"agent-patch-empty",
	"automation-task-not-found",
	"automation-run-not-found",
	"automation-write-disabled",
	"automation-patch-empty",
	"automation-invalid-schedule",
	"favorite-not-found",
	"favorite-write-disabled",
	"acp-disabled",
	"acp-tool-not-found",
	"session-not-acp",
	"session-write-disabled",
	"session-busy",
]);

/**
 * 注册一个 MCP 工具：入参严格校验（未声明字段直接拒绝）、授权前后各校验一次、
 * 输出统一为 `{ apiVersion: 1, data }`。
 *
 * 默认按只读标注；写工具必须显式声明 `write`——readOnlyHint 是客户端决定
 * 「要不要弹确认」的依据，把写工具标成只读会直接绕过用户预期。
 */
export function registerPiDeckMcpTool<S extends z.ZodRawShape>(server: McpServer, authorize: () => void, name: string, description: string, shape: S, run: (args: z.output<z.ZodObject<S>>) => unknown | Promise<unknown>, options?: { write?: boolean }): void {
	const schema = z.object(shape).strict();
	// MCP clients may omit arguments for a zero-argument tool, not only send {}；
	// 全部字段都可选的工具（如 favorites_list 的筛选参数）同样允许省略整个 arguments。
	const allFieldsOptional = Object.keys(shape).length === 0 || Object.values(shape).every((field) => field.isOptional?.() === true);
	const inputSchema = allFieldsOptional ? schema.optional() : schema;
	server.registerTool(
		name,
		{
			description,
			inputSchema,
			annotations: {
				readOnlyHint: !options?.write,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async (input: unknown): Promise<CallToolResult> => {
			try {
				authorize();
				const value = await run(schema.parse(input ?? {}));
				authorize();
				const structuredContent = { apiVersion: 1, data: value };
				return {
					content: [{ type: "text", text: JSON.stringify(structuredContent) }],
					structuredContent,
				};
			} catch (error) {
				const code = error instanceof Error && PI_DECK_MCP_SAFE_ERRORS.has(error.message) ? error.message : "operation-failed";
				return {
					isError: true,
					content: [{ type: "text", text: JSON.stringify({ code }) }],
				};
			}
		},
	);
}
