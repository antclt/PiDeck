import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { getAppLogger } from "../logging/sharedLogger";
import { DshHostProcess, resolveHostEntryPath } from "./DshHostProcess";
import { DshApiClient, type DshFetchTransport } from "./DshApiClient";
import { toDshAvailableModels } from "./dshModels";
import { parseAgentDefaultModel } from "./dshDefaultModel";
import { credentialValueFromDocument, isValidCredentialRef } from "./dshCredentials";
import type { DshFetchMessage } from "./dshHostBridge";

// 注意：主进程产物为 CJS，而 @deepseek-ai/* 是 ESM-only 包。
// 静态 import 会被 electron-vite 打包器改写（externalize 后变 require，Node <22.12 无法加载 ESM），
// 因此这里全部用运行时动态 import()（rollup 对 externalized 包的 import() 原样保留）。
// type-only import 会被擦除，可以保留。

/**
 * DSH 深融合宿主（v2 形态）：utilityProcess 承载完整 DSH host，
 * 主进程侧通过 `DshApiClient`（AbstractApiClient 实例，doFetch 走桥）访问
 * 同一 ApiProxy 契约——传输替换对 PiDeck 其余代码完全透明。
 *
 * 形态说明（docs/dsh-agent-backend-plan.md §3.2 形态 b）：
 * - host 在 utilityProcess 里 boot（无 web/无 HTTP/无端口），原生 ABI 与崩溃面
 *   不污染主进程；hostEntry 产物经 electron-vite 多入口打包到 out/main/。
 * - 懒启动：首个 DSH 会话创建时才 fork+boot（约 800ms），不拖慢应用启动。
 * - 桥协议：dshHostBridge.ts（fetch-request/response/chunk/end/error）。
 *
 * DSH_HOME：优先直接使用用户真实 ~/.dsh（与 dsh CLI 行为一致，配置/凭证/会话
 * 全在同一处）；仅当 ~/.dsh 不存在时（全新用户）才回退应用私有 dsh-home，
 * 不再复制任何文件——用户改 ~/.dsh 即刻生效，不产生两套配置漂移。
 */
export class DshHost {
	private hostProcess: DshHostProcess | null = null;
	private apiClient: DshApiClient | null = null;
	private client: import("@deepseek-ai/dsh-host-apiproxy").AbstractApiClient | null = null;
	private startPromise: Promise<void> | null = null;
	private dshHome = "";
	private configDir = "";
	private unsubscribeHostExit: (() => void) | null = null;

	constructor(
		private readonly getUserDataDir: () => string,
		private readonly getAppPath: () => string,
		private readonly log: (scope: string, message: string, detail?: unknown) => void =
			(scope, message, detail) => getAppLogger()?.info(scope, message, detail),
		/** DSH_HOME 覆盖目录 getter（设置里 dshHomeDir）；空串/undefined = 自动（~/.dsh 优先）。 */
		private readonly getDshHomeOverride: () => string | undefined = () => undefined,
	) {}

	/** 是否已完成引导。 */
	isStarted(): boolean {
		return this.client !== null;
	}

	/** host utilityProcess 是否存活（崩溃重启中返回 false）。 */
	isHostProcessRunning(): boolean {
		return this.hostProcess?.isRunning() ?? false;
	}

	/** host 是否已完成 boot（host-ready 已收到；重启后重新置位）。 */
	isHostReady(): boolean {
		return this.hostProcess?.isReady() ?? false;
	}

	/** 懒启动（幂等）：fork host 并建立桥接客户端。 */
	ensureStarted(): Promise<void> {
		if (this.client) return Promise.resolve();
		this.startPromise ??= this.start().catch((error) => {
			this.startPromise = null;
			throw error;
		});
		return this.startPromise;
	}

	/** 已启动时返回领域客户端（未启动返回 null）。 */
	getClient(): import("@deepseek-ai/dsh-host-apiproxy").AbstractApiClient | null {
		return this.client;
	}

