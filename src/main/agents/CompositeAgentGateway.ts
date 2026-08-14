import type {
	AgentBackend,
	AgentGatewayCapability,
	AgentRuntimeState,
	AgentTab,
	AvailableModel,
	ChatMessage,
	CreateAgentInput,
	ImageContent,
	SendPromptInput,
	SendPromptResult,
	SessionUiResponseInput,
} from "../../shared/types";
import type { SessionAgentGateway } from "../sessions/SessionRuntimeCoordinator";

/**
 * 多后端 agent 网关装配器：把 pi / dsh 等具体网关聚合成一个
 * `SessionAgentGateway`，供 SessionRuntimeCoordinator 无感消费。
 *
 * 路由规则：
 * - `create(input)` 按 `input.backend`（缺省走 `defaultBackend`，即 pi）选择网关；
 * - 其余按 agentId 路由到持有该 agent 的网关（ownerByAgent 缓存 + list() 兜底查找）；
 * - `onOutput` 聚合转发所有子网关事件（统一桥接进 sessions:runtime-event 用）。
 *
 * 能力（capabilities）取所有子网关的并集；具体能力缺失仍由各网关自行声明，
 * 上层 UI 按能力禁用入口。
 */
export class CompositeAgentGateway implements SessionAgentGateway {
	private readonly byBackend = new Map<AgentBackend, SessionAgentGateway>();
	private readonly ownerByAgent = new Map<string, SessionAgentGateway>();

	constructor(
		private readonly gateways: SessionAgentGateway[],
		private readonly defaultBackend: AgentBackend = "pi",
	) {
		for (const gateway of gateways) {
			this.byBackend.set(gateway.backend, gateway);
		}
	}

	/** 合成网关的身份：对外以默认后端自居（仅用于接口自洽，实际路由按 agent 归属）。 */
	get backend(): AgentBackend {
		return this.defaultBackend;
	}

	/** 可选能力并集。 */
	get capabilities(): ReadonlySet<AgentGatewayCapability> {
		const union = new Set<AgentGatewayCapability>();
		for (const gateway of this.gateways) {
			for (const capability of gateway.capabilities) union.add(capability);
		}
		return union;
	}

	/** 按 backend 解析网关；未知 backend 抛错（装配层应保证注册完整）。 */
	private resolveBackend(backend: AgentBackend | undefined): SessionAgentGateway {
		const target = backend ?? this.defaultBackend;
		const gateway = this.byBackend.get(target);
		if (!gateway) {
			throw new Error(`CompositeAgentGateway: no gateway for backend "${target}"`);
		}
		return gateway;
	}

	/** 按 agentId 定位网关；未知 agent 抛错（Coordinator 会转成 SESSION_COMMAND_FAILED）。 */
	private owner(agentId: string): SessionAgentGateway {
		const cached = this.ownerByAgent.get(agentId);
		if (cached) return cached;
		for (const gateway of this.gateways) {
			if (gateway.list().some((tab) => tab.id === agentId)) {
				this.ownerByAgent.set(agentId, gateway);
				return gateway;
			}
		}
		throw new Error(`CompositeAgentGateway: no gateway owns agent "${agentId}"`);
	}

	/**
	 * 可选能力转发：子网关未实现该方法（capabilities 未声明）时抛错，
	 * 语义与后端自身显式 throw 一致，由 Coordinator 转 SESSION_COMMAND_FAILED。
	 */
	private callOptional<T>(
		agentId: string,
		capability: string,
		invoke: (gateway: SessionAgentGateway) => T | undefined,
	): T {
		const gateway = this.owner(agentId);
		const result = invoke(gateway);
		if (result === undefined) {
			throw new Error(
				`CompositeAgentGateway: backend "${gateway.backend}" does not support ${capability}`,
			);
		}
		return result;
	}

	list(): AgentTab[] {
		return this.gateways.flatMap((gateway) => gateway.list());
	}

