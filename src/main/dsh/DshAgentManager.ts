import type {
	AgentBackend,
	AgentGatewayCapability,
	AgentRuntimeState,
	AgentTab,
	AvailableModel,
	ChatMessage,
	CreateAgentInput,
	ImageContent,
	Project,
	SendPromptInput,
	SendPromptResult,
	SessionUiResponseInput,
} from "../../shared/types";
import type { SessionProcessEvent } from "../../shared/types/trajectory";
// DSH 会话 id 品牌类型（零运行时成本，仅类型擦除）
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { ipcChannels } from "../../shared/ipc";
import { getAppLogger } from "../logging/sharedLogger";
import type { SessionAgentGateway } from "../sessions/SessionRuntimeCoordinator";
import type { DshHost } from "./DshHost";
import { projectDshEvent, type DshProjection } from "./dshEventProjector";
import {
	collectDshProcessEvent,
	collectDshProcessEvents,
	estimateContextTokens,
	parseContextBreakdownProjection,
	parseContextPressureProjection,
	pushDshProcessEvent,
} from "./dshProcessEvents";
import {
	applyDshControlEvent,
	beginDshCancel,
	type DshControlState,
} from "./dshRuntimeControl";
import { toDshAvailableModels } from "./dshModels";
import {
	approvalUiRequest,
	buildDshRejectValue,
	buildDshRespondValue,
	parseDshApprovalFrame,
	parseDshQuestionFrame,
	questionUiRequest,
	type DshApprovalFrame,
	type DshQuestionFrame,
} from "./dshApprovalBridge";
// DSH 会话持久化路径编码（与 DshHost 归档共用同一 workspace 目录名规则）
import { dshSessionFilePath } from "./dshSessionPath";

/**
 * DSH 后端网关：实现 SessionAgentGateway，把 DSH host（DshHost）的会话/事件
 * 投影成 PiDeck 的 ChatMessage / AgentTab / runtime 状态，走统一 onOutput 通道
 * （agents:* 载荷）推给渲染层——渲染层无需区分后端。
 *
 * v1 范围（能力缺失显式声明，UI 按能力禁用入口）：
 * - 支持：create/list/sendPrompt/abort/stop/restart/rename/getRuntimeState/
 *   getAvailableModels/setModel/prepareResendFromMessage/publishRuntimeState/
 *   fork/getForkMessages（session.fork 锚 seq）/compact（/compact 命令）
 * - 缺失（capabilities 未声明，且接口方法不实现——可选能力，见 SessionAgentGateway
 *   注释）：editMessage/deleteMessage/getCommands/exportHtml。调用方经 capability
 *   检查拒绝，不再复制 throw 样板。
 *
 * 事件模型（DSH SessionEvent = { type, seq, time, data }，PoC 实测）：
 * - assistant/chunk.data.chunk 是 StreamChunk delta（text-delta / reasoning-delta / finish）
 * - assistant/message.data.message.content 是组装后内容块
 * - turn/end.data.reason.kind === 'error' 表示回合失败
 * 投影逻辑在 dshEventProjector.ts（纯函数，可单测）。
 */
/**
 * DSH prompt image 媒体类型收窄（G2）：仅 attachment 服务支持的四种光栅格式。
 */
function isDshImageMediaType(
	value: string,
): value is "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
	return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif";
}

export class DshAgentManager implements SessionAgentGateway {
	readonly backend: AgentBackend = "dsh";	/** 已支持的可选能力：fork（session.fork 锚 seq 裁剪）与 compact（/compact 命令）。 */
	readonly capabilities: ReadonlySet<AgentGatewayCapability> = new Set([
		"fork",
		"getForkMessages",
		"compact",
	]);

	private readonly runtimes = new Map<string, DshAgentRuntime>();
	private readonly outputListeners = new Set<(channel: string, payload: unknown) => void>();
	/** 待应答的 DSH server-request 帧：rpcId → frame（approval/question 共用一张表）。 */
	private readonly pendingResponses = new Map<string, DshApprovalFrame | DshQuestionFrame>();
	/** RPC 日志开关集合（G17；agentId → 开启）。 */
	private readonly rpcLoggingAgents = new Set<string>();
	/** 审批/提问 pending 超时定时器（D5：用户不响应时自动拒绝，避免永久挂起）。 */
	private readonly pendingTimers = new Map<string, NodeJS.Timeout>();
	/** pending 审批/提问的超时时长（10 分钟：Ask 弹窗常驻等待太久无意义）。 */
	private static readonly PENDING_RESPONSE_TIMEOUT_MS = 10 * 60_000;

	constructor(
		private readonly dshHost: DshHost,
		private readonly getProject: (id: string) => Project | undefined,
		/** 审批自动放行开关：运行时读取（默认关闭），true 时 approval 帧直接应答 allowed-once。 */
		private readonly getAutoAllowApproval: () => boolean = () => false,
		/** DSH host 会话标题变化回调（attach 初值 / session/title 事件 / rename）：
		 *  装配层据此写回 catalog 并推送侧栏刷新——DSH 会话没有 pi 会话文件，
		 *  标题只存在于 host（dsh-session-title 的 session/title 事件 fold）。 */
		private readonly onTitleChanged?: (dshSessionId: string, title: string) => void,
		/** RPC 日志服务（G17：DSH 领域调用记录，与 pi 共用 RpcLogger；未注入时静默）。 */
		private readonly rpcLogger?: { push(entry: import("../../shared/types/rpcLog").RpcLogEntry): void },
	) {
		// E4：host 崩溃自动重启完成后恢复所有 runtime（host 内存已丢失：流式/工具/
		// 压缩状态停在崩溃前，mux 重连后新 host 没有已订阅会话，事件不会再推）。
		this.dshHost.onHostReady(() => {
			void this.recoverAfterHostRestart();
		});
	}

	// ── RPC 日志（G17，与 pi 的 setRpcLogging 语义一致）────────────────────────

	/** 开启/关闭某 DSH 会话的 RPC 日志（领域调用经 rpcLogger 落盘）。 */
	setRpcLogging(agentId: string, enabled: boolean): void {
		if (enabled) this.rpcLoggingAgents.add(agentId);
		else this.rpcLoggingAgents.delete(agentId);
	}

	/** 是否开启 RPC 日志。 */
	isRpcLogging(agentId: string): boolean {
		return this.rpcLoggingAgents.has(agentId);
	}

	/** 记录一条 DSH 领域调用日志（仅开关开启时；data 透传 RpcLogger 的截断/脱敏）。 */
	private logRpc(agentId: string, direction: "send" | "recv", summary: string, data?: unknown): void {
		if (!this.rpcLoggingAgents.has(agentId)) return;
		this.rpcLogger?.push({
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			agentId,
			direction,
			summary,
			time: Date.now(),
			...(data !== undefined ? { data } : {}),
		});
	}

	// ── 网关身份与订阅 ─────────────────────────────────────────────────────────

	onOutput(listener: (channel: string, payload: unknown) => void): () => void {
		this.outputListeners.add(listener);
		return () => this.outputListeners.delete(listener);
	}

	private emit(channel: string, payload: unknown): void {
		for (const listener of this.outputListeners) listener(channel, payload);
	}

	// ── SessionAgentGateway 实现 ───────────────────────────────────────────────

	list(): AgentTab[] {
		return [...this.runtimes.values()].map((runtime) => runtime.tab);
	}

	getMessages(agentId: string): ChatMessage[] {
		return this.runtime(agentId).messages;
	}

	/**
	 * 按 cwd + dsh sessionId 推导 host 会话文件路径（F5：渲染层右键「复制会话文件路径」用，
	 * 历史会话无运行时 tab 时也拿得到）。DSH 会话文件是 zstd 压缩日志，路径仅作定位。
	 */
	resolveSessionFilePath(cwd: string, dshSessionId: string): string {
		return dshSessionFilePath(this.dshHost.getHomeDir(), cwd, dshSessionId);
	}

