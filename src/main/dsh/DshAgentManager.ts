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
// DSH 会话 id 品牌类型（零运行时成本，仅类型擦除）
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { ipcChannels } from "../../shared/ipc";
import type { SessionAgentGateway } from "../sessions/SessionRuntimeCoordinator";
import type { DshHost } from "./DshHost";
import { projectDshEvent, type DshProjection } from "./dshEventProjector";
import {
	applyDshControlEvent,
	beginDshCancel,
	type DshControlState,
} from "./dshRuntimeControl";
import {
	approvalUiRequest,
	buildDshRespondValue,
	parseDshApprovalFrame,
	parseDshQuestionFrame,
	questionUiRequest,
	type DshApprovalFrame,
	type DshQuestionFrame,
} from "./dshApprovalBridge";

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
export class DshAgentManager implements SessionAgentGateway {
	readonly backend: AgentBackend = "dsh";
	/** 已支持的可选能力：fork（session.fork 锚 seq 裁剪）与 compact（/compact 命令）。 */
	readonly capabilities: ReadonlySet<AgentGatewayCapability> = new Set([
		"fork",
		"getForkMessages",
		"compact",
	]);

	private readonly runtimes = new Map<string, DshAgentRuntime>();
	private readonly outputListeners = new Set<(channel: string, payload: unknown) => void>();
	/** 待应答的 DSH server-request 帧：rpcId → frame（approval/question 共用一张表）。 */
	private readonly pendingResponses = new Map<string, DshApprovalFrame | DshQuestionFrame>();

	constructor(
		private readonly dshHost: DshHost,
		private readonly getProject: (id: string) => Project | undefined,
		/** 审批自动放行开关：运行时读取（默认关闭），true 时 approval 帧直接应答 allowed-once。 */
		private readonly getAutoAllowApproval: () => boolean = () => false,
	) {}

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

	async create(input: CreateAgentInput): Promise<AgentTab> {
		const project = this.getProject(input.projectId);
		if (!project) throw new Error(`Project not found: ${input.projectId}`);
		const client = await this.ensureClient();
		const cwd = project.path;

		// attach 路径（重启恢复）：catalog 已持久化 DSH sessionId 时复用旧会话，
		// 不新建——DSH 会话由 host 持久化（$DSH_HOME），重建会丢失对话历史。
		let sessionId: string = "";
		let attached = false;
		if (input.dshSessionId) {
			const listed = await client.sessions.list({});
			if (listed.result.ok) {
				const existing = listed.result.value.items.some(
					(item) => item.sessionId === input.dshSessionId,
				);
				if (existing) {
					sessionId = input.dshSessionId;
					attached = true;
				} else {
					// 持久化 id 在 host 里已不存在（DSH_HOME 被清/更换）：退回新建。
					const created = await client.sessions.create({ cwd });
					if (!created.result.ok) {
						throw new Error(`dsh session.create failed: ${JSON.stringify(created.result.error)}`);
					}
					sessionId = created.result.value.sessionId;
				}
			} else {
				throw new Error(`dsh session.list failed: ${JSON.stringify(listed.result.error)}`);
			}
		} else {
			const created = await client.sessions.create({ cwd });
			if (!created.result.ok) {
				throw new Error(`dsh session.create failed: ${JSON.stringify(created.result.error)}`);
			}
			sessionId = created.result.value.sessionId;
		}

		// catalog 持久化的是普通字符串，host API 需要品牌类型：边界处一次性转换。
		const dshSessionId = sessionId as SessionId;

		const agentId = `dsh:${sessionId}`;
		const tab: AgentTab = {
			id: agentId,
			projectId: input.projectId,
			cwd,
			title: input.title ?? "DSH 会话",
			status: "idle",
			sessionId,
			backend: "dsh",
			noSession: input.noSession,
			createdAt: Date.now(),
		};
		const runtime: DshAgentRuntime = {
			tab,
			sessionId: dshSessionId,
			cwd,
			messages: [],
			projection: projectDshEvent(undefined, undefined, agentId),
			isStreaming: false,
			control: initialDshControl(),
		};
		// attach 旧会话：拉历史尾部投影为初始消息（重启后能直接看到旧对话），
		// 投影器按 source.kind 过滤注入上下文，时间线只含真实对话。
		if (attached) {
			const history = await client.sessions.history({ sessionId: dshSessionId, maxMessages: 200 }).catch(() => null);
			if (history?.result.ok) {
				const events = (history.result.value.events ?? [])
					.map((entry) => entry.event)
					.filter((event): event is NonNullable<typeof event> => Boolean(event))
					.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
				for (const event of events) {
					runtime.projection = projectDshEvent(runtime.projection, event, agentId);
				}
				runtime.messages = runtime.projection.messages;
			}
		}
		this.runtimes.set(agentId, runtime);
		this.startMux(runtime);
		this.emit(ipcChannels.agentsState, this.list());
		return tab;
	}

