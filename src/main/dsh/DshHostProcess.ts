import { join } from "node:path";
import { existsSync } from "node:fs";
import type { UtilityProcess } from "electron";
import { getAppLogger } from "../logging/sharedLogger";

/**
 * DSH host utilityProcess 生命周期管理（v2 形态，对应计划 §3.2 形态 b）。
 *
 * 职责：fork hostEntry、转发桥消息（fetch-request / fetch-abort）、
 * 健康信号（host-ready）、退出清理（kill + 等待 exit）。
 *
 * 桥协议见 dshHostBridge.ts；hostEntry 侧组合与主进程内嵌形态一致。
 */
export class DshHostProcess {
	private child: UtilityProcess | null = null;
	private readonly listeners = new Set<(message: unknown) => void>();
	private readyResolvers: Array<() => void> = [];
	private readyRejecters: Array<(error: Error) => void> = [];
	private ready = false;
	private exitPromise: Promise<void> | null = null;
	/** 启动失败/崩溃后的重启计数（限次，避免死循环）。 */
	private restartCount = 0;
	private readonly maxRestarts = 3;
	/** 主动停止中（kill/dispose）：exit 时不触发自动重启。 */
	private stopping = false;
	/** postMessage 在 host 已退出时只警告一次（abort 竞态可能连续触发）。 */
	private warnedDisposed = false;
	/** host 进程退出订阅（DshHost 借此中断悬挂的桥 pending）。 */
	private readonly exitListeners = new Set<() => void>();
	private readonly log: (scope: string, message: string, detail?: unknown) => void;

	constructor(
		/** hostEntry 产物路径（out/main/hostEntry.js）。 */
		private readonly entryPath: string,
		/** fork 参数（dsh-home / dsh-config / dsh-node-modules）。 */
		private readonly forkArgs: string[],
		/** fork 环境变量（DSH_HOME 等已在 entry 内设置；这里可补应用级 env）。 */
		private readonly forkEnv: Record<string, string>,
		log?: (scope: string, message: string, detail?: unknown) => void,
	) {
		this.log = log ?? ((scope, message, detail) => getAppLogger()?.info(scope, message, detail));
	}

	/** 是否已 fork（无论是否 ready）。 */
	isRunning(): boolean {
		return this.child !== null;
	}

	/** 是否已完成 boot（host-ready 已收到）。 */
	isReady(): boolean {
		return this.ready;
	}