	/**
	 * settings.describe 的透传视图：每个 namespace 的脱敏 value + schema +
	 * secrets 槽位 + revision。渲染层据此渲染配置表单。
	 */
	async describeSettings(): Promise<{
		writable: boolean;
		hasDocument: boolean;
		namespaces: Array<{
			ns: string;
			applies: string;
			revision: number;
			value: unknown;
			user?: unknown;
			secrets: Array<{ path: string[]; set: boolean }>;
			schema: unknown;
		}>;
	}> {
		await this.ensureStarted();
		const client = this.client;
		if (!client) {
			return { writable: false, hasDocument: false, namespaces: [] };
		}
		const described = await client.settings.describe({});
		if (!described.result.ok) {
			throw new Error(`dsh settings.describe failed: ${JSON.stringify(described.result.error)}`);
		}
		return {
			writable: described.result.value.writable,
			hasDocument: described.result.value.hasDocument,
			namespaces: (described.result.value.namespaces ?? []).map((ns) => ({
				ns: ns.ns,
				applies: ns.applies,
				revision: ns.revision,
				value: ns.value,
				user: ns.user,
				secrets: (ns.secrets ?? []).map((secret) => ({ path: secret.path, set: secret.set })),
				schema: ns.schema,
			})),
		};
	}

	/** settings.update：合并 patch 到 namespace 用户层（secret 可写；返回新脱敏视图）。 */
	async updateSettings(
		ns: string,
		patch: Record<string, unknown>,
		expectedRevision?: number,
	): Promise<unknown> {
		await this.ensureStarted();
		const client = this.client;
		if (!client) throw new Error("DSH host is not started");
		const updated = await client.settings.update({ ns, patch, expectedRevision });
		if (!updated.result.ok) {
			throw new Error(`dsh settings.update failed: ${JSON.stringify(updated.result.error)}`);
		}
		return updated.result.value;
	}

	/** credentials.describe：refs 必须匹配 env 名格式（^[A-Za-z_][A-Za-z0-9_]*$）。 */
	async describeCredentials(refs: string[]): Promise<Record<string, {
		configured: boolean;
		source?: string;
		writable: boolean;
	}>> {
		await this.ensureStarted();
		const client = this.client;
		if (!client) return {};
		const described = await client.credentials.describe({ refs });
		if (!described.result.ok) return {};
		return described.result.value.credentials ?? {};
	}

	/** credentials.set：写入凭证（唯一值单向通道）。 */
	async setCredential(ref: string, value: string): Promise<void> {
		await this.ensureStarted();
		const client = this.client;
		if (!client) throw new Error("DSH host is not started");
		const result = await client.credentials.set({ ref, value });
		if (!result.result.ok) {
			throw new Error(`dsh credentials.set failed: ${JSON.stringify(result.result.error)}`);
		}
	}

	/** credentials.unset：删除凭证（幂等）。 */
	async unsetCredential(ref: string): Promise<void> {
		await this.ensureStarted();
		const client = this.client;
		if (!client) throw new Error("DSH host is not started");
		const result = await client.credentials.unset({ ref });
		if (!result.result.ok) {
			throw new Error(`dsh credentials.unset failed: ${JSON.stringify(result.result.error)}`);
		}
	}

	/**
	 * 读取凭证明文（仅渲染层点「眼睛」时调用一次；DSH RPC 刻意不回显值）。
	 *
	 * 解析层与 dsh-credentials-local 一致：`$DSH_HOME/.credentials.yaml` 是严格
	 * ref→value 映射，环境变量层只读兜底（继承环境 > 凭证文件）。返回 undefined
	 * 表示该 ref 无值（未配置）。ref 必须匹配 env 名格式，杜绝路径注入。
	 */
	async readCredentialValue(ref: string): Promise<string | undefined> {
		if (!isValidCredentialRef(ref)) throw new Error(`invalid credential ref: ${ref}`);
		// 环境层（继承进程环境）优先：与 dsh-credentials-local 的优先级一致
		const inherited = process.env[ref];
		if (typeof inherited === "string" && inherited.length > 0) return inherited;
		// 凭证文件层：$DSH_HOME/.credentials.yaml（严格 ref→value 映射）
		const filePath = join(this.getHomeDir(), ".credentials.yaml");
		try {
			const text = await import("node:fs/promises").then((fs) => fs.readFile(filePath, "utf8"));
			return credentialValueFromDocument(text, ref);
		} catch {
			// 文件缺失/读取失败：视为未配置（describe 侧会如实报告状态）
		}
		return undefined;
	}

	/** settings.openDocument：让 host 把配置文档交给平台文本编辑器打开。 */
	async openDocument(): Promise<void> {
		await this.ensureStarted();
		const client = this.client;
		if (!client) throw new Error("DSH host is not started");
		const result = await client.settings.openDocument({}, new AbortController().signal);
		if (!result.result.ok) {
			throw new Error(`dsh settings.openDocument failed: ${JSON.stringify(result.result.error)}`);
		}
	}