	async sendPrompt(input: SendPromptInput): Promise<SendPromptResult> {
		const runtime = this.runtime(input.agentId);
		const client = this.requireClient();
		const sent = await client.sessions.prompt({
			sessionId: runtime.sessionId,
			mode: "queue",
			content: [{ type: "text", text: input.message }],
		});
		if (!sent.result.ok) {
			return { accepted: false, error: JSON.stringify(sent.result.error), delivery: "rejected" };
		}
		return { accepted: true };
	}

	async restart(agentId: string): Promise<AgentTab> {
		// v1：停止旧会话并新建（同 cwd），保持 agentId 不变，映射到新 dsh sessionId。
		const old = this.runtime(agentId);
		const { cwd, projectId, title } = old.tab;
		await this.stop(agentId);
		const client = await this.ensureClient();
		const created = await client.sessions.create({ cwd });
		if (!created.result.ok) {
			throw new Error(`dsh session.create (restart) failed: ${JSON.stringify(created.result.error)}`);
		}
		const sessionId = created.result.value.sessionId;
		const tab: AgentTab = {
			...old.tab,
			id: agentId,
			projectId,
			cwd,
			title,
			sessionId,
			status: "idle",
			createdAt: Date.now(),
		};
		const runtime: DshAgentRuntime = {
			tab,
			sessionId,
			cwd,
			messages: [],
			projection: projectDshEvent(undefined, undefined, agentId),
			isStreaming: false,
			control: initialDshControl(),
		};
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
		this.runtimes.delete(agentId);
		this.emit(ipcChannels.agentsState, this.list());
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

	async abort(agentId: string): Promise<void> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		// 先抬世代再 cancel：mux 里迟到的 chunk/turn/start 必须丢掉，否则停止按钮会一直亮。
		this.applyControl(runtime, beginDshCancel(runtime.control));
		await client.sessions.cancel({ sessionId: runtime.sessionId }).catch(() => undefined);
		this.emitRuntimeState(agentId);
		this.emit(ipcChannels.agentsState, this.list());
	}

