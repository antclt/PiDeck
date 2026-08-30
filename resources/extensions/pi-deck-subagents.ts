/**
 * PiDeck Subagents Bridge Extension
 *
 * 订阅 @tintinweb/pi-subagents 插件的生命周期事件，累积快照，经 setWidget 推
 * 送给 PiDeck 渲染层。桥接失效不影响主功能（面板回落为 record + 工具调用推导）。
 *
 * 另桥接 billion-context-pi 的 acp_delegate 委托链（独立 spawn 子进程，不发插件
 * 事件、不落 record、运行状态 widget 仅 TUI 模式激活）：监听工具执行事件与终态
 * 系统通知，并入同一快照；派发即落 start 锚点、终态落 subagents:record，读取侧
 * （SessionHistoryReader）与 pi-subagents 数据同通道复用。
 *
 * @packageDocumentation
 */

/* ------------------------------------------------------------------ */
/* 纯函数快照累积器（可独立单测）                                      */
/* ------------------------------------------------------------------ */

type AgentSnapshot = {
	id: string;
	type: string;
	description: string;
	status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
	toolUses: number;
	tokens: number;
	startedAt: number;
	/** 终态时间：completed/failed payload 无绝对时间，用 startedAt + durationMs 换算（缺失时退化为事件到达时刻）。 */
	completedAt?: number;
	/** 终态结果预览：事件 payload 携带的 result/error 文本，截断控制 widget 体积；完整文本走 record（会话文件）。 */
	result?: string;
	error?: string;
	/** 产出来源通道：acp-delegate = billion-context-pi 的 acp_delegate 委托链。 */
	via?: "acp-delegate";
};

type SnapshotState = Map<string, AgentSnapshot>;

function cloneState(state: SnapshotState): SnapshotState {
	return new Map(state);
}

const VALID_STATUSES = new Set([
	"queued", "running", "completed", "steered", "aborted", "stopped", "error",
]);

function safeString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function safeNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 将插件事件 payload 收窄为快照所需字段；字段缺失时降级为默认值。 */
function extractFields(data: unknown): Partial<AgentSnapshot> & { durationMs?: number } {
	if (!data || typeof data !== "object") return {};
	const d = data as Record<string, unknown>;
	return {
		id: safeString(d.id),
		type: safeString(d.type),
		description: safeString(d.description),
		status: VALID_STATUSES.has(String(d.status ?? ""))
			? String(d.status ?? "") as AgentSnapshot["status"]
			: undefined,
		toolUses: safeNumber(d.toolUses),
		tokens: safeNumber(d.tokens),
		startedAt: safeNumber(d.startedAt),
		// completed/failed 的 payload 只带真实运行时长（durationMs），不带绝对完成时刻
		durationMs: typeof d.durationMs === "number" && Number.isFinite(d.durationMs) && d.durationMs > 0
			? d.durationMs
			: undefined,
		// 结果/错误预览截断：widget 每次事件全量推送快照 JSON，全文可能几十 KB；面板预览 2000 字符足够，完整文本由 record（会话文件）承载
		result: typeof d.result === "string" && d.result ? d.result.slice(0, 2000) : undefined,
		error: typeof d.error === "string" && d.error ? d.error.slice(0, 2000) : undefined,
	};
}

/** 终态时间推导：优先 startedAt + 插件真实时长 durationMs（桥接 startedAt 是事件到达近似值，
 *  加上真实时长可消除 created 事件传播延迟误差）；缺失时退化为终态事件到达时刻。 */
function resolveCompletedAt(startedAt: number | undefined, durationMs: number | undefined): number {
	if (startedAt && durationMs) return startedAt + durationMs;
	return Date.now();
}