	/** 当前生效的 DSH_HOME（未启动时按同一解析规则返回「即将使用」的目录）。 */
	getHomeDir(): string {
		const override = this.getDshHomeOverride()?.trim();
		return this.dshHome || resolveDshHomeDir(override, this.getUserDataDir());
	}

	/** DSH 配置管理页数据：host 启动状态 + DSH_HOME 目录（配置/会话/凭证同目录）。 */
	async getStatus(): Promise<{
		started: boolean;
		homeDir: string;
	}> {
		return { started: this.client !== null, homeDir: this.getHomeDir() };
	}

	/**
	 * Host 级模型目录（llm.models），不依赖已创建的 DSH 会话。
	 * 给草稿/未启动会话的模型下拉用；首次调用会懒 boot。
	 * 与会话级 session.models 同一目录数据，透传每模型支持的思考档位
	 * （reasoningEfforts），思考选择器按当前模型过滤档位。
	 */
	async listModels(): Promise<import("../../shared/types").AvailableModel[]> {
		await this.ensureStarted();
		const client = this.client;
		if (!client) return [];
		const listed = await client.llm.models({});
		if (!listed.result.ok) return [];
		return toDshAvailableModels(listed.result.value.groups ?? []);
	}

	/**
	 * 可配置提供方目录（llm.providers）：内置 catalog（declared，未配置）+
	 * 已注册路由（active）。模型页「添加提供方」从 declared 未激活行中选择，
	 * 与 dsh-web 的休眠目录选择同源。首次调用会懒 boot。
	 */
	async listProviders(): Promise<Array<{
		provider: string;
		displayName: string;
		active: boolean;
		declared?: boolean;
	}>> {
		await this.ensureStarted();
		const client = this.client;
		if (!client) return [];
		const listed = await client.llm.providers({});
		if (!listed.result.ok) return [];
		return (listed.result.value.providers ?? []).map((entry) => ({
			provider: entry.provider,
			displayName: entry.displayName,
			active: entry.active,
			...(entry.declared === true ? { declared: true } : {}),
		}));
	}

	/**
	 * DSH agent 预设目录（agentPreset.list）：会话 agent 的组合预设（standard/code/…）。
	 * 只读展示（id/trust/isDefault/名称/描述），配置页「预设设置」分区用。
	 */
	async listAgentPresets(): Promise<Array<{
		id: string;
		trust: "system" | "user";
		isDefault: boolean;
		name?: string;
		description?: string;
		broken?: string;
	}>> {
		await this.ensureStarted();
		const client = this.client;
		if (!client) return [];
		const listed = await client.agentPresets.list({});
		if (!listed.result.ok) return [];
		return (listed.result.value.presets ?? []).map((preset: {
			id: string;
			trust: "system" | "user";
			isDefault: boolean;
			name?: string;
			description?: string;
			broken?: string;
		}) => ({
			id: preset.id,
			trust: preset.trust,
			isDefault: preset.isDefault,
			...(typeof preset.name === "string" && preset.name ? { name: preset.name } : {}),
			...(typeof preset.description === "string" && preset.description ? { description: preset.description } : {}),
			...(typeof preset.broken === "string" && preset.broken ? { broken: preset.broken } : {}),
		}));
	}

	/**
	 * 部署默认模型选择（settings.yaml 的 agent-default-model 段）。
	 * 草稿/未激活会话的底栏与选择器展示默认模型/思考档位用；无需启动 host
	 * （直接读 DSH_HOME/settings.yaml，host 写出的简单 YAML）。文件缺失或解析
	 * 失败返回 undefined，调用方回退为不展示默认值。
	 */
	getDefaultModelSelection(): import("./dshDefaultModel").DshDefaultModel | undefined {
		const home = this.getHomeDir();
		const filePath = join(home, "settings.yaml");
		if (!existsSync(filePath)) return undefined;
		try {
			return parseAgentDefaultModel(readFileSync(filePath, "utf8"));
		} catch {
			return undefined;
		}
	}