	async create(input: CreateAgentInput): Promise<AgentTab> {
		const project = this.getProject(input.projectId);
		if (!project) throw new Error(`Project not found: ${input.projectId}`);
		const client = await this.ensureClient();
		const cwd = project.path;

		// attach 路径（重启恢复）：catalog 已持久化 DSH sessionId 时复用旧会话，
		// 不新建——DSH 会话由 host 持久化（$DSH_HOME），重建会丢失对话历史。
		let sessionId: string = "";
		let attached = false;
		/** attach 时从 host 拿到的会话标题（list 投影的 title 单元，非 draft 占位名）。 */
		let hostTitle: string | undefined;
		/** attach 时 list 投影的 values 块（contextPressure/contextBreakdown 初值，dsh-web 同源）。 */
		let attachProjectionValues: unknown;
		if (input.dshSessionId) {
			const listed = await client.sessions.list({});
			if (listed.result.ok) {
				const existing = listed.result.value.items.find(
					(item) => item.sessionId === input.dshSessionId,
				);
				if (existing) {
					sessionId = input.dshSessionId;
					attached = true;
					// dsh-session-title 把最新标题 fold 进 list 行的 projections.values.title：
					// 侧栏显示真实标题（如「打包的体积是否能优化一下呢」）而不是 draft 占位名。
					const values = (existing.projections as { values?: unknown } | undefined)?.values;
					attachProjectionValues = values;
					const projectedTitle = values !== null && typeof values === "object"
						? (values as Record<string, unknown>).title
						: undefined;
					if (typeof projectedTitle === "string" && projectedTitle.trim()) {
						hostTitle = projectedTitle.trim();
					}
				} else {
					// 持久化 id 在 host 里已不存在（DSH_HOME 被清/更换）：退回新建。
					const created = await this.createHostSession(client, cwd);
					if (!created.ok) {
						throw new Error(`dsh session.create failed: ${created.error}`);
					}
					sessionId = created.sessionId;
				}
			} else {
				throw new Error(`dsh session.list failed: ${JSON.stringify(listed.result.error)}`);
			}
		} else {
			const created = await this.createHostSession(client, cwd);
			if (!created.ok) {
				throw new Error(`dsh session.create failed: ${created.error}`);
			}
			sessionId = created.sessionId;
		}

		// catalog 持久化的是普通字符串，host API 需要品牌类型：边界处一次性转换。
		const dshSessionId = sessionId as SessionId;

		const agentId = `dsh:${sessionId}`;
		const tab: AgentTab = {
			id: agentId,
			projectId: input.projectId,
			cwd,
			title: hostTitle ?? input.title ?? "DSH 会话",
			status: "idle",
			sessionId,
			backend: "dsh",
			noSession: input.noSession,
			createdAt: Date.now(),
			// DSH 会话文件（侧栏右键「复制会话文件路径」；attach 时同步写回 catalog 记录）
			sessionPath: dshSessionFilePath(this.dshHost.getHomeDir(), cwd, sessionId),
		};
		const runtime: DshAgentRuntime = {
			tab,
			sessionId: dshSessionId,
			cwd,
			messages: [],
			projection: projectDshEvent(undefined, undefined, agentId),
			isStreaming: false,
			control: initialDshControl(),
			processEvents: [],
		};
		// attach 旧会话：拉历史尾部投影为初始消息（重启后能直接看到旧对话），
		// 投影器按 source.kind 过滤注入上下文，时间线只含真实对话。
		if (attached) {
			const history = await client.sessions.history({ sessionId: dshSessionId, maxMessages: 200 }).catch(() => null);
			if (history?.result.ok) {
				// history 条目带 host 计算的 tool view（与 mux 帧同源），随事件一起投影，
				// 历史工具卡片也能展示命令/描述（dsh-web 历史页同数据）。
				const entries = (history.result.value.events ?? [])
					.map((entry) => ({ event: entry.event, view: entry.view }))
					.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event))
					.sort((left, right) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
				for (const { event, view } of entries) {
					runtime.projection = projectDshEvent(runtime.projection, event, agentId, view);
				}
				runtime.messages = runtime.projection.messages;
				// 轨迹过程事件随历史重放一并恢复（重新打开的 dsh 会话也有 modelChange/权限等记录）
				runtime.processEvents = collectDshProcessEvents(
					runtime.processEvents,
					entries.map(({ event }) => event),
				);
				// 初始 attach 也推进 lastProjectedSeq：避免 mux 重连补帧重复投影（D6）。
				const lastEntry = entries[entries.length - 1];
				if (lastEntry && typeof lastEntry.event.seq === "number") {
					runtime.lastProjectedSeq = lastEntry.event.seq;
				}
				// G5：attach 后从投影恢复 goal 状态（goal/change 事件随历史重放）
				runtime.goal = runtime.projection.goal;
			}
		}
		// attach 初值：list 的 projections.values 携带 host 折叠好的 contextPressure /
		// contextBreakdown（dsh-web ContextMeter 同源），打开历史会话即可显示占用圆环。
		if (attached) {
			runtime.contextPressure = parseContextPressureProjection(attachProjectionValues);
			runtime.contextBreakdown = parseContextBreakdownProjection(attachProjectionValues);
		}
		// attach 初值同步：host 里已有标题（list 投影）时立即写回 catalog——
		// 否则重启后侧栏一直显示 draft 占位名（如「pi-desktop DSH」）。
		if (hostTitle) {
			this.onTitleChanged?.(sessionId, hostTitle);
		}
		this.runtimes.set(agentId, runtime);
		this.startMux(runtime);
		this.emit(ipcChannels.agentsState, this.list());
		return tab;
	}

	async sendPrompt(input: SendPromptInput): Promise<SendPromptResult> {
		const runtime = this.runtime(input.agentId);
		const client = this.requireClient();
		// G2：图片附件直接以 PromptContentPart 的 image 块（mediaType + base64 data）
		// 随 prompt 发送——host 受理时自行校验/落盘，无需额外上传端点。
		// 格式非法（非 base64 图片 / 不支持的媒体类型）时整体拒绝，不静默丢图。
		const imageParts: Array<{ type: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; data: string }> = [];
		if (input.images && input.images.length > 0) {
			for (const image of input.images) {
				if (image.type !== "image" || !image.data || !isDshImageMediaType(image.mimeType)) {
					return {
						accepted: false,
						error: "Invalid image attachment",
						delivery: "rejected",
						i18nKey: "session.sendDshImagesUnsupported",
					};
				}
				imageParts.push({ type: "image", mediaType: image.mimeType, data: image.data });
			}
		}
		// DSH 一期不支持宿主指令（agentMessage）与 steer 语义：显式拒绝而非静默丢弃（D2）。
		if (input.agentMessage || input.streamingBehavior) {
			return {
				accepted: false,
				error: "DSH host instructions / streaming behavior are not supported yet",
				delivery: "rejected",
				i18nKey: "session.sendDshUnsupportedPayload",
			};
		}
		// host 侧 bug 规避：dsh-agent-loop 的 slash 命令步骤（/permission /plan 等被
		// pideck-slash-bridge 在 pre-step reject）会让本轮以 blocked 收场，且 reject 路径
		// 跳过 pending-inbox 检查；若此时 inbox 里已 splice 下一条消息（本回合进行中到达
		// 的 followup），该消息会永久滞留、不再开新回合。因此所有 prompt 必须串行化：
		// 上一回合（含命令回合）真正 idle 之后才发下一条。
		await this.waitForIdle(input.agentId);
		this.logRpc(input.agentId, "send", "sessions.prompt", { message: input.message, images: imageParts.length });
		const sent = await client.sessions.prompt({
			sessionId: runtime.sessionId,
			mode: "queue",
			content: [
				{ type: "text", text: input.message },
				...imageParts,
			],
		});
		if (!sent.result.ok) {
			this.logRpc(input.agentId, "recv", "sessions.prompt rejected", sent.result.error);
			return { accepted: false, error: JSON.stringify(sent.result.error), delivery: "rejected" };
		}
		this.logRpc(input.agentId, "recv", "sessions.prompt accepted");
		return { accepted: true };
	}

	/**
	 * 等待该 agent 无运行中回合（control 状态 idle）且无未收口的取消。
	 * mux 事件驱动 control 状态机：turn/start → running，turn/end → idle（含命令 reject 的 blocked 收场）。
	 * cancelled 也计入等待：abort 把 status 立即置 idle，但 host 侧旧回合可能仍在收尾
	 * （工具未中断 / cancel 在途），此时发下一条会被 host 当作 followup 拼进旧回合，
	 * 新问题答案串进被停止的输出（「消息串台」）。必须等旧回合 turn/end 收口 cancelled 才放行。
	 * 超时（默认 30s）直接放行，避免 host 卡死把发送永久挂起；放行后由 host 侧
	 * queue 语义兜底（正常回合的 followup 不丢消息，只有 reject 路径才有滞留 bug）。
	 */
	private async waitForIdle(agentId: string, timeoutMs = 30_000): Promise<void> {
		const runtime = this.runtime(agentId);
		const startedAt = Date.now();
		while (runtime.control.status !== "idle" || runtime.control.cancelled) {
			if (Date.now() - startedAt >= timeoutMs) return;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	async restart(agentId: string): Promise<AgentTab> {
		// 重启 = 重建运行时投影，但 attach 到同一个 host 会话（会话数据由 $DSH_HOME
		// 持久化）：新建会话会让重启后对话历史「消失」（旧会话被 catalog 换绑丢弃）。
		// 仅当 host 里已不存在该会话（DSH_HOME 被清/更换）才退回新建。
		const old = this.runtime(agentId);
		const { cwd, projectId, title } = old.tab;
		await this.stop(agentId);
		const client = await this.ensureClient();
		let sessionId = old.tab.sessionId;
		if (sessionId) {
			const listed = await client.sessions.list({}).catch(() => null);
			const exists = listed?.result.ok === true && listed.result.value.items.some(
				(item) => item.sessionId === sessionId,
			);
			if (!exists) sessionId = undefined;
		}
		if (!sessionId) {
			const created = await this.createHostSession(client, cwd);
			if (!created.ok) {
				throw new Error(`dsh session.create (restart) failed: ${created.error}`);
			}
			sessionId = created.sessionId;
		}
		const dshSessionId = sessionId as SessionId;
		const tab: AgentTab = {
			...old.tab,
			id: agentId,
			projectId,
			cwd,
			title,
			sessionId,
			status: "idle",
			createdAt: Date.now(),
			// attach 同一会话：文件路径不变（沿用旧 id 的 host 会话文件）
			sessionPath: dshSessionFilePath(this.dshHost.getHomeDir(), cwd, sessionId),
		};
		const runtime: DshAgentRuntime = {
			tab,
			sessionId: dshSessionId,
			cwd,
			messages: [],
			projection: projectDshEvent(undefined, undefined, agentId),
			isStreaming: false,
			control: initialDshControl(),
			// 会话级数据跨重启保留：上下文占用/构成/轨迹过程事件与 host 会话同生命周期
			// （host 侧投影在 mux 重连后仍会继续推送，attach 初值由 list projections 兜底）。
			processEvents: old.processEvents,
			contextPressure: old.contextPressure,
			contextBreakdown: old.contextBreakdown,
			contextWindow: old.contextWindow,
		};
		// 拉历史尾部投影为初始消息（重启后时间线恢复旧对话，同 create attach 路径）
		const history = await client.sessions.history({ sessionId: dshSessionId, maxMessages: 200 }).catch(() => null);
		if (history?.result.ok) {
			const entries = (history.result.value.events ?? [])
				.map((entry) => ({ event: entry.event, view: entry.view }))
				.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event))
				.sort((left, right) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
			for (const { event, view } of entries) {
				runtime.projection = projectDshEvent(runtime.projection, event, agentId, view);
			}
			runtime.messages = runtime.projection.messages;
			runtime.processEvents = collectDshProcessEvents(
				runtime.processEvents,
				entries.map(({ event }) => event),
			);
		}
		this.runtimes.set(agentId, runtime);
		this.startMux(runtime);
		this.emit(ipcChannels.agentsState, this.list());
		return tab;
	}

	async stop(agentId: string): Promise<void> {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) return;
		runtime.muxAbort?.abort();
		await runtime.pump?.catch(() => undefined);
		// D1/D5：stop 前解阻塞 pending 审批/提问帧——host 侧工具调用在等 client-response，
		// 不应答则回合永不结束；且 runtime 删除后旧弹窗应答（sendUIResponse）会因
		// pendingResponses 已清而 no-op，弹窗残留。这里以拒绝收尾 + 通知渲染层 completed。
		await this.rejectAllPending(agentId).catch(() => undefined);
		this.runtimes.delete(agentId);
		this.emit(ipcChannels.agentsState, this.list());
	}

	/** 对全部 pending 审批/提问帧应答「拒绝」并清表（abort/stop 共用，D1/D5）。
	 * 与 pi abort 对每个 pending UI 请求发 value:null 解阻塞同语义。 */
	private async rejectAllPending(agentId: string): Promise<void> {
		if (this.pendingResponses.size === 0) return;
		const client = this.requireClient();
		const pending = [...this.pendingResponses.entries()];
		this.pendingResponses.clear();
		for (const [requestId, frame] of pending) {
			this.clearPendingTimeout(requestId);
			const value = buildDshRejectValue(frame);
			await client.respond({
				type: "client-response",
				// rpcId 来自 mux 帧（持久化为普通字符串），respond 需要品牌类型：边界一次性转换。
				rpcId: requestId as import("@deepseek-ai/dsh-host-apiproxy").RpcId,
				result: { ok: true, value },
			}).catch(() => undefined);
			this.emit(ipcChannels.agentsUiRequest, { agentId, requestId, completed: true });
		}
	}

	/** 清除 pending 超时定时器（应答/拒绝/清理时调用）。 */
	private clearPendingTimeout(requestId: string): void {
		const timer = this.pendingTimers.get(requestId);
		if (timer) {
			clearTimeout(timer);
			this.pendingTimers.delete(requestId);
		}
	}

	/** 停掉全部活跃 DSH 会话（host 重启/目录切换前调用）。
	 * 会话数据由 host 持久化在 $DSH_HOME，PiDeck 侧只丢运行时投影；
	 * catalog 保留 dshSessionId，重新打开会话时走 attach 路径恢复。 */
	async stopAll(): Promise<void> {
		const agentIds = [...this.runtimes.keys()];
		for (const agentId of agentIds) {
			await this.stop(agentId);
		}
	}

	/**
	 * mux 断连重连后的历史补帧（D6）：断连窗口内已完成的回合事件不会重放
	 * （mux 只推实时事件），从 session.history 拉尾部，按 seq 跳过已投影事件，
	 * 只补缺失部分。失败不阻断（下一条消息会正常激活 host 侧 agent）。
	 */
	private async backfillHistory(runtime: DshAgentRuntime): Promise<void> {
		try {
			const client = this.requireClient();
			const history = await client.sessions.history({
				sessionId: runtime.sessionId,
				maxMessages: 200,
			}).catch(() => null);
			if (!history?.result.ok) return;
			const entries = (history.result.value.events ?? [])
				.map((entry) => ({ event: entry.event, view: entry.view }))
				.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event))
				.sort((left, right) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
			let projection = runtime.projection;
			let lastSeq = runtime.lastProjectedSeq ?? 0;
			const freshEvents: Array<{ type?: string; seq?: number; data?: unknown; time?: unknown }> = [];
			for (const { event, view } of entries) {
				const seq = typeof event?.seq === "number" ? event.seq : 0;
				if (seq <= lastSeq) continue;
				projection = projectDshEvent(projection, event, runtime.tab.id, view);
				freshEvents.push(event);
				if (seq > lastSeq) lastSeq = seq;
			}
			runtime.projection = projection;
			runtime.messages = projection.messages;
			runtime.lastProjectedSeq = lastSeq;
			runtime.goal = projection.goal;
			// 断连窗口内的过程事件（modelChange/权限/plan/压缩）一并补账
			runtime.processEvents = collectDshProcessEvents(runtime.processEvents, freshEvents);
			this.emitMessages(runtime);
		} catch (error) {
			getAppLogger()?.warn("dsh-agent", "mux backfill failed", {
				sessionId: String(runtime.sessionId),
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * host 崩溃自动重启完成后的恢复（E4）：
	 * - 重置所有 runtime 的运行态（isStreaming/isCompacting/executingTool/control/thinking）：
	 *   host 内存已丢失，mux 重连后新 host 没有已订阅会话、旧回合事件不会再推，
	 *   UI 不能停在「运行中/压缩中/工具执行中」；
	 * - 重新拉 history 尾部补齐投影（断连窗口内可能缺帧，恢复到最近的完整历史）；
	 * - 推送 agentsState / messages / runtime state，渲染层即时刷新。
	 * 会话数据由 $DSH_HOME 持久化；用户下一条消息 prompt 会重新激活 host 侧 agent。
	 */
	private async recoverAfterHostRestart(): Promise<void> {
		for (const runtime of this.runtimes.values()) {
			const agentId = runtime.tab.id;
			try {
				const client = this.requireClient();
				runtime.isStreaming = false;
				runtime.isCompacting = false;
				runtime.executingTool = undefined;
				runtime.control = initialDshControl();
				runtime.thinkingId = undefined;
				runtime.thinkingStartedAt = undefined;
				const history = await client.sessions.history({
					sessionId: runtime.sessionId,
					maxMessages: 200,
				}).catch(() => null);
				if (history?.result.ok) {
					const entries = (history.result.value.events ?? [])
						.map((entry) => ({ event: entry.event, view: entry.view }))
						.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event))
						.sort((left, right) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
					let projection = projectDshEvent(undefined, undefined, agentId);
					for (const { event, view } of entries) {
						projection = projectDshEvent(projection, event, agentId, view);
					}
					runtime.projection = projection;
					runtime.messages = projection.messages;
					// 恢复后推进 lastProjectedSeq（D6 重连补帧跳过基准）。
					const lastEntry = entries[entries.length - 1];
					if (lastEntry && typeof lastEntry.event.seq === "number") {
						runtime.lastProjectedSeq = lastEntry.event.seq;
					}
					runtime.goal = runtime.projection.goal;
					// 过程事件随恢复重放补齐（host 崩溃窗口内的 modelChange/权限/plan 记录）
					runtime.processEvents = collectDshProcessEvents(
						runtime.processEvents,
						entries.map(({ event }) => event),
					);
				}
				this.emit(ipcChannels.agentsState, this.list());
				this.emitMessages(runtime);
				this.emitRuntimeState(agentId);
			} catch (error) {
				// 单个会话恢复失败不阻断其余会话；下一条用户消息仍会重新激活。
				getAppLogger()?.warn("dsh-agent", `host restart recovery failed for ${agentId}`, {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	async abort(agentId: string): Promise<void> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		// 先抬世代再 cancel：mux 里迟到的 chunk/turn/start 必须丢掉，否则停止按钮会一直亮。
		this.applyControl(runtime, beginDshCancel(runtime.control));
		// 立即收口思考流：停止后旧回合的 reasoning 残留帧会被 cancelled 守卫丢弃，
		// Live 思考块不能等 turn/end（可能迟到/缺失），否则「停止后思考还在转」。
		if (runtime.thinkingId) {
			this.emit(ipcChannels.agentsThinking, {
				agentId: runtime.tab.id,
				id: runtime.thinkingId,
				text: "",
				startedAt: runtime.thinkingStartedAt ?? 0,
				endedAt: Date.now(),
				done: true,
			});
			runtime.thinkingId = undefined;
			runtime.thinkingStartedAt = undefined;
		}
		// D1：abort 必须解阻塞 pending 审批/提问帧——host 侧工具调用在等 client-response，
		// 不应答则回合永不结束（后续发送被 waitForIdle 卡满 30s），Ask 弹窗残留。
		await this.rejectAllPending(agentId).catch(() => undefined);
		this.logRpc(agentId, "send", "sessions.cancel");
		await client.sessions.cancel({ sessionId: runtime.sessionId }).catch(() => undefined);
		this.logRpc(agentId, "recv", "sessions.cancel done");
		this.emitRuntimeState(agentId);
		this.emit(ipcChannels.agentsState, this.list());
	}

	async rename(agentId: string, name: string): Promise<AgentTab> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const renamed = await client.sessions.rename({ sessionId: runtime.sessionId, title: name });
		if (renamed.result.ok) {
			runtime.tab.title = renamed.result.value.title;
			this.emit(ipcChannels.agentsState, this.list());
			this.onTitleChanged?.(String(runtime.sessionId), runtime.tab.title);
		}
		return runtime.tab;
	}

	async compact(agentId: string, prompt?: string): Promise<AgentRuntimeState> {
		// DSH 的压缩走 host 侧 /compact 命令注册表（dsh-command-compact），
		// wire 上没有显式 compact RPC（计划 D11）：以 queue 提示词触发，随后返回当前 runtime 状态。
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		// 与 sendPrompt 同一串行化约束：上一回合（含命令回合）idle 后才发 /compact，
		// 避免压缩指令被 host 拼进运行中回合（D4）。
		await this.waitForIdle(agentId);
		const commandText = prompt && prompt.trim()
			? `/compact ${prompt.trim()}`
			: "/compact";
		const sent = await client.sessions.prompt({
			sessionId: runtime.sessionId,
			mode: "queue",
			content: [{ type: "text", text: commandText }],
		});
		if (!sent.result.ok) {
			throw new Error(`dsh /compact failed: ${JSON.stringify(sent.result.error)}`);
		}
		// 压缩进行态：turn/end（命令回合收口）到达后由 mux 复位（D4）。
		runtime.isCompacting = true;
		this.emitRuntimeState(agentId);
		return this.getRuntimeState(agentId);
	}

	async getRuntimeState(agentId: string): Promise<AgentRuntimeState> {
		const runtime = this.runtime(agentId);
		// 上下文占用圆环（ContextMeter）：优先 host contextPressure 投影（provider 上报 +
		// 下一条请求估算 + 路由容量，dsh-web 同源）；投影缺失（token-meter 未挂载 /
		// adapter 未上报 usage / 投影帧未推送）时退化到「request/context 的 contextWindow
		// + 消息字符估算」，保证 dsh 会话首个回合后圆环即出现，与 pi 行为统一。
		const pressure = runtime.contextPressure;
		const breakdown = runtime.contextBreakdown;
		const contextWindow = pressure?.contextWindow ?? runtime.contextWindow;
		// 对话消息估算（字符数 ÷ 4，与 pi 的 contextMessageTokens 同规则）；空会话不兜底
		const estimatedTokens = estimateContextTokens(runtime.messages);
		const fallbackTokens = estimatedTokens > 0 ? estimatedTokens : undefined;
		const contextTokens = pressure?.projectedTokens ?? pressure?.pressureTokens ?? fallbackTokens;
		const contextMessageTokens = breakdown?.messageTokens ?? fallbackTokens;
		const contextPercent =
			typeof contextTokens === "number" && typeof contextWindow === "number" && contextWindow > 0
				? Math.min(100, Math.round((contextTokens / contextWindow) * 100))
				: undefined;
		return {
			isStreaming: runtime.isStreaming,
			isCompacting: runtime.isCompacting === true,
			isExecutingTool: runtime.executingTool !== undefined,
			executingToolName: runtime.executingTool,
			modelName: runtime.model?.model,
			provider: runtime.model?.provider,
			modelId: runtime.model?.model,
			thinkingLevel: runtime.thinkingLevel,
			permissionPreset: runtime.permissionPreset,
			planModeActive: runtime.planModeActive,
			// G5：当前 goal（goal/change 事件投影）
			goal: runtime.goal,
			// 上下文占用（host contextPressure/contextBreakdown 投影；缺失时消息估算兜底）
			contextTokens: typeof contextTokens === "number" ? contextTokens : undefined,
			contextWindow: typeof contextWindow === "number" ? contextWindow : undefined,
			contextPercent: contextPercent,
			contextMessageTokens: typeof contextMessageTokens === "number" ? contextMessageTokens : undefined,
			// G16：usage 指标（adapter 报告时才有）
			inputTokens: runtime.usage?.inputTokens,
			outputTokens: runtime.usage?.outputTokens,
			cacheRead: runtime.usage?.cacheReadTokens,
			cacheWrite: runtime.usage?.cacheWriteTokens,
			cacheTotal: runtime.usage
				? (runtime.usage.cacheReadTokens ?? 0) + (runtime.usage.cacheWriteTokens ?? 0)
				: undefined,
		};
	}

	/**
	 * 轨迹过程事件（G-context）：modelChange/permission/plan/goal/compaction 记录
	 * （pi 会话文件过程事件的 DSH 等价物）。
	 * - 运行时会话：mux 事件流 + attach/backfill 重放收集的缓存；
	 * - 历史（未激活）会话：从 host history 尾部按事件流推导（与 dsh-web 历史页同数据源），
	 *   失败/无 host 时返回空数组（不阻断轨迹展示）。
	 */
	async readProcessEvents(
		agentId: string | undefined,
		dshSessionId: string | undefined,
	): Promise<SessionProcessEvent[]> {
		if (agentId) {
			const runtime = this.runtimes.get(agentId);
			if (runtime) {
				return [...runtime.processEvents].sort((left, right) => left.timestamp - right.timestamp);
			}
		}
		if (!dshSessionId) return [];
		try {
			const client = await this.ensureClient();
			const page = await client.sessions.history({
				sessionId: dshSessionId as SessionId,
				maxMessages: 1000,
			});
			if (!page.result.ok) return [];
			const events = (page.result.value.events ?? [])
				.map((entry) => entry.event)
				.filter((event): event is NonNullable<typeof event> => Boolean(event))
				.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
			return collectDshProcessEvents([], events).sort(
				(left, right) => left.timestamp - right.timestamp,
			);
		} catch {
			return [];
		}
	}

	/**
	 * 历史分页（D04）：DSH 会话没有 pi 会话文件，历史浏览走 host 的 session.history
	 * （事件流翻页，beforeSeq 为排除边界：返回 seq < beforeSeq 的事件，与本页最旧事件
	 * seq 相同即可不重复）。投影复用 dshEventProjector（过滤注入上下文）。
	 * 返回形状对齐渲染层 disk 分页协议（sessionsCatalogReadMessagePage）。
	 */
	async readHistoryPage(
		dshSessionId: string,
		beforeSeq: number | undefined,
		maxMessages: number,
	): Promise<{ messages: ChatMessage[]; total: number; nextBefore: number | null }> {
		// 历史浏览是 DSH host 的第一个入口：点击历史 DSH 会话时 runtime 尚未激活
		// （懒启动），必须 ensureStarted 拉起 host，否则 requireClient 直接抛
		// "DSH host is not started"，时间线加载失败显示为空会话。
		const client = await this.ensureClient();
		const page = await client.sessions.history({
			sessionId: dshSessionId as SessionId,
			beforeSeq,
			maxMessages,
		});
		if (!page.result.ok) {
			return { messages: [], total: 0, nextBefore: null };
		}
		const entries = (page.result.value.events ?? [])
			.map((entry) => ({ event: entry.event, view: entry.view }))
			.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event))
			.sort((left, right) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
		const agentId = `dsh:${dshSessionId}`;
		let projection = projectDshEvent(undefined, undefined, agentId);
		for (const { event, view } of entries) {
			projection = projectDshEvent(projection, event, agentId, view);
		}
		const hasMore = page.result.value.hasMore === true;
		const oldestSeq = entries.length > 0 ? entries[0].event.seq : undefined;
		// 游标语义：下一页传本页最旧事件 seq（DSH history 的 beforeSeq 是排除边界，
		// 返回 seq < beforeSeq 的事件，与渲染层 prepend 协议「nextBefore 原样回传」对齐）。
		const nextBefore = hasMore && typeof oldestSeq === "number" ? oldestSeq : null;
		return {
			messages: projection.messages,
			// 渲染层不消费 total（仅透传）；-1 表示未知（DSH 无总条数概念）。
			total: -1,
			nextBefore,
		};
	}

	async getAvailableModels(agentId: string): Promise<AvailableModel[]> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const models = await client.sessions.models({ sessionId: runtime.sessionId });
		if (!models.result.ok) return [];
		// host 的 models catalog 带每个模型的 reasoning.efforts（支持的思考档位）：
		// 透传给选择器按模型过滤——llm-deepseek 只接受 off/high/max，
		// llm-pi-ai 按模型声明，选不支持的档位会在下次请求抛 UNSUPPORTED_REASONING_EFFORT。
		// 与 DshHost.listModels 共用同一映射（目录数据同源）。
		return toDshAvailableModels(models.result.value.groups ?? []);
	}

	async prepareResendFromMessage(
		agentId: string,
		messageId: string,
	): Promise<{ text: string; images?: ImageContent[] }> {
		const message = this.runtime(agentId).messages.find((item) => item.id === messageId);
		if (!message) throw new Error(`Message not found: ${messageId}`);
		// G2：图片消息重发时带回图片（渲染层附件栏恢复）
		return {
			text: message.text,
			...(message.images && message.images.length > 0 ? { images: message.images } : {}),
		};
	}

	/**
	 * 「查看完整输出」：DSH 会话没有 pi 会话文件可定位（pi 走 SessionFileEditor 文件路径），
	 * 工具结果全文随投影消息保存在 meta.fullText（dshEventProjector tool/result 分支写入），
	 * 这里直接从运行时消息返回；历史会话（未激活）不在此列，由 readDshHistoryPage 路径覆盖。
	 */
	async readMessageFullText(agentId: string, messageId: string): Promise<{ text: string }> {
		const runtime = this.runtime(agentId);
		const message = runtime.messages.find((item) => item.id === messageId);
		if (!message) throw new Error(`Message not found: ${messageId}`);
		const fullText = typeof message.meta?.fullText === "string"
			? message.meta.fullText
			: message.text;
		return { text: fullText };
	}

	/** 创建目标（G5）：objective 必填；maxGoalRounds 缺省由 host 服务配置解析。 */
	async createGoal(agentId: string, objective: string, maxGoalRounds?: number): Promise<void> {
		const trimmed = objective.trim();
		if (!trimmed) throw new Error("Goal objective is required");
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const created = await client.goals.create({
			sessionId: runtime.sessionId,
			objective: trimmed,
			...(typeof maxGoalRounds === "number" ? { maxGoalRounds } : {}),
		});
		if (!created.result.ok) {
			throw new Error(`dsh goal.create failed: ${JSON.stringify(created.result.error)}`);
		}
	}

	/** 目标操作（G5）：pause/resume/complete/clear，按当前 goal 的 CAS ref 提交。 */
	async goalAction(
		agentId: string,
		action: "pause" | "resume" | "complete" | "clear",
	): Promise<void> {
		const runtime = this.runtime(agentId);
		const goal = runtime.goal;
		if (!goal) throw new Error("No active goal");
		const client = this.requireClient();
		// goal.refId 是投影持久化的普通字符串，host API 需要品牌类型：边界一次性转换（同 SessionId 模式）。
		const ref = {
			id: goal.refId as import("@deepseek-ai/dsh-goal/types").GoalId,
			revision: goal.revision,
		};
		const request = {
			sessionId: runtime.sessionId,
			ref,
		};
		const result = action === "pause"
			? await client.goals.pause(request)
			: action === "resume"
				? await client.goals.resume(request)
				: action === "complete"
					? await client.goals.complete(request)
					: await client.goals.clear({ sessionId: runtime.sessionId, ref });
		if (!result.result.ok) {
			throw new Error(`dsh goal.${action} failed: ${JSON.stringify(result.result.error)}`);
		}
	}

	/** 子代理列表（G6）：subagent.list 直接子代目录（不激活双方）。 */
	async listSubagents(agentId: string): Promise<Array<{
		id: string;
		label?: string;
		activity: "running" | "inactive";
		hasChildren: boolean;
		mode: "one-shot" | "continuable";
		kind: "child" | "diagnostic";
	}>> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const listed = await client.subagents.list({ parentSessionId: runtime.sessionId });
		if (!listed.result.ok) return [];
		return (listed.result.value.entries ?? []).map((entry) => ({
			id: String(entry.id),
			label: "label" in entry ? entry.label : undefined,
			activity: "activity" in entry ? entry.activity : "inactive",
			hasChildren: "hasChildren" in entry ? entry.hasChildren : false,
			mode: "mode" in entry ? entry.mode : "one-shot",
			kind: entry.kind,
		}));
	}

	/** 子代理历史（G6）：只读 transcript（不激活 Agent），投影成 ChatMessage。 */
	async readSubagentHistory(
		agentId: string,
		childSessionId: string,
		beforeSeq?: number,
		maxMessages = 100,
	): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const address = {
			parentSessionId: runtime.sessionId,
			childSessionId: childSessionId as SessionId,
			mode: "one-shot" as const,
		};
		const page = await client.subagents.history({
			...address,
			...(typeof beforeSeq === "number" ? { beforeSeq } : {}),
			maxMessages,
		});
		if (!page.result.ok) {
			return { messages: [], hasMore: false };
		}
		const entries = (page.result.value.events ?? [])
			.map((entry) => ({ event: entry.event, view: entry.view }))
			.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event))
			.sort((left, right) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
		const childAgentId = `dsh:${childSessionId}`;
		let projection = projectDshEvent(undefined, undefined, childAgentId);
		for (const { event, view } of entries) {
			projection = projectDshEvent(projection, event, childAgentId, view);
		}
		return { messages: projection.messages, hasMore: page.result.value.hasMore === true };
	}

	async setModel(agentId: string, provider: string, modelId: string): Promise<unknown> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const selected = await client.sessions.selectModel({
			sessionId: runtime.sessionId,
			provider,
			model: modelId,
			// 先选了思考档位再换模型：档位随 selectModel 一起下发，否则会被模型默认档位覆盖。
			...(runtime.thinkingLevel ? { reasoningEffort: runtime.thinkingLevel } : {}),
		});
		if (!selected.result.ok) {
			throw new Error(`dsh selectModel failed: ${JSON.stringify(selected.result.error)}`);
		}
		runtime.model = selected.result.value.selected;
		return selected.result.value;
	}

	async setThinking(agentId: string, level: string): Promise<unknown> {
		// DSH 的思考档走 selectModel.reasoningEffort，没有独立 RPC。
		const runtime = this.runtime(agentId);
		runtime.thinkingLevel = level;
		const selected = runtime.model;
		if (!selected) return { accepted: true, thinkingLevel: level };
		const client = this.requireClient();
		const updated = await client.sessions.selectModel({
			sessionId: runtime.sessionId,
			provider: selected.provider,
			model: selected.model,
			reasoningEffort: level,
		});
		if (updated.result.ok) {
			runtime.model = {
				provider: updated.result.value.selected.provider,
				model: updated.result.value.selected.model,
			};
			runtime.thinkingLevel = updated.result.value.selected.reasoningEffort ?? level;
		}
		return this.getRuntimeState(agentId);
	}

	async setPermission(agentId: string, preset: string): Promise<unknown> {
		// DSH 权限预设切换走 /permission 命令（host 侧 slash 桥在 agent/pre-step
		// 拦截执行）：sandbox 模式 + approval 策略随命令立即生效，permission/preset
		// 等事件经 mux 折叠进 runtime state。命令消息不进模型、不上时间线。
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		// 与 sendPrompt 同一串行化约束：命令回合运行中不允许再 splice 消息
		// （reject 路径会滞留回合内到达的 followup，见 sendPrompt 注释）。
		await this.waitForIdle(agentId);
		const sent = await client.sessions.prompt({
			sessionId: runtime.sessionId,
			mode: "queue",
			content: [{ type: "text", text: `/permission ${preset}` }],
		});
		if (!sent.result.ok) {
			throw new Error(`dsh /permission failed: ${JSON.stringify(sent.result.error)}`);
		}
		return { accepted: true, preset };
	}

	async publishRuntimeState(agentId: string): Promise<void> {
		this.emitRuntimeState(agentId);
	}

	async getForkMessages(agentId: string): Promise<Array<{ entryId: string; text: string }>> {
		// DSH 没有 pi 的 entryId 概念：用用户消息的事件 seq 作为 fork 锚点。
		// entryId 编码为 "seq:<n>"，forkSession 侧解析回 seq（session.fork 的 atSeq）。
		const runtime = this.runtime(agentId);
		return runtime.messages
			.filter((message) => message.role === "user" && message.text.trim().length > 0)
			.map((message) => {
				const seqMatch = /^dsh:(\d+)$/.exec(message.id);
				return {
					entryId: seqMatch ? `seq:${seqMatch[1]}` : "",
					text: message.text,
				};
			})
			.filter((item) => item.entryId.length > 0);
	}

	async forkSession(agentId: string, entryId: string): Promise<{ text?: string }> {
		// DSH fork：session.fork 在 atSeq 处裁剪出新会话，然后把当前 runtime 换绑过去
		// （保留 agentId，模拟 pi /fork 的「当前会话变成 fork 结果」语义）。
		const seqMatch = /^seq:(\d+)$/.exec(entryId);
		if (!seqMatch) throw new Error(`Invalid dsh fork entryId: ${entryId}`);
		return this.replaceWithFork(agentId, Number(seqMatch[1]));
	}

	/** DSH clone = fork 无锚点：wire 语义是复制到源会话最后一个完成的 turn（完整副本）。 */
	async cloneSession(agentId: string): Promise<{ text?: string }> {
		return this.replaceWithFork(agentId, undefined);
	}

	/**
	 * session.fork + 换绑共用流程：fork 出新 host 会话 → 停旧 mux → runtime 换绑
	 * 新会话并拉历史。atSeq=undefined 表示复制完整会话（clone）。
	 */
	private async replaceWithFork(
		agentId: string,
		atSeq: number | undefined,
	): Promise<{ text?: string }> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const forked = await client.sessions.fork({
			sessionId: runtime.sessionId,
			...(atSeq !== undefined ? { atSeq } : {}),
		});
		if (!forked.result.ok) {
			throw new Error(`dsh session.fork failed: ${JSON.stringify(forked.result.error)}`);
		}
		const newSessionId = forked.result.value.sessionId;
		const forkedText = atSeq !== undefined
			? runtime.messages.find(
				(message) => message.role === "user" && message.id === `dsh:${atSeq}`,
			)?.text
			: undefined;
		// 停旧 mux，换绑到新会话并拉历史（fork 会话自带 atSeq 前历史）。
		await this.stop(agentId);
		const tab: AgentTab = {
			...runtime.tab,
			sessionId: newSessionId,
			status: "idle",
			createdAt: Date.now(),
			// fork/clone 产生新 dsh sessionId：会话文件路径同步更新
			sessionPath: dshSessionFilePath(this.dshHost.getHomeDir(), runtime.cwd, newSessionId),
		};
		const nextRuntime: DshAgentRuntime = {
			...runtime,
			tab,
			sessionId: newSessionId,
			messages: [],
			projection: projectDshEvent(undefined, undefined, agentId),
			isStreaming: false,
			control: initialDshControl(),
			// fork/clone 是全新 host 会话：过程事件/上下文占用投影/路由容量随旧会话作废，
			// 等 mux 重推（request/context 会重新带 contextWindow）。
			processEvents: [],
			contextPressure: undefined,
			contextBreakdown: undefined,
			contextWindow: undefined,
		};		const history = await client.sessions.history({ sessionId: newSessionId, maxMessages: 200 }).catch(() => null);
		if (history?.result.ok) {
			const entries = (history.result.value.events ?? [])
				.map((entry) => ({ event: entry.event, view: entry.view }))
				.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event))
				.sort((left, right) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
			for (const { event, view } of entries) {
				nextRuntime.projection = projectDshEvent(nextRuntime.projection, event, agentId, view);
			}
			nextRuntime.messages = nextRuntime.projection.messages;
			// fork 会话自带 atSeq 前历史：过程事件一并重放（新会话从零开始收集）
			nextRuntime.processEvents = collectDshProcessEvents(
				nextRuntime.processEvents,
				entries.map(({ event }) => event),
			);
			// 初始 attach 也推进 lastProjectedSeq（D6 重连补帧跳过基准）。
			const lastEntry = entries[entries.length - 1];
			if (lastEntry && typeof lastEntry.event.seq === "number") {
				nextRuntime.lastProjectedSeq = lastEntry.event.seq;
			}
			nextRuntime.goal = nextRuntime.projection.goal;
		}
		this.runtimes.set(agentId, nextRuntime);
		this.startMux(nextRuntime);
		this.emit(ipcChannels.agentsState, this.list());
		this.emitMessages(nextRuntime);
		this.emitRuntimeState(agentId);
		// 返回 fork 点文案（渲染层把它预填到输入框，与 pi 一致；clone 无锚点时为 undefined）
		return { text: forkedText };
	}

	async sendUIResponse(agentId: string, requestId: string, response: SessionUiResponseInput["response"]): Promise<unknown> {
		// DSH 审批/提问桥：把 PiDeck 的 Ask 应答转成 DSH client-response（回显 rpcId）。
		const frame = this.pendingResponses.get(requestId);
		if (!frame) {
			// 未知/已过期的请求：DSH 侧没有对应 server-request，直接 no-op。
			return { accepted: false, reason: "no-pending-request" };
		}
		const client = this.requireClient();
		const value = buildDshRespondValue(frame, response);
		if (!value) {
			// 应答不可解析（如 batch 答案 JSON 损坏）：按拒绝处理，避免 host 永久挂起。
			this.pendingResponses.delete(requestId);
			this.clearPendingTimeout(requestId);
			this.emit(ipcChannels.agentsUiRequest, { agentId, requestId, completed: true });
			return { accepted: false, reason: "unparseable-response" };
		}
		await client.respond({
			type: "client-response",
			// rpcId 来自 mux 帧（持久化为普通字符串），respond 需要品牌类型：边界一次性转换。
			rpcId: requestId as import("@deepseek-ai/dsh-host-apiproxy").RpcId,
			result: { ok: true, value },
		});
		this.pendingResponses.delete(requestId);
		this.clearPendingTimeout(requestId);
		// 通知渲染层请求完成（与 pi 的 agentsUiRequest completed 同协议）
		this.emit(ipcChannels.agentsUiRequest, { agentId, requestId, completed: true });
		return { accepted: true };
	}

	notifyAskPending(): void {
		// 桌面通知由 SessionRuntimeCoordinator.observeRuntimeEvent 统一触发
		// （非聚焦会话收到 agents:ui-request 时），DSH 不需要额外通道。
	}

	// ── 内部 ───────────────────────────────────────────────────────────────────

	private runtime(agentId: string): DshAgentRuntime {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) throw new Error(`No dsh runtime for agent: ${agentId}`);
		return runtime;
	}

	private requireClient(): import("@deepseek-ai/dsh-host-apiproxy").AbstractApiClient {
		const client = this.dshHost.getClient();
		if (!client) throw new Error("DSH host is not started");
		return client;
	}

	/**
	 * 新建 host 会话并挂到 cwd 对应 workspace：sessions.create 只在传入
	 * workspaceId 时把会话计入 workspace（dsh-web 按 workspace 分组展示；
	 * 不挂 = dsh-web「未分组」）。workspace 解析失败不阻断创建（降级为不带
	 * workspaceId 的旧行为）。
	 */
	private async createHostSession(
		client: import("@deepseek-ai/dsh-host-apiproxy").AbstractApiClient,
		cwd: string,
	): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
		try {
			const workspaceId = await this.dshHost.resolveWorkspaceId(cwd);
			const created = await client.sessions.create({
				cwd,
				...(workspaceId !== undefined ? { workspaceId } : {}),
			});
			if (!created.result.ok) {
				return { ok: false, error: JSON.stringify(created.result.error) };
			}
			return { ok: true, sessionId: created.result.value.sessionId };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async ensureClient(): Promise<import("@deepseek-ai/dsh-host-apiproxy").AbstractApiClient> {
		await this.dshHost.ensureStarted();
		return this.requireClient();
	}

	private emitRuntimeState(agentId: string): void {
		void this.getRuntimeState(agentId)
			.then((state) => {
				this.emit(ipcChannels.agentsRuntimeState, { agentId, state });
			})
			.catch(() => undefined);
	}

	/**
	 * mux session/projection 帧 → runtime 投影缓存（上下文圆环数据源）。
	 * 只消费本项目消费的投影单元（contextPressure/contextBreakdown），其余键忽略——
	 * 渲染层队列/后台任务展示（session/queue、session/jobs）如需接入，在此扩展。
	 * value 为 host schema 校验后的单元值，按字段名结构性收窄（与 dsh-web 同协议）。
	 */
	private applyProjectionFrame(
		runtime: DshAgentRuntime,
		payload: { sessionId?: unknown; key?: unknown; value?: unknown },
	): void {
		const key = typeof payload.key === "string" ? payload.key : "";
		if (key === "contextPressure") {
			const parsed = parseContextPressureProjection(payload.value);
			if (parsed !== undefined) {
				runtime.contextPressure = parsed;
				this.emitRuntimeState(runtime.tab.id);
			}
			return;
		}
		if (key === "contextBreakdown") {
			const parsed = parseContextBreakdownProjection(payload.value);
			if (parsed !== undefined) {
				runtime.contextBreakdown = parsed;
				this.emitRuntimeState(runtime.tab.id);
			}
			return;
		}
	}

	private applyControl(runtime: DshAgentRuntime, next: DshControlState): void {
		const statusChanged = runtime.tab.status !== next.status;
		runtime.control = next;
		runtime.isStreaming = next.isStreaming;
		if (statusChanged) {
			runtime.tab.status = next.status;
			this.emit(ipcChannels.agentsState, this.list());
		}
	}

	private emitMessages(runtime: DshAgentRuntime): void {
		this.emit(ipcChannels.agentsMessage, {
			agentId: runtime.tab.id,
			messages: runtime.messages,
			totalLength: runtime.messages.length,
		});
	}

	/**
	 * DSH 审批/提问 server-request：解析帧 → 登记 pending → 转 agents:ui-request。
	 * 帧带 sessionId，与本 runtime 会话不符时忽略（泵按 runtime 隔离订阅）。
	 */
	private handleServerRequest(
		runtime: DshAgentRuntime,
		frame: { rpcId?: unknown; payload?: unknown },
		payload: Record<string, unknown>,
	): void {
		if (payload.sessionId !== runtime.sessionId) return;
		const approval = parseDshApprovalFrame(frame);
		if (approval) {
			if (this.getAutoAllowApproval()) {
				// 自动放行：不登记 pending、不弹 UI，直接应答 allowed-once（同 sendUIResponse 的确认路径）。
				void this.autoAllowApproval(runtime, approval);
				return;
			}
			this.pendingResponses.set(approval.requestId, approval);
			this.schedulePendingTimeout(runtime.tab.id, approval.requestId);
			this.emit(ipcChannels.agentsUiRequest, approvalUiRequest(approval, runtime.tab.id));
			return;
		}
		const question = parseDshQuestionFrame(frame);
		if (question) {
			this.pendingResponses.set(question.requestId, question);
			this.schedulePendingTimeout(runtime.tab.id, question.requestId);
			this.emit(ipcChannels.agentsUiRequest, questionUiRequest(question, runtime.tab.id));
		}
	}

	/**
	 * pending 审批/提问超时（D5）：用户长时间不响应 Ask 弹窗时，自动应答拒绝并通知
	 * 渲染层 completed——否则 host 侧工具调用永远等不到 client-response，回合不结束，
	 * 后续发送被 waitForIdle 卡满。与 pi 的 scheduleUIRequestTimeout 同语义。
	 */
	private schedulePendingTimeout(agentId: string, requestId: string): void {
		const timer = setTimeout(() => {
			this.pendingTimers.delete(requestId);
			const frame = this.pendingResponses.get(requestId);
			if (!frame) return;
			this.pendingResponses.delete(requestId);
			void (async () => {
				try {
					const client = this.requireClient();
					const value = buildDshRejectValue(frame);
					await client.respond({
						type: "client-response",
						rpcId: requestId as import("@deepseek-ai/dsh-host-apiproxy").RpcId,
						result: { ok: true, value },
					});
				} catch {
					// host 已不可用：应答失败也不阻断 completed 通知
				}
				this.emit(ipcChannels.agentsUiRequest, { agentId, requestId, completed: true });
			})();
		}, DshAgentManager.PENDING_RESPONSE_TIMEOUT_MS);
		timer.unref();
		this.pendingTimers.set(requestId, timer);
	}

	/**
	 * 自动放行应答：复用 buildDshRespondValue 的确认分支（outcome=allowed-once）。
	 * 失败（host 未启动/通道断开）时回退人工审批：登记 pending + 弹 UI，避免请求丢失。
	 */
	private async autoAllowApproval(runtime: DshAgentRuntime, approval: DshApprovalFrame): Promise<void> {
		try {
			const client = this.requireClient();
			const value = buildDshRespondValue(approval, { confirmed: true });
			if (!value) return;
			await client.respond({
				type: "client-response",
				// rpcId 来自 mux 帧（持久化为普通字符串），respond 需要品牌类型：边界一次性转换。
				rpcId: approval.requestId as import("@deepseek-ai/dsh-host-apiproxy").RpcId,
				result: { ok: true, value },
			});
		} catch (error) {
			this.pendingResponses.set(approval.requestId, approval);
			this.schedulePendingTimeout(runtime.tab.id, approval.requestId);
			this.emit(ipcChannels.agentsUiRequest, approvalUiRequest(approval, runtime.tab.id));
		}
	}

	/**
	 * 订阅该会话的 mux 事件流并投影到渲染层通道（agents:message / text-stream / runtime-state）。
	 *
	 * 断连自愈（2026-02 修复）：mux 是 host 侧长连接，host 进程崩溃后桥消息永久中断，
	 * 旧代码的 for await 会悬挂在永远不会结束的流上（会话静默断开）。现在：
	 * - DshHost 在 host 退出时 abortAllPending → 悬挂流以 error 结束；
	 * - pump 捕获后按指数退避重连，重连前确认 host 进程存活且 boot 完成（避免订阅请求
	 *   发到已死进程/未就绪监听上被静默丢弃）。mux 重连只重放 session/subscribed 快照、
	 *   不重放历史事件，消息投影不会重复。
	 */
	private startMux(runtime: DshAgentRuntime): void {
		const controller = new AbortController();
		runtime.muxAbort = controller;
		runtime.pump = (async () => {
			let backoffMs = 250;
			// 首次订阅不补帧（初始 attach 已拉过 history）；重连（非首次）才补（D6）。
			let firstSubscription = true;
			while (!controller.signal.aborted) {
				// host 进程不在/未 ready（崩溃自动重启期间）：等待重新拉起后再订阅。
				if (!this.dshHost.isHostProcessRunning() || !this.dshHost.isHostReady()) {
					await delay(backoffMs, controller.signal);
					backoffMs = Math.min(backoffMs * 2, 2000);
					continue;
				}
				try {
					const client = this.requireClient();
					// D6：mux 重连成功后先补拉断连窗口内已完成的回合（history 只含
					// turn/end 后的事件）；进行中的回合（断连时正在 streaming）无法从
					// history 恢复，重置运行态避免 UI 卡死/流式残留。补帧按 seq 跳过
					// 已投影事件，幂等不重复。首次订阅跳过（初始 attach 已拉过历史）。
					if (!firstSubscription) {
						if (runtime.control.status === "running" || runtime.isStreaming || runtime.isCompacting) {
							runtime.isStreaming = false;
							runtime.isCompacting = false;
							runtime.executingTool = undefined;
							runtime.control = initialDshControl();
							runtime.thinkingId = undefined;
							runtime.thinkingStartedAt = undefined;
							this.emitRuntimeState(runtime.tab.id);
						}
						await this.backfillHistory(runtime);
					}
					firstSubscription = false;
					for await (const frame of client.events.mux({}, controller.signal)) {
						backoffMs = 250; // 收到帧说明流活着，重置退避
						const payload = frame?.payload ?? frame;
						// DSH 审批/提问：server-request 帧（稳定 rpcId），转 PiDeck agents:ui-request。
						// 按 sessionId 归属到对应 runtime 的 agentId，避免跨会话串台。
						if (payload?.type === "approval/requested" || payload?.type === "question/requested") {
							this.handleServerRequest(runtime, frame, payload);
							continue;
						}
						// 投影帧（session-projection RFC）：contextPressure/contextBreakdown 等
						// 单元的值变化实时推送。上下文圆环（ContextMeter）数据源；按会话归属，
						// 只收本 runtime 的帧。历史尾页的 projections 块由 attach/restart 初值兜底。
						if (payload?.type === "session/projection") {
							if (payload.sessionId !== runtime.sessionId) continue;
							this.applyProjectionFrame(runtime, payload);
							continue;
						}
						if (!payload || payload.type !== "session/event") continue;
						if (payload.sessionId !== runtime.sessionId) continue;
						const event = payload.event;
						// 轨迹过程事件：模型切换/权限/plan/goal/压缩命令等非对话记录
						// （pi 会话文件过程事件的 DSH 等价物；与消息投影并行收集）。
						runtime.processEvents = pushDshProcessEvent(
							runtime.processEvents,
							collectDshProcessEvent(runtime.processEvents, event),
						);
						// DSH host 会话标题（dsh-session-title 的 session/title 事件）：
						// 更新 runtime tab + 写回 catalog（侧栏运行中行实时、历史行/重启后持久），
						// 不投影消息、不影响流式状态机。
						if (
							event?.type === "session/title" &&
							event.data !== null &&
							typeof event.data === "object" &&
							typeof (event.data as { title?: unknown }).title === "string" &&
							((event.data as { title: string }).title).trim()
						) {
							const title = (event.data as { title: string }).title.trim();
							if (runtime.tab.title !== title) {
								runtime.tab.title = title;
								this.emit(ipcChannels.agentsState, this.list());
								this.onTitleChanged?.(String(runtime.sessionId), title);
							}
							continue;
						}
						// host 为事件计算的下发 view（tool/call 的卡片模型，dsh-web 同源）；
						// 与事件一起投影，工具消息 meta.view 供渲染层展示命令/描述。
						const eventView = payload.view;
						const eventGeneration = runtime.control.cancelGeneration;
						const controlled = applyDshControlEvent(runtime.control, event?.type, eventGeneration, event?.data);
						this.applyControl(runtime, controlled.next);
						if (controlled.ignoreStream) {
							// 停止后的迟到流：只投影 turn/end（把已流式的部分文本落回骨架，
							// 并收口 cancelled）。assistant/message、chunk、tool 等旧回合残留
							// 一律不投影——否则停止后完整回答/工具卡片继续上屏（「还在跑」），
							// 或被拼进下一条消息（「串台」）。
							if (event?.type === "turn/end") {
								// D8：停止后的迟到 turn/end 不追加 error 气泡（停止 ≠ 回合失败）
								runtime.projection = projectDshEvent(runtime.projection, event, runtime.tab.id, undefined, { skipErrorTurnEnd: true });
								runtime.messages = runtime.projection.messages;
								this.emit(ipcChannels.agentsTextStream, { agentId: runtime.tab.id, text: "", done: true });
								this.emitMessages(runtime);
								// 停止/中断路径的 turn/end 同样收口压缩进行态（D4）
								if (runtime.isCompacting) {
									runtime.isCompacting = false;
									this.emitRuntimeState(runtime.tab.id);
								}
							}
							continue;
						}
						runtime.projection = projectDshEvent(runtime.projection, event, runtime.tab.id, eventView);
						// 投影器是纯函数，必须把消息数组写回 runtime，getMessages / emitMessages 才看得到。
						runtime.messages = runtime.projection.messages;
						// 记录已投影的最大 seq（D6 重连补帧的跳过基准）。
						if (typeof event?.seq === "number" && event.seq > (runtime.lastProjectedSeq ?? 0)) {
							runtime.lastProjectedSeq = event.seq;
						}
						const p = runtime.projection;
						const eventSeq = typeof event?.seq === "number" ? event.seq : 0;
						const eventTime = typeof event?.time === "number" ? event.time : Date.now();
						// 流式正文：与 pi 一致发【累积文本】（渲染层 streamingTextByIdAtom 按累积语义
						// 存储，发增量会逐帧覆盖、表现为「流式异常/终态才出全文」）。
						if (p.deltaText !== undefined) {
							this.emit(ipcChannels.agentsTextStream, {
								agentId: runtime.tab.id,
								text: p.pendingAssistantText,
								done: false,
							});
						}
						// 思考流：agents:thinking 独立通道（与 pi 对齐）。id 必须与渲染层
						// buildTurnDisplay 的 group id 一致（msg-thinking-<消息 id>，消息 id
						// = 骨架消息 id = dsh:<首个 delta 的 seq>），否则 Live 思考命中不了
						// atom、只能等终态一次性出现。终态（assistant/message / turn/end
						// 清空 pending）补发 done。
						if (p.deltaReasoning !== undefined) {
							runtime.thinkingId ??= `msg-thinking-${p.pendingAssistantId ?? `dsh:${eventSeq}`}`;
							runtime.thinkingStartedAt ??= eventTime;
							this.emit(ipcChannels.agentsThinking, {
								agentId: runtime.tab.id,
								id: runtime.thinkingId,
								text: p.pendingAssistantThinking,
								startedAt: runtime.thinkingStartedAt,
								done: false,
							});
						}
						if (runtime.thinkingId && p.deltaReasoning === undefined && p.pendingAssistantThinking === "") {
							// 思考段收尾：text 留空，渲染层用 prev.text 兑底（跨通道乱序防 remount 同 pi）；
							// endedAt = 终态事件时间（渲染层思考块耗时 = endedAt - startedAt）。
							this.emit(ipcChannels.agentsThinking, {
								agentId: runtime.tab.id,
								id: runtime.thinkingId,
								text: "",
								startedAt: runtime.thinkingStartedAt ?? 0,
								endedAt: eventTime,
								done: true,
							});
							runtime.thinkingId = undefined;
							runtime.thinkingStartedAt = undefined;
						}
						// 状态变化
						if (p.stateChanged) {
							runtime.executingTool = p.executingTool;
							if (p.model) runtime.model = p.model;
							// 路由上下文容量（request/context 的 contextWindow）：圆环窗口兜底源
							if (p.contextWindow !== undefined) runtime.contextWindow = p.contextWindow;
							// G16：usage 随投影同步（assistant/message 更新）
							if (p.usage) runtime.usage = p.usage;
							// G5：goal 随投影同步（goal/change 更新；clear 时 p.goal 为 undefined）。
							// event.type 是 dsh-session 已知事件联合（不含 goal/change 声明），
							// 这里按字符串比较（宿主包未合并 dsh-goal 的 module 声明）。
							if ((event as { type?: string } | undefined)?.type === "goal/change") runtime.goal = p.goal;
							// DSH 权限预设 / plan 模式（/permission /plan 命令事件折叠）：
							// 同步进 runtime state，渲染层底栏/模式按钮即时反映。
							if (p.permissionPreset !== undefined) runtime.permissionPreset = p.permissionPreset;
							runtime.planModeActive = p.planModeActive;
							this.emitRuntimeState(runtime.tab.id);
						}
						if (p.turnEnded) {
							// 终态：清空流式缓冲，全量 flush 消息
							this.emit(ipcChannels.agentsTextStream, { agentId: runtime.tab.id, text: "", done: true });
							this.emitMessages(runtime);
							// /compact 命令回合收口：复位压缩进行态（D4）
							if (runtime.isCompacting) {
								runtime.isCompacting = false;
								this.emitRuntimeState(runtime.tab.id);
							}
						}
						if (p.messagesChanged && !p.turnEnded) {
							this.emitMessages(runtime);
							// assistant/message 已把终态消息落进时间线：立即关闭流式槽
							// （agents:text-stream done）。否则会话级 live 槽要等 turn/end 才关，
							// 带工具调用的回合里「本轮模型输出」会滞留成双显/流式残留。
							// 下一轮 LLM 流开始时重新打开，互不冲突。
							if (event?.type === "assistant/message") {
								this.emit(ipcChannels.agentsTextStream, {
									agentId: runtime.tab.id,
									text: "",
									done: true,
								});
							}
						}
					}
					// 流正常结束（host 主动关闭）：等价断连，走退避重连。
				} catch {
					// 流错误（host 崩溃 abortAllPending → controller.error）或 host 未启动：走退避重连。
				}
				if (controller.signal.aborted) break;
				await delay(backoffMs, controller.signal);
				backoffMs = Math.min(backoffMs * 2, 2000);
			}
		})().catch((error) => {
			if (controller.signal.aborted) return;
			console.error("[dsh-agent] mux pump error:", error);
		});
	}
}