export function reduceSnapshot(
	state: SnapshotState,
	eventName: string,
	data: unknown,
): { state: SnapshotState; changed: boolean } {
	switch (eventName) {
		case "subagents:created": {
			const fields = extractFields(data);
			if (!fields.id) return { state, changed: false };
			const existing = state.get(fields.id);
			if (existing) return { state, changed: false }; // 幂等
			const next = cloneState(state);
			next.set(fields.id, {
				id: fields.id,
				type: fields.type ?? "",
				description: fields.description ?? "",
				status: "queued",
				toolUses: fields.toolUses ?? 0,
				tokens: fields.tokens ?? 0,
				startedAt: fields.startedAt || Date.now(),

			});
			return { state: next, changed: true };
		}
		case "subagents:started": {
			const fields = extractFields(data);
			if (!fields.id) return { state, changed: false };
			const existing = state.get(fields.id);
			if (!existing) return { state, changed: false };
			if (existing.status === "running") return { state, changed: false };
			const next = cloneState(state);
			next.set(fields.id, { ...existing, status: "running" });
			return { state: next, changed: true };
		}
		case "subagents:completed":
		case "subagents:failed": {
			const fields = extractFields(data);
			if (!fields.id) return { state, changed: false };
			const existing = state.get(fields.id);
			// 终态优先采用事件 payload 里的真实 status（插件在 payload 中携带 record.status）；
			// 缺失时才按事件名兜底。否则 steered/stopped/aborted 会被错误折叠成 completed/error。
			const payloadTerminal = fields.status === "completed"
				|| fields.status === "error"
				|| fields.status === "stopped"
				|| fields.status === "aborted"
				|| fields.status === "steered";
			const terminalStatus = payloadTerminal
				? (fields.status as AgentSnapshot["status"])
				: eventName === "subagents:failed"
					? "error"
					: "completed";
			// created/started 事件丢失（桥接晚加载）时直接 upsert：终态事件自携全部展示字段，
			// 不入快照会让该子代理在面板彻底消失。
			if (!existing) {
				const next = cloneState(state);
				next.set(fields.id, {
					id: fields.id,
					type: fields.type ?? "",
					description: fields.description ?? "",
					status: terminalStatus,
					toolUses: fields.toolUses ?? 0,
					tokens: fields.tokens ?? 0,
					startedAt: fields.startedAt || Date.now(),
					completedAt: resolveCompletedAt(fields.startedAt || Date.now(), fields.durationMs),
					result: fields.result,
					error: fields.error,
				});
				return { state: next, changed: true };
			}
			if (existing.status === terminalStatus) return { state, changed: false };
			const next = cloneState(state);
			next.set(fields.id, {
				...existing,
				status: terminalStatus,
				toolUses: fields.toolUses !== undefined ? fields.toolUses : existing.toolUses,
				tokens: fields.tokens !== undefined ? fields.tokens : existing.tokens,
				completedAt: resolveCompletedAt(existing.startedAt, fields.durationMs),
				result: fields.result ?? existing.result,
				error: fields.error ?? existing.error,
			});
			return { state: next, changed: true };
		}
		case "subagents:steered": {
			const fields = extractFields(data);
			if (!fields.id) return { state, changed: false };
			const existing = state.get(fields.id);
			if (!existing) return { state, changed: false };
			if (existing.status === "steered") return { state, changed: false };
			const next = cloneState(state);
			next.set(fields.id, { ...existing, status: "steered" });
			return { state: next, changed: true };
		}
		default:
			// 未知事件忽略
			return { state, changed: false };
	}
}

/* ------------------------------------------------------------------ */
/* acp_delegate（billion-context-pi）桥接                               */
/* ------------------------------------------------------------------ */

const ACP_DELEGATE_TOOL = "acp_delegate";
const ACP_CANCEL_TOOL = "acp_delegate_cancel";
const ACP_VIA = "acp-delegate" as const;

/** 派发确认 / 终态通知文本中的 runId（形如 runId `del_xxx`）。 */
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

function extractTextItems(items: unknown[]): string {
	let out = "";
	for (const item of items) {
		if (item && typeof item === "object" && (item as Record<string, unknown>).type === "text") {
			const text = (item as Record<string, unknown>).text;
			if (typeof text === "string") out += text;
		}
	}
	return out;
}

/** tool_execution_end 的 result（AgentToolResult | string | 文本数组）归一化为文本。 */
export function extractToolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (Array.isArray(result)) return extractTextItems(result);
	if (result && typeof result === "object") {
		const content = (result as Record<string, unknown>).content;
		if (Array.isArray(content)) return extractTextItems(content);
	}
	return "";
}

function isAcpTerminalStatus(status: AgentSnapshot["status"]): boolean {
	return status !== "queued" && status !== "running";
}