	private async start(): Promise<void> {
		const userData = this.getUserDataDir();
		const override = this.getDshHomeOverride()?.trim();
		// DSH_HOME 解析：设置覆盖 > 用户真实 ~/.dsh > 应用私有 dsh-home（全新用户兑底）。
		this.dshHome = resolveDshHomeDir(override, userData);
		if (override) {
			this.log("dsh-host", `DSH_HOME 使用用户配置目录：${override}`);
		} else if (this.dshHome === join(homedir(), ".dsh")) {
			this.log("dsh-host", "DSH_HOME 使用用户 ~/.dsh（与 dsh CLI 共用配置/会话）");
		} else {
			this.log("dsh-host", `DSH_HOME 使用应用私有目录（未发现 ~/.dsh）：${this.dshHome}`);
		}
		this.configDir = join(userData, "dsh-config");
		mkdirSync(this.dshHome, { recursive: true });
		mkdirSync(this.configDir, { recursive: true });

		// 定位 hostEntry 产物与 node_modules 锚点（bareModuleBaseUrl）。
		const require = createRequire(join(this.getAppPath(), "package.json"));
		const appRoot = dirname(dirname(dirname(require.resolve("@deepseek-ai/dsh-base/package.json"))));
		const hostEntryPath = resolveHostEntryPath(this.getAppPath());

		const hostProcess = new DshHostProcess(
			hostEntryPath,
			[
				`--dsh-home=${this.dshHome}`,
				`--dsh-config=${this.configDir}`,
				`--dsh-node-modules=${pathToFileURL(appRoot + "/").href}`,
			],
			{},
			(scope, message, detail) => this.log(scope, message, detail),
		);
		this.hostProcess = hostProcess;
		// 崩溃联动：host 进程退出（运行中崩溃）时中断全部在途桥 fetch（mux 长连接），
		// 否则 pump 的 for await 悬挂在永远不会结束的流上——会话静默断开的根因。
		this.unsubscribeHostExit?.();
		this.unsubscribeHostExit = hostProcess.onExit(() => {
			this.apiClient?.abortAllPending();
		});
		// 先 fork 并等 host-ready：桥消息必须等 host 侧监听就绪后才能发。
		await hostProcess.start();

		const transport: DshFetchTransport = {
			send: (message: DshFetchMessage) => hostProcess.postMessage(message),
			onMessage: (listener) => hostProcess.onMessage((message) => listener(message as DshFetchMessage)),
			dispose: () => {
				void hostProcess.kill();
			},
		};
		this.apiClient = new DshApiClient({
			transport,
			// 与 hostEntry 一致：CJS 产物里裸 import() 会走默认解析（打包后找不到 app node_modules），
			// 必须按 file URL 动态导入（createRequire 解析真实路径）。
			loadModule: () => import(pathToFileURL(require.resolve("@deepseek-ai/dsh-host-apiproxy")).href),
			log: (message, detail) => this.log("dsh-bridge", message, detail),
		});
		// 覆写后的客户端即领域客户端（doFetch 走桥）。
		const client = await this.apiClient.getClient();
		this.client = client;
		this.log("dsh-host", "host ready（utilityProcess）");
	}

	/** 显式 dispose（应用退出清理清单调用）。 */
	async dispose(): Promise<void> {
		if (this.startPromise) {
			try {
				await this.startPromise;
			} catch {
				// boot 失败时无需 dispose
			}
		}
		if (this.apiClient) {
			this.apiClient.dispose();
			this.apiClient = null;
		}
		if (this.hostProcess) {
			this.unsubscribeHostExit?.();
			this.unsubscribeHostExit = null;
			await this.hostProcess.dispose();
			this.hostProcess = null;
		}
		this.client = null;
		this.startPromise = null;
	}

	/** 重启 host（DSH_HOME 切换后立即生效）：dispose 后清空状态，
	 * 下次 ensureStarted 按新目录重新 fork。调用方（main/index.ts 的
	 * restartDshHost IPC）会先停掉活跃 DSH 会话，避免旧 mux 悬挂。
	 */
	async restart(): Promise<void> {
		await this.dispose();
		this.log("dsh-host", "host 已重置，下次启动将重新 fork");
	}
}

/**
 * DSH_HOME 目录解析（纯函数，可单测）：
 * 1. 设置里 dshHomeDir 非空 → 以用户覆盖为准（任意自定义目录）；
 * 2. 否则用户真实 ~/.dsh 存在 → 直接用（与 dsh CLI 共用配置/凭证/会话）；
 * 3. 都没有 → 应用私有 dsh-home（全新用户兑底，避免往 home 目录写东西）。
 */
export function resolveDshHomeDir(
	override: string | undefined,
	userDataDir: string,
	realHomeExists: boolean = existsSync(join(homedir(), ".dsh")),
): string {
	if (override?.trim()) return override.trim();
	if (realHomeExists) return join(homedir(), ".dsh");
	return join(userDataDir, "dsh-home");
}
