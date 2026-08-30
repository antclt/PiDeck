/**
 * acp_delegate（billion-context-pi 插件）子代理条目推导。
 *
 * billion-context-pi 的 acp_delegate / acp_delegate_wait / acp_delegate_cancel 是
 * 独立于 @tintinweb/pi-subagents 的委托机制：独立 spawn pi 子进程运行，不写
 * subagents:record、不发插件事件，自带的运行状态 widget 仅 TUI 模式激活
 * （PiDeck 为 RPC 模式收不到）。父会话文件里唯一的痕迹是三类条目：
 * - assistant 消息里的 toolCall（name=acp_delegate*，arguments 携带 agent/task/runId）；
 * - role=toolResult 的派发确认文本（含 runId `del_xxx`，把 runId 关联到 toolCallId）；
 * - role=user 的终态系统通知（"[acp_delegate completed]" / "[acp_delegate FAILED ⚠️]"，
 *   失败时错误摘录嵌在 Output: ~~~ 围栏块中）。
 *
 * 本模块把这三类条目推导成 PiSubagentEntry（source "toolcall"），作为 record/桥接
 * 之外的第三源兜底（hook 注释一直承诺的「工具调用推导」）。条目 id 固定用派发
 * toolCallId（acp_delegate_xxx），与桥接扩展落盘的 record/锚点 id 对齐；runId 只
 * 用于把终态通知/取消关联回派发条目。
 *
 * @module acpDelegateSubagents
 */

import type { PiSubagentEntry, PiSubagentStatus } from "../../shared/types";

const ACP_DELEGATE_TOOL = "acp_delegate";
const ACP_CANCEL_TOOL = "acp_delegate_cancel";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TERMINAL_STATUSES = new Set<PiSubagentStatus>([
	"completed", "error", "stopped", "aborted", "steered",
]);

/** content 归一化为纯文本（string 直返；数组只拼接 text 项，工具调用/思考块忽略）。 */
export function extractEntryText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const item of content) {
		if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
			out += item.text;
		}
	}
	return out;
}

