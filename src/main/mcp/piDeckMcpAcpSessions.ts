/**
 * ACP 会话的 MCP 端口：建草稿 / 发消息 / 等回合 / 读消息 / 停运行时。
 *
 * 身份与能力校验全部收口在这里（项目归属、backend=acp、acpEnabled、工具存在且启用），
 * 工具层只做参数形状与错误码映射——分工与 HostPluginSessions 一致。
 *
 * 回合语义：ACP 的 `session/prompt` 响应在回合结束时才回，所以 `runtime.send` 本身就是
 * 一次长等待；MCP HTTP 响应 30s 会断开（PiDeckMcpHttpServer），因此 send 只等一小段
 * 拿到「已派发/立刻被拒」，把 promise 句柄留在内存里，由 wait 分段取结果。
 */
import { randomUUID } from "node:crypto";
import type { AcpToolConfig } from "../../shared/types/acp";
import type { PiDeckMcpAcpMessage, PiDeckMcpAcpMessagesPage, PiDeckMcpAcpSendResult, PiDeckMcpAcpSession, PiDeckMcpAcpToolsView, PiDeckMcpAcpWaitResult } from "../../shared/types/piDeckMcp";
import type { ChatMessage, SendSessionPromptResult } from "../../shared/types/session";
import type { AppSettings } from "../../shared/types/settings";
import { acpMessagePage } from "../acp/acpMessagePage";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";

/** 单次 MCP 响应窗口上限：HTTP 层 30s 断响应，留 10s 余量。 */
export const ACP_MCP_MAX_WAIT_MS = 20_000;
/** 派发后先等一小段：忙/工具缺失/握手失败这类立即失败要在 send 里报出来，而不是让客户端空转。 */
const DISPATCH_SETTLE_MS = 750;
/** 每会话保留最近一次回合句柄的时长（覆盖一次 20s 轮询窗口 + 客户端重试）。 */
const TURN_RETENTION_MS = 10 * 60_000;
const MAX_REPLY_CHARS = 64 * 1024;
const MAX_ERROR_CHARS = 2_000;
const MAX_MESSAGE_TEXT_CHARS = 64 * 1024;

type TrackedTurn = {
	requestId: string;
	startedAt: number;
	/** 永远 resolve：ACP 回合失败也是结果的一部分，不能变成 unhandledRejection。 */
	promise: Promise<SendSessionPromptResult>;
};

export type PiDeckMcpAcpSessionsDeps = {
	catalog: Pick<SessionCatalog, "createDraft" | "get">;
	runtime: Pick<SessionRuntimeCoordinator, "send" | "getTarget" | "getRuntimeState" | "stopRuntime">;
	/** ACP 历史读口（运行时投影 → 内存快照 → deck 归档），与桌面/Web 同源。 */
	readMessages: (acpSessionId: string) => Promise<ChatMessage[]>;
	/** 宿主未就绪时返回 null。 */
	settings: () => AppSettings | null;
	/** 会话当前时间线（取本轮最后一条 assistant 文本）。 */
	getRuntimeMessages: (sessionId: string) => ChatMessage[];
};

export class PiDeckMcpAcpSessions {
	private readonly turns = new Map<string, TrackedTurn>();

	constructor(private readonly deps: PiDeckMcpAcpSessionsDeps) {}

	/** 已登记且启用的 ACP 工具。只输出 id/name/bypassPermissions，命令与环境变量永不下发。 */
	tools(): PiDeckMcpAcpToolsView {
		const settings = this.deps.settings();
		if (!settings || settings.acpEnabled !== true) return { acpEnabled: false, tools: [] };
		return {
			acpEnabled: true,
			tools: (settings.acpTools ?? [])
				.filter((tool) => tool.enabled !== false)
				.map((tool) => ({
					id: tool.id,
					name: tool.name,
					bypassPermissions: tool.bypassPermissions === true,
				})),
		};
	}

	/** 只建草稿：不 spawn 进程，首次 send 才握手。草稿不进 sessions_list，发送后 promoteToActive。 */
	async create(input: { projectId: string; acpToolId: string; title?: string }): Promise<PiDeckMcpAcpSession> {
		const settings = this.requireSettings();
		const tool = this.requireTool(settings, input.acpToolId);
		const draft = await this.deps.catalog.createDraft({
			projectId: input.projectId,
			title: input.title?.trim() || `${tool.name} 会话`,
			// ACP CLI 只支持本机进程（acp/ 下没有 WSL 分支）：环境固定 native，
			// 不能跟随全局 wslEnabled 造出一条指向 WSL 的 ACP 会话。
			environment: "native",
			backend: "acp",
			acpToolId: tool.id,
		});
		return {
			sessionId: draft.id,
			projectId: draft.projectId,
			title: draft.title,
			backend: "acp",
			acpToolId: tool.id,
		};
	}

