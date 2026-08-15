import { randomUUID } from "node:crypto";
import {
	marshalFetchRequest,
	parseDshFetchMessage,
	type DshFetchMessage,
} from "./dshHostBridge";

/**
 * DSH v2 传输（utilityProcess 桥）的 fetch 抽象：
 * `doFetch` 的承运人。主进程实现走 UtilityProcess.postMessage；
 * 测试用内存实现模拟 host 侧响应。
 */
export interface DshFetchTransport {
	/** 发送一条桥消息（fetch-request / fetch-abort）。 */
	send(message: DshFetchMessage): void;
	/** 订阅 host → main 的桥消息。返回退订函数。 */
	onMessage(listener: (message: DshFetchMessage) => void): () => void;
	/** 释放传输（退出清理）。 */
	dispose(): void;
}

/** 一次 in-flight fetch 的 pending 状态。 */
type PendingFetch = {
	resolve: (response: Response) => void;
	reject: (error: Error) => void;
	/** 请求超时定时器（E2：transport 死亡后请求不能永久悬挂）；结算时清理。 */
	timer?: NodeJS.Timeout;
	/** 外部 abort signal 与已注册的监听器（E8：结算时必须移除，避免长生命周期 signal 累积监听）。 */
	signal?: AbortSignal;
	abortHandler?: () => void;
	/** 流式响应组装中（fetch-stream-start 后建立）。 */
	stream?: {
		controller: ReadableStreamDefaultController<Uint8Array>;
		closed: boolean;
		/** 消费者 cancel 过：后续 chunk 丢弃。 */
		cancelled: boolean;
	};
};

export type DshApiClientOptions = {
	/** 桥传输（utilityProcess / 内存测试实现）。 */
	transport: DshFetchTransport;
	/** 懒加载 @deepseek-ai/dsh-host-apiproxy 模块（ESM-only 动态 import）。 */
	loadModule: () => Promise<typeof import("@deepseek-ai/dsh-host-apiproxy")>;
	/** 日志（可选；默认静默）。 */
	log?: (message: string, detail?: unknown) => void;
	/** 请求超时（毫秒；默认 30s）。流式请求在 fetch-stream-start 到达后不再受此限制。 */
	timeoutMs?: number;
};

/**
 * AbstractApiClient 的桥接实现：把官方客户端实例的 `doFetch` 覆写为桥接实现，
 * fetch 请求经 DshFetchTransport（MessagePort）送到 utilityProcess 里的 DSH host，
 * 响应/SSE 流按 dshHostBridge 协议回传并组装成标准 Response。
 *
 * 形态对应 docs/dsh-agent-backend-plan.md §3.2 形态 b；PiDeck 侧
 * DshAgentManager 面对同一 ApiProxy 契约，传输替换不感知。
 */
export class DshApiClient {
	private client: import("@deepseek-ai/dsh-host-apiproxy").AbstractApiClient | null = null;
	private readonly pending = new Map<string, PendingFetch>();
	private readonly unsubscribe: () => void;
	private readonly transport: DshFetchTransport;
	private readonly loadModule: () => Promise<typeof import("@deepseek-ai/dsh-host-apiproxy")>;
	private readonly log: (message: string, detail?: unknown) => void;
	/** dispose 后置位：拒绝新请求、abort/流取消回调不再向已死 transport 发消息。 */
	private disposed = false;
	private readonly timeoutMs: number;

	constructor(options: DshApiClientOptions) {
		this.transport = options.transport;
		this.loadModule = options.loadModule;
		this.log = options.log ?? (() => undefined);
		this.timeoutMs = options.timeoutMs ?? 30_000;
		this.unsubscribe = this.transport.onMessage((message) => {
			const parsed = parseDshFetchMessage(message);
			if (parsed) this.handleMessage(parsed);
		});
	}