/** 派发确认 / 系统通知文本中的 runId（形如 runId `del_xxx`）。 */
export function extractAcpRunId(text: string): string | undefined {
	const match = /runId `([^`]+)`/.exec(text);
	return match?.[1];
}

/** FAILED 通知中的错误摘录（Output: ~~~ 围栏块）；截断 2000 字符与 record 预览对齐。 */
export function extractAcpErrorExcerpt(text: string): string | undefined {
	const match = /Output:\s*\n?~~~\n?([\s\S]*?)~~~/.exec(text);
	const excerpt = match?.[1]?.trim();
	return excerpt ? excerpt.slice(0, 2000) : undefined;
}

/**
 * 从会话文件原始条目（已 JSON.parse 的 JSONL 行）推导 acp_delegate 子代理条目。
 *
 * 纯函数：不关心分支/压缩等索引概念，按文件顺序扫（委托审计语义与 record 读取
 * 一致：不随对话分支回退丢失）。损坏条目由调用方过滤；字段缺失的条目跳过。
 */
export function deriveAcpDelegateEntries(
	rawEntries: readonly unknown[],
): PiSubagentEntry[] {
	const byId = new Map<string, PiSubagentEntry>();
	// runId → 派发 toolCallId：终态通知/取消只带 runId，需要这层反查
	const entryIdByRunId = new Map<string, string>();

	for (const raw of rawEntries) {
		if (!isRecord(raw) || raw.type !== "message" || !isRecord(raw.message)) continue;
		const message = raw.message;
		const timestampMs = typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : NaN;
		const role = typeof message.role === "string" ? message.role : "";

		if (role === "assistant" && Array.isArray(message.content)) {
			for (const item of message.content) {
				if (!isRecord(item) || item.type !== "toolCall") continue;
				const toolName = typeof item.name === "string" ? item.name : "";
				const toolCallId = typeof item.id === "string" ? item.id : "";
				if (!toolCallId) continue;
				if (toolName === ACP_DELEGATE_TOOL) {
					// 幂等：同 id 重放（fork 重放等）保留首条
					if (byId.has(toolCallId)) continue;
					const args = isRecord(item.arguments) ? item.arguments : {};
					byId.set(toolCallId, {
						id: toolCallId,
						type: typeof args.agent === "string" && args.agent ? args.agent : ACP_DELEGATE_TOOL,
						description: typeof args.task === "string" ? args.task : "",
						status: "running",
						startedAt: Number.isFinite(timestampMs) ? timestampMs : undefined,
						source: "toolcall",
						via: "acp-delegate",
					});
				} else if (toolName === ACP_CANCEL_TOOL) {
					const args = isRecord(item.arguments) ? item.arguments : {};
					const runId = typeof args.runId === "string" ? args.runId : "";
					const entryId = runId ? entryIdByRunId.get(runId) : undefined;
					const entry = entryId ? byId.get(entryId) : undefined;
					if (!entry || TERMINAL_STATUSES.has(entry.status)) continue;
					entry.status = "stopped";
					if (Number.isFinite(timestampMs)) entry.completedAt = timestampMs;
				}
			}
			continue;
		}

		if (role === "toolResult" && message.toolName === ACP_DELEGATE_TOOL
			&& typeof message.toolCallId === "string") {
			// 派发确认（后台运行，非终态）：只登记 runId 关联
			const runId = extractAcpRunId(extractEntryText(message.content));
			if (runId) entryIdByRunId.set(runId, message.toolCallId);
			continue;
		}

		if (role === "user") {
			const text = extractEntryText(message.content);
			// 终态系统通知是 acp 委托唯一的可靠完成信号（插件保证失败必达）
			const isCompleted = text.startsWith("[acp_delegate completed]");
			const isFailed = text.startsWith("[acp_delegate FAILED");
			if (!isCompleted && !isFailed) continue;
			const runId = extractAcpRunId(text);
			const entryId = runId ? entryIdByRunId.get(runId) : undefined;
			const entry = entryId ? byId.get(entryId) : undefined;
			if (!entry || TERMINAL_STATUSES.has(entry.status)) continue;
			entry.status = isFailed ? "error" : "completed";
			if (Number.isFinite(timestampMs)) entry.completedAt = timestampMs;
			if (isFailed) {
				const excerpt = extractAcpErrorExcerpt(text);
				if (excerpt) entry.error = excerpt;
			}
		}
	}

	return [...byId.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/**
 * record/锚点（权威）与 acp 推导条目合并：acp 条目 id（acp_delegate_*）与
 * pi-subagents 插件的 agent id 天然不相交，合并只影响 acp 自身。
 *
 * 同 id 时默认 record 优先；唯一例外：record 是「stopped 且无任何结果/错误文本」
 * ——即读取侧由残留 start 锚点合成的空壳——而推导条目已从终态通知拿到真实结局时，
 * 推导更准确，以推导为准。
 */
export function mergeSubagentSources(
	records: PiSubagentEntry[],
	derived: PiSubagentEntry[],
): PiSubagentEntry[] {
	const byId = new Map(records.map((record) => [record.id, record]));
	for (const entry of derived) {
		const existing = byId.get(entry.id);
		if (!existing) {
			byId.set(entry.id, entry);
			continue;
		}
		const isBareStoppedShell = existing.status === "stopped"
			&& existing.result == null && existing.error == null;
		if (isBareStoppedShell && TERMINAL_STATUSES.has(entry.status)) {
			byId.set(entry.id, entry);
		}
	}
	return [...byId.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/**
 * 无活 runtime 时清理推导条目残留的 running：终态通知没写进文件（进程被杀/崩溃）
 * 的委托在会话文件里永远是 running，历史会话里会误导为仍在运行。降级为 stopped，
 * 与 start 锚点残留合成 stopped 同语义；活会话保持 running（后续通知/桥接会覆盖）。
 */
export function downgradeStaleRunning(entries: PiSubagentEntry[]): PiSubagentEntry[] {
	let changed = false;
	const next = entries.map((entry) => {
		if (entry.source === "toolcall" && (entry.status === "running" || entry.status === "queued")) {
			changed = true;
			return { ...entry, status: "stopped" as const };
		}
		return entry;
	});
	return changed ? next : entries;
}