/** 等待指定毫秒；signal abort 时提前返回（配合 pump 的退出检查）。 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
}

function initialDshControl(): DshControlState {
	return {
		status: "idle",
		isStreaming: false,
		cancelGeneration: 0,
		cancelled: false,
	};
}

type DshAgentRuntime = {
	tab: AgentTab;
	sessionId: SessionId;
	cwd: string;
	messages: ChatMessage[];
	projection: DshProjection;
	muxAbort?: AbortController;
	pump?: Promise<void>;
	isStreaming: boolean;
	control: DshControlState;
	executingTool?: string;
	model?: { provider: string; model: string };
	thinkingLevel?: string;
	/** DSH 权限预设（permission/preset 事件折叠；read-only/workspace-write/danger-full-access）。 */
	permissionPreset?: string;
	/** DSH plan 模式（plan/mode 事件折叠）。 */
	planModeActive?: boolean;
	/** /compact 命令回合进行中（命令已发出、turn/end 未到）；UI 压缩按钮显示进行态。 */
	isCompacting?: boolean;
	/** 已投影的最大事件 seq（D6：mux 重连补帧时跳过已投影事件，避免重复）。 */
	lastProjectedSeq?: number;
	/** 最近一次 assistant 回合的 token 用量（G16；assistant/message 事件投影更新）。 */
	usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
	/**
	 * 上下文占用投影（host contextPressure 单元）：provider 上报的最新请求大小 +
	 * 下一条请求的估算成本 + 路由容量。mux session/projection 帧与 attach 初值双来源，
	 * 供上下文圆环（ContextMeter）展示 DSH 会话占用。
	 */
	contextPressure?: { pressureTokens?: number; projectedTokens?: number; contextWindow?: number };
	/** 上下文构成投影（host contextBreakdown 单元）：系统提示/工具 schema/对话的启发式估算。 */
	contextBreakdown?: { systemTokens: number; toolsTokens: number; messageTokens: number };
	/** 路由上下文容量（request/context 事件的 contextWindow；无 pressure 投影时的兜底窗口）。 */
	contextWindow?: number;
	/** 轨迹过程事件（modelChange/permission/plan/goal/compaction；pi 会话文件过程事件的 DSH 等价物）。 */
	processEvents: SessionProcessEvent[];
	/** 当前 goal（G5；goal/change 事件投影更新，clear 后为 undefined）。 */
	goal?: {
		refId: string;
		revision: number;
		objective: string;
		phase: "active" | "paused" | "blocked" | "complete";
		maxGoalRounds: number;
		roundsStarted: number;
	};
	/** 进行中的思考段 id（turn 内首个 reasoning-delta 起登记；终态清空）。 */
	thinkingId?: string;
	thinkingStartedAt?: number;
};