	async rename(agentId: string, name: string): Promise<AgentTab> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const renamed = await client.sessions.rename({ sessionId: runtime.sessionId, title: name });
		if (renamed.result.ok) runtime.tab.title = renamed.result.value.title;
		return runtime.tab;
	}

	async compact(agentId: string, prompt?: string): Promise<AgentRuntimeState> {
		// DSH 的压缩走 host 侧 /compact 命令注册表（dsh-command-compact），
		// wire 上没有显式 compact RPC（计划 D11）：以 queue 提示词触发，随后返回当前 runtime 状态。
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
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
		return this.getRuntimeState(agentId);
	}

	async getRuntimeState(agentId: string): Promise<AgentRuntimeState> {
		const runtime = this.runtime(agentId);
		return {
			isStreaming: runtime.isStreaming,
			isExecutingTool: runtime.executingTool !== undefined,
			executingToolName: runtime.executingTool,
			modelName: runtime.model?.model,
			provider: runtime.model?.provider,
			modelId: runtime.model?.model,
			thinkingLevel: runtime.thinkingLevel,
		};
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
		const client = this.requireClient();
		const page = await client.sessions.history({
			sessionId: dshSessionId as SessionId,
			beforeSeq,
			maxMessages,
		});
		if (!page.result.ok) {
			return { messages: [], total: 0, nextBefore: null };
		}
		const events = (page.result.value.events ?? [])
			.map((entry) => entry.event)
			.filter((event): event is NonNullable<typeof event> => Boolean(event))
			.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
		const agentId = `dsh:${dshSessionId}`;
		let projection = projectDshEvent(undefined, undefined, agentId);
		for (const event of events) {
			projection = projectDshEvent(projection, event, agentId);
		}
		const hasMore = page.result.value.hasMore === true;
		const oldestSeq = events.length > 0 ? events[0].seq : undefined;
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
		const groups = models.result.value.groups ?? [];
		const result: AvailableModel[] = [];
		for (const group of groups) {
			for (const model of group.models ?? []) {
				result.push({ id: model.id, name: model.name, provider: group.id });
			}
		}
		return result;
	}

	async prepareResendFromMessage(
		agentId: string,
		messageId: string,
	): Promise<{ text: string; images?: ImageContent[] }> {
		const message = this.runtime(agentId).messages.find((item) => item.id === messageId);
		if (!message) throw new Error(`Message not found: ${messageId}`);
		return { text: message.text };
	}

	async setModel(agentId: string, provider: string, modelId: string): Promise<unknown> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const selected = await client.sessions.selectModel({
			sessionId: runtime.sessionId,
			provider,
			model: modelId,
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
		const runtime = this.runtime(agentId);
		const seqMatch = /^seq:(\d+)$/.exec(entryId);
		if (!seqMatch) throw new Error(`Invalid dsh fork entryId: ${entryId}`);
		const atSeq = Number(seqMatch[1]);
		const client = this.requireClient();
		const forked = await client.sessions.fork({
			sessionId: runtime.sessionId,
			atSeq,
		});
		if (!forked.result.ok) {
			throw new Error(`dsh session.fork failed: ${JSON.stringify(forked.result.error)}`);
		}
		const newSessionId = forked.result.value.sessionId;
		const forkedText = runtime.messages.find(
			(message) => message.role === "user" && message.id === `dsh:${atSeq}`,
		)?.text;
		// 停旧 mux，换绑到新会话并拉历史（fork 会话自带 atSeq 前历史）。
		await this.stop(agentId);
		const tab: AgentTab = {
			...runtime.tab,
			sessionId: newSessionId,
			status: "idle",
			createdAt: Date.now(),
		};
		const nextRuntime: DshAgentRuntime = {
			...runtime,
			tab,
			sessionId: newSessionId,
			messages: [],
			projection: projectDshEvent(undefined, undefined, agentId),
			isStreaming: false,
			control: initialDshControl(),
		};
		const history = await client.sessions.history({ sessionId: newSessionId, maxMessages: 200 }).catch(() => null);
		if (history?.result.ok) {
			const events = (history.result.value.events ?? [])
				.map((entry) => entry.event)
				.filter((event): event is NonNullable<typeof event> => Boolean(event))
				.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
			for (const event of events) {
				nextRuntime.projection = projectDshEvent(nextRuntime.projection, event, agentId);
			}
			nextRuntime.messages = nextRuntime.projection.messages;
		}
		this.runtimes.set(agentId, nextRuntime);
		this.startMux(nextRuntime);
		this.emit(ipcChannels.agentsState, this.list());
		this.emitMessages(nextRuntime);
		this.emitRuntimeState(agentId);
		// 返回 fork 点文案（渲染层把它预填到输入框，与 pi 一致）
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
			this.emit(ipcChannels.agentsUiRequest, approvalUiRequest(approval, runtime.tab.id));
			return;
		}
		const question = parseDshQuestionFrame(frame);
		if (question) {
			this.pendingResponses.set(question.requestId, question);
			this.emit(ipcChannels.agentsUiRequest, questionUiRequest(question, runtime.tab.id));
		}
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
			while (!controller.signal.aborted) {
				// host 进程不在/未 ready（崩溃自动重启期间）：等待重新拉起后再订阅。
				if (!this.dshHost.isHostProcessRunning() || !this.dshHost.isHostReady()) {
					await delay(backoffMs, controller.signal);
					backoffMs = Math.min(backoffMs * 2, 2000);
					continue;
				}
				try {
					const client = this.requireClient();
					for await (const frame of client.events.mux({}, controller.signal)) {
						backoffMs = 250; // 收到帧说明流活着，重置退避
						const payload = frame?.payload ?? frame;
						// DSH 审批/提问：server-request 帧（稳定 rpcId），转 PiDeck agents:ui-request。
						// 按 sessionId 归属到对应 runtime 的 agentId，避免跨会话串台。
						if (payload?.type === "approval/requested" || payload?.type === "question/requested") {
							this.handleServerRequest(runtime, frame, payload);
							continue;
						}
						if (!payload || payload.type !== "session/event") continue;
						if (payload.sessionId !== runtime.sessionId) continue;
						const event = payload.event;
						const eventGeneration = runtime.control.cancelGeneration;
						const controlled = applyDshControlEvent(runtime.control, event?.type, eventGeneration, event?.data);
						this.applyControl(runtime, controlled.next);
						if (controlled.ignoreStream) {
							// 停止后的迟到流：终态消息仍投影（方便落一条中止痕迹），但不重开 streaming。
							if (event?.type === "turn/end" || event?.type === "assistant/message") {
								runtime.projection = projectDshEvent(runtime.projection, event, runtime.tab.id);
								runtime.messages = runtime.projection.messages;
								this.emit(ipcChannels.agentsTextStream, { agentId: runtime.tab.id, text: "", done: true });
								this.emitMessages(runtime);
								this.emitRuntimeState(runtime.tab.id);
							}
							continue;
						}
						runtime.projection = projectDshEvent(runtime.projection, event, runtime.tab.id);
						// 投影器是纯函数，必须把消息数组写回 runtime，getMessages / emitMessages 才看得到。
						runtime.messages = runtime.projection.messages;
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
						// 思考流：agents:thinking 独立通道（与 pi 对齐）。turn 内首个 reasoning-delta
						// 登记 thinking 段 id；终态（assistant/message / turn/end 清空 pending）补发 done。
						if (p.deltaReasoning !== undefined) {
							runtime.thinkingId ??= `dsh-thinking-${eventSeq}`;
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
							// 思考段收尾：text 留空，渲染层用 prev.text 兑底（跨通道乱序防 remount 同 pi）。
							this.emit(ipcChannels.agentsThinking, {
								agentId: runtime.tab.id,
								id: runtime.thinkingId,
								text: "",
								startedAt: runtime.thinkingStartedAt ?? 0,
								done: true,
							});
							runtime.thinkingId = undefined;
							runtime.thinkingStartedAt = undefined;
						}
						// 状态变化
						if (p.stateChanged) {
							runtime.executingTool = p.executingTool;
							if (p.model) runtime.model = p.model;
							this.emitRuntimeState(runtime.tab.id);
						}
						if (p.turnEnded) {
							// 终态：清空流式缓冲，全量 flush 消息
							this.emit(ipcChannels.agentsTextStream, { agentId: runtime.tab.id, text: "", done: true });
							this.emitMessages(runtime);
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
	/** 进行中的思考段 id（turn 内首个 reasoning-delta 起登记；终态清空）。 */
	thinkingId?: string;
	thinkingStartedAt?: number;
};