	/**
	 * 发送一条消息。status=accepted 表示已派发、回合仍在跑（继续 wait）；
	 * completed/failed 是回合已收口；timeout 只会在 waitMs>0 且窗口用尽时出现。
	 */
	async send(input: { projectId: string; sessionId: string; message: string; requestId?: string; waitMs?: number }): Promise<PiDeckMcpAcpSendResult> {
		const settings = this.requireSettings();
		const entry = this.requireAcpSession(input.projectId, input.sessionId);
		this.requireTool(settings, entry.acpToolId ?? "");
		const requestId = input.requestId?.trim() || randomUUID();
		const waitMs = clampWait(input.waitMs);
		const promise = this.deps.runtime.send({ sessionId: entry.id, requestId, message: input.message }).then(
			(result) => result,
			(error): SendSessionPromptResult => ({
				sessionId: entry.id,
				requestId,
				accepted: false,
				error: errorMessage(error),
				delivery: "unknown",
			}),
		);
		this.pruneTurns();
		const turn: TrackedTurn = { requestId, startedAt: Date.now(), promise };
		this.turns.set(entry.id, turn);
		// 短窗口：忙 / 工具被删 / 握手失败都在这里当场结算。
		const early = await settleWithin(promise, DISPATCH_SETTLE_MS);
		if (early.settled) return this.sendResult(entry.id, turn, early.value);
		if (waitMs > 0) {
			const outcome = await settleWithin(promise, waitMs);
			if (outcome.settled) return this.sendResult(entry.id, turn, outcome.value);
			return {
				sessionId: entry.id,
				requestId,
				...runtimeIdentity(this.deps.runtime, entry.id),
				status: "timeout",
			};
		}
		return {
			sessionId: entry.id,
			requestId,
			...runtimeIdentity(this.deps.runtime, entry.id),
			status: "accepted",
		};
	}

	/** 等最近一次 send 收口。没有本进程登记的回合时，按运行时状态判一次。 */
	async wait(input: { projectId: string; sessionId: string; timeoutMs?: number }): Promise<PiDeckMcpAcpWaitResult> {
		this.requireSettings();
		const entry = this.requireAcpSession(input.projectId, input.sessionId);
		const turn = this.turns.get(entry.id);
		if (turn) {
			// 缺省 15s：小于 HTTP 30s 断响应，也给客户端留出下一次轮询的余量。
			const outcome = await settleWithin(turn.promise, input.timeoutMs === undefined ? 15_000 : clampWait(input.timeoutMs));
			if (!outcome.settled) return { sessionId: entry.id, status: "timeout" };
			return this.waitResult(entry.id, outcome.value);
		}
		// 没有句柄（应用重启 / 别的客户端发的）：只能按运行时状态判。
		const target = this.deps.runtime.getTarget(entry.id);
		if (!target) throw new Error("session-not-running");
		const state = await this.deps.runtime.getRuntimeState(target);
		if (!state.ok) throw new Error("session-not-running");
		if (state.value.value.isTurnActive === true) return { sessionId: entry.id, status: "timeout" };
		const reply = lastAssistantText(this.deps.getRuntimeMessages(entry.id));
		return {
			sessionId: entry.id,
			status: "completed",
			...(reply ? { reply } : {}),
		};
	}

	/** ACP 会话消息（归档/投影，有界分页）。草稿还没握过手时返回空页。 */
	async messages(input: { projectId: string; sessionId: string; before?: number; pageSize?: number }): Promise<PiDeckMcpAcpMessagesPage> {
		const entry = this.requireAcpSession(input.projectId, input.sessionId);
		if (!entry.acpSessionId) return { messages: [], total: 0, nextBefore: null };
		const page = acpMessagePage(await this.deps.readMessages(entry.acpSessionId), input.before, input.pageSize);
		return {
			messages: page.messages.map(
				(message): PiDeckMcpAcpMessage => ({
					id: message.id,
					role: message.role,
					text: truncate(message.text ?? "", MAX_MESSAGE_TEXT_CHARS),
					timestamp: message.timestamp,
				}),
			),
			total: page.total,
			nextBefore: page.nextBefore,
		};
	}