/**
 * 工具执行事件 → acp 委托快照条目（与插件快照共用同一 AgentSnapshot 状态集合，
 * 条目 id 固定为派发 toolCallId，与主进程推导/record 落盘对齐）。
 *
 * - start(acp_delegate)：running；幂等。
 * - start(acp_delegate_cancel)：runId 反查条目 → stopped（end 事件不带 args，
 *   取消意图在 start 已明确，容忍取消失败误报终态的边缘场景）。
 * - end(acp_delegate)：从结果文本提取 runId 记入反查表（派发 ≠ 终态，状态不变）。
 */
export function reduceAcpToolEvent(
	state: SnapshotState,
	runIds: ReadonlyMap<string, string>,
	eventName: string,
	data: unknown,
	now: number,
): { state: SnapshotState; runIds: Map<string, string>; changed: boolean } {
	if (!data || typeof data !== "object") return { state, runIds, changed: false };
	const event = data as Record<string, unknown>;
	const toolName = typeof event.toolName === "string" ? event.toolName : "";
	const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
	if (!toolCallId) return { state, runIds, changed: false };
	const args = event.args && typeof event.args === "object"
		? event.args as Record<string, unknown>
		: {};

	if (eventName === "tool_execution_start" && toolName === ACP_DELEGATE_TOOL) {
		if (state.has(toolCallId)) return { state, runIds, changed: false };
		const next = cloneState(state);
		next.set(toolCallId, {
			id: toolCallId,
			type: typeof args.agent === "string" && args.agent ? args.agent : ACP_DELEGATE_TOOL,
			description: typeof args.task === "string" ? args.task : "",
			status: "running",
			toolUses: 0,
			tokens: 0,
			startedAt: now,
			via: ACP_VIA,
		});
		return { state: next, runIds, changed: true };
	}

	if (eventName === "tool_execution_start" && toolName === ACP_CANCEL_TOOL) {
		const runId = typeof args.runId === "string" ? args.runId : "";
		const entryId = runId ? runIds.get(runId) : undefined;
		if (!entryId) return { state, runIds, changed: false };
		const existing = state.get(entryId);
		if (!existing || isAcpTerminalStatus(existing.status)) return { state, runIds, changed: false };
		const next = cloneState(state);
		next.set(entryId, { ...existing, status: "stopped", completedAt: now });
		return { state: next, runIds, changed: true };
	}

	if (eventName === "tool_execution_end" && toolName === ACP_DELEGATE_TOOL) {
		const runId = extractAcpRunId(extractToolResultText(event.result));
		if (!runId) return { state, runIds, changed: false };
		const nextRunIds = new Map(runIds);
		nextRunIds.set(runId, toolCallId);
		return { state, runIds: nextRunIds, changed: false };
	}

	return { state, runIds, changed: false };
}

/**
 * 终态系统通知（role=user，"[acp_delegate completed]" / "[acp_delegate FAILED ⚠️]"
 * 开头）→ 终态迁移。这是 acp 委托唯一可靠的完成信号（插件保证失败必达）。
 * terminalEntryId 供调用方落 subagents:record。
 */
export function reduceAcpNotification(
	state: SnapshotState,
	runIds: ReadonlyMap<string, string>,
	text: string,
	now: number,
): { state: SnapshotState; changed: boolean; terminalEntryId?: string } {
	const isCompleted = text.startsWith("[acp_delegate completed]");
	const isFailed = text.startsWith("[acp_delegate FAILED");
	if (!isCompleted && !isFailed) return { state, changed: false };
	const runId = extractAcpRunId(text);
	const entryId = runId ? runIds.get(runId) : undefined;
	if (!entryId) return { state, changed: false };
	const existing = state.get(entryId);
	if (!existing || isAcpTerminalStatus(existing.status)) return { state, changed: false };
	const next = cloneState(state);
	next.set(entryId, {
		...existing,
		status: isFailed ? "error" : "completed",
		completedAt: now,
		...(isFailed ? { error: extractAcpErrorExcerpt(text) ?? existing.error } : {}),
	});
	return { state: next, changed: true, terminalEntryId: entryId };
}

/* ------------------------------------------------------------------ */
/* 扩展主体                                                            */
/* ------------------------------------------------------------------ */

const WIDGET_KEY = "pi-deck-subagents";