	/** 懒加载官方客户端并覆写 doFetch 为桥接实现（抽象类动态继承，避免实例化抽象基类）。 */
	async getClient(): Promise<import("@deepseek-ai/dsh-host-apiproxy").AbstractApiClient> {
		if (this.client) return this.client;
		const module = await this.loadModule();
		// AbstractApiClient 是抽象类（doFetch 抽象）：动态建一个具体子类，
		// 只覆写 doFetch，其余（postJson/readSse/领域方法）全部继承。
		const Base = module.AbstractApiClient as unknown as new () => import("@deepseek-ai/dsh-host-apiproxy").AbstractApiClient;
		class BridgedClient extends Base {
			override doFetch(
				input: URL,
				init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
			): Promise<Response> {
				return this.owner.bridgedFetch(input, init);
			}
			owner!: DshApiClient;
		}
		const client = new BridgedClient();
		client.owner = this;
		this.client = client;
		return client;
	}

	/** 真正的桥接 fetch：发 fetch-request，等 unary 响应或组装流式响应。 */
	private bridgedFetch(
		input: URL,
		init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
	): Promise<Response> {
		// host 已 dispose：不再向桥发消息（transport.send 已静默丢弃，这里直接拒绝
		// 更快暴露问题，且不产生悬挂的 pending）。
		if (this.disposed) {
			return Promise.reject(new Error("DSH host transport disposed"));
		}
		const id = randomUUID();
		const request = marshalFetchRequest(id, input, init);
		return new Promise<Response>((resolve, reject) => {
			// 外部 signal 已中止：直接拒绝（不向 host 发请求）。
			if (init?.signal?.aborted) {
				reject(new DOMException("The operation was aborted.", "AbortError"));
				return;
			}
			// E2：请求超时——transport 死亡（host 崩溃且重启超限放弃）后，host 侧不会有
			// 任何响应帧，悬挂 pending 会让 IPC 永久挂起。流式请求在 fetch-stream-start
			// 到达后由 abort/fetch-end 管理，不再受此超时限制（mux 是长连接）。
			const timer = setTimeout(() => {
				const pending = this.pending.get(id);
				if (!pending) return;
				if (pending.stream) return;
				this.pending.delete(id);
				this.log(`fetch timed out after ${this.timeoutMs}ms`, { id });
				reject(new Error(`DSH bridge fetch timed out after ${this.timeoutMs}ms`));
			}, this.timeoutMs);
			timer.unref();
			const pending: PendingFetch = { resolve, reject, timer };
			this.pending.set(id, pending);
			this.transport.send(request);
			// abort 转发：host 侧 req.signal 联动取消（SSE 流 / 超时）；
			// 同时本地 promise 也要 reject（与 InProcessApiClient.doFetch 的 abort 契约一致）。
			// E8：结算时（settlePending）必须 removeEventListener，否则长生命周期 signal
			// （会话级 controller，mux 重连多次复用）下监听器随请求数累积。
			const abortHandler = () => {
				// dispose 后 abort 回调仍可能触发（外部 signal 生命周期比 client 长）：
				// 不再向已死 transport 发消息，只清 pending。
				if (this.disposed) {
					this.settlePending(id, undefined, new DOMException("The operation was aborted.", "AbortError"));
					return;
				}
				this.transport.send({ type: "fetch-abort", id });
				const current = this.pending.get(id);
				if (current) {
					this.pending.delete(id);
					const stream = current.stream;
					if (stream && !stream.closed) {
						stream.closed = true;
						try {
							stream.controller.error(new DOMException("The operation was aborted.", "AbortError"));
						} catch {
							// 已关闭忽略
						}
					}
					if (current.timer) clearTimeout(current.timer);
					current.reject(new DOMException("The operation was aborted.", "AbortError"));
				}
			};
			pending.abortHandler = abortHandler;
			if (init?.signal) {
				pending.signal = init.signal;
				init.signal.addEventListener("abort", abortHandler, { once: true });
			}
		});
	}