	/** fork hostEntry 并等待 host-ready（幂等；已 fork 未 ready 时复用等待）。 */
	async start(): Promise<void> {
		if (this.child) {
			if (this.ready) return;
			await this.waitForReady();
			return;
		}
		this.ready = false;
		const { utilityProcess } = await import("electron");
		this.log("dsh-host", `forking host entry: ${this.entryPath}`);
		const child = utilityProcess.fork(this.entryPath, this.forkArgs, {
			env: this.forkEnv,
			// 显式 pipe stdio：否则 Windows 上 stderr 可能不可读，boot 失败只能看到 exit code。
			stdio: "pipe",
			serviceName: "pideck-dsh-host",
		});
		this.child = child;
		child.on("message", (message) => {
			this.handleMessage(message);
		});
		// hostEntry 的 console.error / 未捕获异常都会走 stderr；转发到主进程日志，
		// 否则 host 启动失败（exit before ready）只能看到 code，看不到原因。
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8").trimEnd();
			if (text) this.log("dsh-host-entry", text);
		});
		child.on("exit", (code) => {
			this.log("dsh-host", `host process exited code=${code}`);
			this.child = null;
			this.ready = false;
			// 先通知订阅者（DshHost 借此 abortAllPending 中断悬挂 mux），再处理重启。
			for (const listener of this.exitListeners) {
				try {
					listener();
				} catch {
					// 订阅者异常不影响进程生命周期处理
				}
			}
			// 未 ready 的等待者：boot 失败（exit 早于 host-ready）。
			const rejecters = this.readyRejecters;
			this.readyRejecters = [];
			for (const reject of rejecters) {
				reject(new Error(`DSH host process exited before ready (code=${code})`));
			}
			this.exitPromise = null;
			// boot 失败自动重启（限次）：hostEntry 产物瞬时损坏/依赖加载失败等偶发问题
			// 不应让配置页/首个会话直接失败——重试成功前保持等待，超限才抛给调用方。
			if (!this.stopping && this.restartCount < this.maxRestarts) {
				this.log("dsh-host", `host exited before ready (code=${code}); auto-restarting`);
				void this.restartAfterCrash();
			}
		});
		await this.waitForReady();
	}

	private waitForReady(): Promise<void> {
		if (this.ready) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			this.readyResolvers.push(resolve);
			this.readyRejecters.push(reject);
		});
	}

	private handleMessage(message: unknown): void {
		const parsed = message as { type?: string } | undefined;
		if (parsed?.type === "host-ready") {
			if (!this.ready) {
				this.ready = true;
				this.restartCount = 0;
				const resolvers = this.readyResolvers;
				this.readyResolvers = [];
				for (const resolve of resolvers) resolve();
			}
			return;
		}
		if (parsed?.type === "host-error") {
			// hostEntry boot 失败：错误已通过 MessagePort 回传（stderr 不可靠），记入主进程日志
			const detail = (message as { message?: unknown }).message;
			this.log("dsh-host-entry", `fatal: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
			return;
		}
		// 其余消息（fetch-response/chunk/end/error）透传给桥监听者。
		for (const listener of this.listeners) listener(message);
	}

	/** 订阅 host → main 的全部桥消息（含 host-ready 之外的业务帧）。 */
	onMessage(listener: (message: unknown) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** 向 host 发消息（fetch-request / fetch-abort）。未运行时不抛异常：
	 * 调用方多为 abort 回调/流取消等异步路径，抛错会变成未捕获异常（日志里
	 * 的 "DSH host process is not running" 崩溃即由此而来）；静默丢弃即可。 */
	postMessage(message: unknown): void {
		if (!this.child) {
			if (!this.warnedDisposed) {
				this.warnedDisposed = true;
				this.log("dsh-host", "postMessage ignored: host process is not running");
			}
			return;
		}
		this.child.postMessage(message);
	}

	/** 订阅 host 进程退出（运行中崩溃/主动 kill 都会触发；重启后需重新订阅）。 */
	onExit(listener: () => void): () => void {
		this.exitListeners.add(listener);
		return () => {
			this.exitListeners.delete(listener);
		};
	}

	/** 崩溃重启（限次）：kill 后重新 fork。返回是否已重启。 */
	async restartAfterCrash(): Promise<boolean> {
		if (this.restartCount >= this.maxRestarts) {
			this.log("dsh-host", "crash restart limit reached; giving up");
			return false;
		}
		this.restartCount += 1;
		await this.kill();
		// kill() 会置 stopping=true（防 exit 触发自动重启）；这里是「重启」而非「退出”，
		// 必须在重新 fork 前复位，否则新进程 boot 失败时自动重启只生效一次。
		this.stopping = false;
		try {
			await this.start();
			this.log("dsh-host", `host restarted after crash (attempt ${this.restartCount})`);
			return true;
		} catch (error) {
			this.log("dsh-host", `host restart failed: ${String(error)}`);
			return false;
		}
	}

	/** 停止 host：kill 进程并等待退出（退出清理清单调用）。 */
	async kill(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.stopping = true;
		// 未 ready 的等待者也要失败（kill 中断 boot）。
		const rejecters = this.readyRejecters;
		this.readyRejecters = [];
		for (const reject of rejecters) reject(new Error("DSH host process was killed"));
		this.exitPromise ??= new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			child.kill();
			// 兜底：kill 后 5s 未退出强制终止（Windows 上偶发）。
			setTimeout(() => {
				if (this.child === child) {
					this.log("dsh-host", "host did not exit within 5s after kill; forcing terminate");
					child.kill();
				}
				resolve();
			}, 5000).unref();
		});
		await this.exitPromise;
	}

	/** 释放（退出清理）：kill + 清监听。 */
	async dispose(): Promise<void> {
		this.listeners.clear();
		await this.kill();
	}
}

/**
 * hostEntry 产物路径。
 * - 未打包（dev / electron-vite dev 以 `electron .` 启动）：appPath = 项目根，
 *   out/main/hostEntry.js。
 * - 打包：app.asar/out/main/hostEntry.js；electron-builder 已把 hostEntry.js 加入
 *   asarUnpack，Electron 的 asar fs patch 会把 app.asar 内路径自动映射到
 *   app.asar.unpacked（utilityProcess 加载真实文件，避免 asar 虚拟目录问题）。
 * - 直接以主进程产物启动（e2e `electron out/main/index.js` / electron-vite preview）：
 *   appPath 已是 out/main，标准拼接会翻倍成 out/main/out/main/hostEntry.js；
 *   探测到标准路径不存在时退到 appPath 同目录（产物与入口同目录）。
 */
export function resolveHostEntryPath(appPath: string): string {
	const standard = join(appPath, "out", "main", "hostEntry.js");
	if (existsSync(standard)) return standard;
	return join(appPath, "hostEntry.js");
}