/**
 * 子代理 start 锚点条目类型（会话文件 custom 条目）。
 * created 事件时立即落盘：运行中被重启终止的子代理没有 subagents:record
 * （插件只在完成时写），无此锚点则重启后彻底消失。
 * 读取侧（SessionHistoryReader.readSubagentRecords）同字符串过滤，
 * 残留锚点（无 record 覆盖）合成 stopped 条目，改动需两侧同步。
 */
const START_ENTRY_TYPE = "pi-deck-subagent-start";

/**
 * pi-subagents 插件完成时落盘的 record 条目类型；acp_delegate 委托在终态通知
 * 到达时按同一形状落盘，读取侧（SessionHistoryReader.readSubagentRecords）
 * 同字符串过滤，两侧改动需同步。
 */
const RECORD_ENTRY_TYPE = "subagents:record";

export default function piDeckSubagentsBridge(pi: any): void {
	let snapshot: SnapshotState = new Map();
	let pluginActive = false;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	function pushSnapshot(ctx: any) {
		const agents = Array.from(snapshot.values()).map((a) => ({
			id: a.id,
			type: a.type,
			description: a.description,
			status: a.status,
			toolUses: a.toolUses,
			tokens: a.tokens,
			startedAt: a.startedAt,
			completedAt: a.completedAt,
			result: a.result,
				error: a.error,
			via: a.via,
		}));

		// line-based，首行机器可读 JSON（与 pi-deck-todo 同约定）
		const jsonLine = JSON.stringify({ v: 1, kind: "pi-deck-subagents-snapshot", pluginActive, agents });
		ctx.ui.setWidget(WIDGET_KEY, [jsonLine]);
	}

	function schedulePush(ctx: any) {
		if (debounceTimer !== null) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			pushSnapshot(ctx);
		}, 200);
	}

	// 保存一份 ctx.ui 引用；事件回调可能没有 ctx 参数（pi.events 模式），
	// 但 setWidget 需要 ctx.ui。
	// 注意：pi 扩展事件模式为 `pi.on("event", (data, ctx) => ...)`，第二参数含 ctx。
	let savedCtx: any = null;

	function handleEvent(eventName: string, data: unknown, ctx?: any) {
		if (ctx) savedCtx = ctx;
		const result = reduceSnapshot(snapshot, eventName, data);
		if (result.changed) {
			snapshot = result.state;
			// created 即落盘 start 锚点：为"运行中被重启终止"的子代理在会话文件里
			// 留下存在痕迹（完成时会被插件的 subagents:record 覆盖，读取侧按 offset
			// 后写覆盖先写）。持久化失败仅损失审计锚点，不影响实时桥接。
			if (eventName === "subagents:created") {
				const id = extractFields(data).id ?? "";
				const entry = id ? snapshot.get(id) : undefined;
				if (entry) {
					try {
						pi.appendEntry(START_ENTRY_TYPE, {
							id: entry.id,
							type: entry.type,
							description: entry.description,
							startedAt: entry.startedAt,
						});
					} catch {
						// appendEntry 失败不阻断桥接：面板实时数据不依赖锚点
					}
				}
			}
			if (savedCtx) schedulePush(savedCtx);
		}
	}

	// 插件在位探测：subagents:ready 由插件在首个 session_start 时经 pi.events（扩展事件总线）广播。
	// 注意必须用 pi.events.on 订阅：pi.on 是生命周期事件表（extensionRunner.emit 派发 session_start 等），
	// 与 pi.events 的 eventBus 互不相通——用 pi.on 订阅插件事件会永远收不到（曾导致面板误报插件未安装）。
	pi.events.on("subagents:ready", () => {
		pluginActive = true;
		// 立即推送快照，让 pluginActive=true 尽快到达渲染层；
		// savedCtx 可能尚未由本扩展的 session_start 处理器设置（插件扩展先于内置扩展加载），
		// 此时跳过，由 session_start 处理器末尾的兜底推送覆盖。
		if (savedCtx) pushSnapshot(savedCtx);
	});

	// pi.events 事件 handler 只有 data 参数（无 ctx），setWidget 统一走 savedCtx。
	const onSubagentEvent = (eventName: string) => (data: unknown) => handleEvent(eventName, data);
	pi.events.on("subagents:created", onSubagentEvent("subagents:created"));
	pi.events.on("subagents:started", onSubagentEvent("subagents:started"));
	pi.events.on("subagents:completed", onSubagentEvent("subagents:completed"));
	pi.events.on("subagents:failed", onSubagentEvent("subagents:failed"));
	pi.events.on("subagents:steered", onSubagentEvent("subagents:steered"));

	/* acp_delegate（billion-context-pi）桥接：
	 * 工具执行事件与终态系统通知走 pi.on 生命周期事件表（非 pi.events）。 */

	// runId → 快照条目 id（派发 toolCallId）：终态通知/取消只带 runId。
	let acpRunIds: Map<string, string> = new Map();

	function handleAcpToolEvent(eventName: string, data: unknown, ctx?: any) {
		if (ctx) savedCtx = ctx;
		const result = reduceAcpToolEvent(snapshot, acpRunIds, eventName, data, Date.now());
		acpRunIds = result.runIds;
		if (result.state !== snapshot) snapshot = result.state;
		if (!result.changed) return;
		// 派发即落 start 锚点：与 pi-subagents created 同语义（运行中被重启终止
		// → 残留锚点由读取侧合成 stopped）。落盘失败不影响实时桥接。
		if (eventName === "tool_execution_start") {
			const toolCallId = (data as any)?.toolCallId;
			const entry = typeof toolCallId === "string" ? snapshot.get(toolCallId) : undefined;
			if (entry) {
				try {
					pi.appendEntry(START_ENTRY_TYPE, {
						id: entry.id,
						type: entry.type,
						description: entry.description,
						startedAt: entry.startedAt,
					});
				} catch {
					// appendEntry 失败不阻断桥接：面板实时数据不依赖锚点
				}
			}
		}
		if (savedCtx) schedulePush(savedCtx);
	}

	pi.on("tool_execution_start", (event: unknown, ctx?: any) => handleAcpToolEvent("tool_execution_start", event, ctx));
	pi.on("tool_execution_end", (event: unknown, ctx?: any) => handleAcpToolEvent("tool_execution_end", event, ctx));

	// 终态系统通知以 user 消息注入会话（message_end 可捕获）：据此迁到终态并落
	// subagents:record（历史重建的权威数据，读取侧与 pi-subagents record 同通道）。
	pi.on("message_end", (event: unknown, ctx?: any) => {
		if (ctx) savedCtx = ctx;
		const message = event && typeof event === "object" ? (event as Record<string, unknown>).message : undefined;
		if (!message || typeof message !== "object") return;
		const record = message as Record<string, unknown>;
		if (record.role !== "user") return;
		const text = typeof record.content === "string"
			? record.content
			: Array.isArray(record.content) ? extractTextItems(record.content) : "";
		if (!text.startsWith("[acp_delegate ")) return;
		const result = reduceAcpNotification(snapshot, acpRunIds, text, Date.now());
		if (result.state !== snapshot) snapshot = result.state;
		if (!result.changed) return;
		const entry = result.terminalEntryId ? snapshot.get(result.terminalEntryId) : undefined;
		if (entry) {
			try {
				pi.appendEntry(RECORD_ENTRY_TYPE, {
					id: entry.id,
					type: entry.type,
					description: entry.description,
					status: entry.status,
					startedAt: entry.startedAt,
					completedAt: entry.completedAt,
					error: entry.error,
					via: ACP_VIA,
				});
			} catch {
				// 落盘失败仅损失历史重建（主进程推导兜底仍可从通知文本恢复），不影响实时桥接
			}
		}
		if (savedCtx) schedulePush(savedCtx);
	});

	pi.on("session_start", (_event: unknown, ctx: any) => {
		// 重置快照（新会话开始，无存活后台代理）。
		// pluginActive 不重置：一个 pi 进程对应一个会话，插件加载状态进程级不变；
		// 且插件在首个 session_start 时广播 ready（其处理器先于本扩展执行），
		// 若在此重置会把 ready 置的 true 覆盖掉，导致插件在位却误报未安装。
		snapshot = new Map();
		acpRunIds = new Map();
		savedCtx = ctx;
		if (debounceTimer !== null) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		// 兜底推送一次：此时插件 ready 已在本处理器之前到达（扩展加载顺序保证），
		// 让最新 pluginActive 状态（含 true）写入 widget。
		pushSnapshot(ctx);
	});
}