	async sendPrompt(input: SendPromptInput): Promise<SendPromptResult> {
		return this.owner(input.agentId).sendPrompt(input);
	}

	getMessages(agentId: string): ChatMessage[] {
		return this.owner(agentId).getMessages(agentId);
	}

	async create(input: CreateAgentInput): Promise<AgentTab> {
		const gateway = this.resolveBackend(input.backend);
		const tab = await gateway.create(input);
		this.ownerByAgent.set(tab.id, gateway);
		return tab;
	}

	async restart(agentId: string): Promise<AgentTab> {
		const gateway = this.owner(agentId);
		const tab = await gateway.restart(agentId);
		this.ownerByAgent.set(tab.id, gateway);
		return tab;
	}

	async stop(agentId: string): Promise<void> {
		return this.owner(agentId).stop(agentId);
	}

	async rename(agentId: string, name: string): Promise<AgentTab> {
		return this.owner(agentId).rename(agentId, name);
	}

	async abort(agentId: string): Promise<void> {
		return this.owner(agentId).abort(agentId);
	}

	async compact(agentId: string, prompt?: string): Promise<AgentRuntimeState> {
		return this.owner(agentId).compact(agentId, prompt);
	}

	async getRuntimeState(agentId: string): Promise<AgentRuntimeState> {
		return this.owner(agentId).getRuntimeState(agentId);
	}

	async getCommands(agentId: string): Promise<unknown[]> {
		return this.callOptional(agentId, "getCommands", (gateway) => gateway.getCommands?.(agentId));
	}

	async getAvailableModels(agentId: string): Promise<AvailableModel[]> {
		return this.owner(agentId).getAvailableModels(agentId);
	}

	async exportHtml(agentId: string): Promise<unknown> {
		return this.callOptional(agentId, "exportHtml", (gateway) => gateway.exportHtml?.(agentId));
	}

	async editMessage(agentId: string, messageId: string, newText: string): Promise<void> {
		return this.callOptional(agentId, "editMessage", (gateway) =>
			gateway.editMessage?.(agentId, messageId, newText));
	}

	async deleteMessage(agentId: string, messageId: string): Promise<void> {
		return this.callOptional(agentId, "deleteMessage", (gateway) =>
			gateway.deleteMessage?.(agentId, messageId));
	}

	async prepareResendFromMessage(
		agentId: string,
		messageId: string,
	): Promise<{ text: string; images?: ImageContent[] }> {
		return this.owner(agentId).prepareResendFromMessage(agentId, messageId);
	}

	async setModel(agentId: string, provider: string, modelId: string): Promise<unknown> {
		return this.owner(agentId).setModel(agentId, provider, modelId);
	}

	async setThinking(agentId: string, level: string): Promise<unknown> {
		return this.owner(agentId).setThinking(agentId, level);
	}

	async publishRuntimeState(agentId: string): Promise<void> {
		return this.owner(agentId).publishRuntimeState(agentId);
	}

	async getForkMessages(agentId: string): Promise<Array<{ entryId: string; text: string }>> {
		return this.owner(agentId).getForkMessages(agentId);
	}

	async forkSession(agentId: string, entryId: string): Promise<unknown> {
		return this.owner(agentId).forkSession(agentId, entryId);
	}

	async sendUIResponse(
		agentId: string,
		requestId: string,
		response: SessionUiResponseInput["response"],
	): Promise<unknown> {
		return this.owner(agentId).sendUIResponse(agentId, requestId, response);
	}

	notifyAskPending(
		agentId: string,
		sessionId: string,
		sessionTitle: string,
		question: string,
	): void {
		for (const gateway of this.gateways) {
			if (gateway.list().some((tab) => tab.id === agentId)) {
				gateway.notifyAskPending(agentId, sessionId, sessionTitle, question);
				return;
			}
		}
	}

	onOutput(listener: (channel: string, payload: unknown) => void): () => void {
		const unsubscribers = this.gateways.map((gateway) => gateway.onOutput(listener));
		return () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
	}
}