	/** 停运行时（解绑 + 结束 CLI 进程）。下次 send 会重新握手并用 session/load 恢复。 */
	async stop(input: { projectId: string; sessionId: string; expectedRuntimeGeneration?: number }): Promise<{ sessionId: string; stopped: true }> {
		const entry = this.requireAcpSession(input.projectId, input.sessionId);
		const target = this.deps.runtime.getTarget(entry.id);
		if (!target) throw new Error("session-not-running");
		if (typeof input.expectedRuntimeGeneration === "number" && input.expectedRuntimeGeneration !== target.runtimeGeneration) throw new Error("runtime-changed");
		const result = await this.deps.runtime.stopRuntime(target);
		if (!result.ok) throw new Error(result.error.code === "SESSION_RUNTIME_CHANGED" ? "runtime-changed" : "session-not-running");
		this.turns.delete(entry.id);
		return { sessionId: entry.id, stopped: true };
	}

	private sendResult(sessionId: string, turn: TrackedTurn, result: SendSessionPromptResult): PiDeckMcpAcpSendResult {
		const identity = runtimeIdentity(this.deps.runtime, sessionId);
		if (!result.accepted) {
			// 忙是预期状态：给稳定错误码，客户端可据此等待后重试。
			const error = result.i18nKey === "acp.turnBusy" ? "session-busy" : truncate(result.error, MAX_ERROR_CHARS);
			return {
				sessionId,
				requestId: turn.requestId,
				...identity,
				status: "failed",
				error,
			};
		}
		const reply = lastAssistantText(this.deps.getRuntimeMessages(sessionId));
		return {
			sessionId,
			requestId: turn.requestId,
			...identity,
			status: "completed",
			...(reply ? { reply } : {}),
		};
	}

	private waitResult(sessionId: string, result: SendSessionPromptResult): PiDeckMcpAcpWaitResult {
		if (!result.accepted)
			return {
				sessionId,
				status: "failed",
				error: truncate(result.error, MAX_ERROR_CHARS),
			};
		const reply = lastAssistantText(this.deps.getRuntimeMessages(sessionId));
		return { sessionId, status: "completed", ...(reply ? { reply } : {}) };
	}

	private requireSettings(): AppSettings {
		const settings = this.deps.settings();
		if (!settings) throw new Error("operation-failed");
		if (settings.acpEnabled !== true) throw new Error("acp-disabled");
		return settings;
	}

	private requireTool(settings: AppSettings, toolId: string): AcpToolConfig {
		const tool = (settings.acpTools ?? []).find((candidate) => candidate.id === toolId && candidate.enabled !== false);
		if (!tool) throw new Error("acp-tool-not-found");
		return tool;
	}

	/** 项目归属与后端都在这里判定：id 不可猜，但也不能让 A 项目的 id 读 B 项目的会话。 */
	private requireAcpSession(projectId: string, sessionId: string) {
		const entry = this.deps.catalog.get(sessionId);
		if (!entry || entry.projectId !== projectId) throw new Error("session-not-authorized");
		if (entry.backend !== "acp") throw new Error("session-not-acp");
		return entry;
	}

	private pruneTurns(): void {
		const now = Date.now();
		for (const [sessionId, turn] of this.turns) if (now - turn.startedAt > TURN_RETENTION_MS) this.turns.delete(sessionId);
	}
}

function clampWait(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.min(ACP_MCP_MAX_WAIT_MS, Math.max(0, Math.floor(value)));
}

function runtimeIdentity(runtime: PiDeckMcpAcpSessionsDeps["runtime"], sessionId: string): { agentId?: string; runtimeGeneration?: number } {
	const target = runtime.getTarget(sessionId);
	return target ? { agentId: target.agentId, runtimeGeneration: target.runtimeGeneration } : {};
}

/** 等到 promise 结算或超时；不取消底层回合，只放弃本次等待。 */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<{ settled: true; value: T } | { settled: false }> {
	if (ms <= 0) return Promise.resolve({ settled: false });
	return new Promise((resolve) => {
		let done = false;
		const timer = setTimeout(() => {
			if (done) return;
			done = true;
			resolve({ settled: false });
		}, ms);
		// 主进程常驻、测试进程短命：不 unref 会拖住 node --test 退出。
		timer.unref?.();
		void promise.then((value) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ settled: true, value });
		});
	});
}

/** 本轮最后一条有文本的 assistant 消息（tool/error 不算回答）。 */
function lastAssistantText(messages: readonly ChatMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || message.role !== "assistant") continue;
		const text = typeof message.text === "string" ? message.text.trim() : "";
		if (text) return truncate(text, MAX_REPLY_CHARS);
	}
	return undefined;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