	/** 结算 pending：清超时定时器 + 移除 abort 监听器（E2/E8）。 */
	private settlePending(id: string, resolveWith: Response | undefined, rejectWith: Error): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		this.cleanupPending(pending);
		if (resolveWith !== undefined) pending.resolve(resolveWith);
		else pending.reject(rejectWith);
	}

	/** 清理 pending 的超时定时器与 abort 监听器（E2/E8）。 */
	private cleanupPending(pending: PendingFetch): void {
		if (pending.timer) clearTimeout(pending.timer);
		if (pending.signal && pending.abortHandler) {
			pending.signal.removeEventListener("abort", pending.abortHandler);
		}
	}

	private handleMessage(message: DshFetchMessage): void {
		const pending = this.pending.get(message.id);
		if (!pending) return;
		switch (message.type) {
			case "fetch-response": {
				// unary：一次性 body，直接组装 Response 并结算。
				this.pending.delete(message.id);
				this.cleanupPending(pending);
				const headers = new Headers(message.headers);
				pending.resolve(new Response(message.body ?? "", {
					status: message.status,
					headers,
				}));
				break;
			}
			case "fetch-stream-start": {
				// 流式：先 resolve（Response 立即返回，readSse 开始读 body），
				// pending 保留到 fetch-end 以持续接收 chunk。
				if (pending.stream) return;
				const headers = new Headers(message.headers);
				let streamState: PendingFetch["stream"];
				const stream = new ReadableStream<Uint8Array>({
					start: (controller) => {
						streamState = { controller, closed: false, cancelled: false };
						pending.stream = streamState;
					},
					cancel: () => {
						// 消费者提前取消（readSse finally 的 reader.cancel）：
						// 通知 host 停止推送，避免 pending 泄漏。
						if (streamState) {
							streamState.cancelled = true;
							streamState.closed = true;
						}
						this.transport.send({ type: "fetch-abort", id: message.id });
					},
				});
				pending.resolve(new Response(stream, { status: message.status, headers }));
				break;
			}
			case "fetch-chunk": {
				const stream = pending.stream;
				if (!stream || stream.closed) return;
				try {
					stream.controller.enqueue(new TextEncoder().encode(message.data));
				} catch (error) {
					this.log("dsh-bridge", `chunk enqueue failed: ${String(error)}`);
				}
				break;
			}
			case "fetch-end": {
				const stream = pending.stream;
				this.pending.delete(message.id);
				this.cleanupPending(pending);
				if (stream && !stream.closed) {
					stream.closed = true;
					try {
						stream.controller.close();
					} catch {
						// 已关闭（cancel 竞态）忽略
					}
				}
				break;
			}
			case "fetch-error": {
				const stream = pending.stream;
				this.pending.delete(message.id);
				this.cleanupPending(pending);
				if (stream && !stream.closed) {
					stream.closed = true;
					try {
						stream.controller.error(new Error(message.message));
					} catch {
						// 已关闭忽略
					}
				}
				pending.reject(new Error(message.message));
				break;
			}
			default:
				break;
		}
	}

	/**
	 * host 进程退出时调用：中断全部在途 fetch（含 mux 长连接）。
	 * host 崩溃后桥消息永久中断，悬挂的 pending 若不主动 error，
	 * pump 的 for await 会永远等不到结束——这是「会话静默断开」的根因。
	 */
	abortAllPending(): void {
		for (const pending of this.pending.values()) {
			this.cleanupPending(pending);
			const stream = pending.stream;
			if (stream && !stream.closed) {
				stream.closed = true;
				try {
					stream.controller.error(new Error("DSH host process exited"));
				} catch {
					// 已关闭忽略
				}
			}
			pending.reject(new Error("DSH host process exited"));
		}
		this.pending.clear();
	}

	/** 释放：清空 pending（拒绝在途请求），退订桥消息，置 disposed 阻止后续 send。 */
	dispose(): void {
		this.disposed = true;
		this.unsubscribe();
		for (const pending of this.pending.values()) {
			this.cleanupPending(pending);
			pending.reject(new Error("DSH host transport disposed"));
		}
		this.pending.clear();
		this.client = null;
	}
}
