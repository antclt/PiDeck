/**
 * DSH host utilityProcess 入口（v2 形态）。
 *
 * 运行在 Electron utilityProcess 里：`boot()` 引导完整 DSH host（组合与主进程内嵌
 * 形态一致），随后通过 `process.parentPort` 响应主进程的 fetch 桥请求——
 * 每个 fetch-request 交给 `toFetchHandler(ctx.apiProxy).fetch()`，响应体
 * （unary JSON 或 SSE 流）按 dshHostBridge 协议逐帧回传。
 *
 * 启动参数（argv）：
 *   --dsh-home <dir>           DSH_HOME（会话/存储/凭证目录）
 *   --dsh-config <dir>         cordis.yml 与本地插件目录
 *   --dsh-node-modules <dir>   bareModuleBaseUrl 锚点（node_modules 目录 URL）
 *
 * 注意：本文件被 electron-vite 主进程构建打包（rollup 多入口），产物为 CJS；
 * @deepseek-ai/* 全部 externalize，运行时动态 import() 加载（与 DshHost 一致）。
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { installHiddenConsolePatch, installHostHiddenConsole } from "./hideChildConsoles";
import { agentPresetsRow } from "./dshPresetComposition";
import {
	PIDECK_PLUGIN_BRIDGE_PATH,
	handlePluginBridgeFetch,
} from "./pideckPluginBridge";

// utilityProcess 的 parentPort：electron 包类型里有（Electron.ParentPort）。
import type { ParentPort } from "electron";

type DshFetchMessage =
	| { type: "fetch-request"; id: string; method: string; path: string; headers?: Record<string, string>; body?: string }
	| { type: "fetch-abort"; id: string };

/** 解析 argv：支持 `--key value` 与 `--key=value` 两种形式。 */
function parseArgv(argv: string[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) continue;
		const body = arg.slice(2);
		const eq = body.indexOf("=");
		if (eq >= 0) {
			// --key=value
			result[body.slice(0, eq)] = body.slice(eq + 1);
			continue;
		}
		const key = body;
		const value = argv[index + 1];
		if (value !== undefined && !value.startsWith("--")) {
			result[key] = value;
			index += 1;
		} else {
			result[key] = "true";
		}
	}
	return result;
}

async function main(): Promise<void> {
	const port = process.parentPort as ParentPort | undefined;
	if (!port) {
		console.error("[dsh-host-entry] no parentPort; this entry must run inside Electron utilityProcess");
		process.exit(1);
	}
	const args = parseArgv(process.argv.slice(2));
	const dshHome = args["dsh-home"];
	const configDir = args["dsh-config"];
	const nodeModulesUrl = args["dsh-node-modules"];
	if (!dshHome || !configDir || !nodeModulesUrl) {
		console.error("[dsh-host-entry] missing required args", { dshHome, configDir, nodeModulesUrl });
		process.exit(1);
	}
	mkdirSync(dshHome, { recursive: true });
	mkdirSync(configDir, { recursive: true });
	process.env.DSH_HOME = dshHome;
	process.env.DSH_TELEMETRY_DISABLED = "1";

	// Windows 黑窗口治理（必须在下面任何 @deepseek-ai/* 动态 import 之前安装——
	// dsh-subprocess-local 等模块加载时会捕获 child_process.spawn 的引用，
	// 补丁先于加载才覆盖得到）：
	// 1) installHostHiddenConsole：给 host 分配隐藏控制台。utilityProcess 无控制台，
	//    child_process.spawn 拉起控制台子程序时 libuv 自动 CREATE_NO_WINDOW（本地
	//    路径本就不弹窗）；分配隐藏控制台后所有子进程/孙进程继承它，整棵树零弹窗。
	// 2) installHiddenConsolePatch：隐藏控制台分配失败时退回 windowsHide 注入兜底；
	//    并对沙箱 runner 的 spawn 注入 NODE_OPTIONS preload（runner 是 GUI 进程、
	//    不继承 host 控制台，需在 runner 进程内自建隐藏控制台——见 runnerConsolePreload.ts）。
	installHostHiddenConsole();
	installHiddenConsolePatch();

	// ── 组合：base 补丁 + 覆盖层（ApiProxy/workspace/storage + picker stub + 遥测关）──
	// require base 用宿主 node_modules 目录（DshHost 传 --dsh-node-modules 的 file URL）：
	// 打包后是 app.asar/node_modules（Electron asar patch 生效）；不能用 DSH_HOME（数据目录无包）。
	// 注意：CJS 产物里的裸 import("@deepseek-ai/...") 会走 Node 默认解析（out/main 向上找
	// node_modules），找不到 app 根 node_modules → ERR_MODULE_NOT_FOUND → exit(1)。
	// 必须先用 createRequire 解析出真实文件路径，再按 file URL 动态 import。
	const require = createRequire(join(fileURLToPath(nodeModulesUrl), "package.json"));
	const importFromApp = (specifier: string) =>
		import(pathToFileURL(require.resolve(specifier)).href);
	const [{ boot, loadOverlayPatches }, { toFetchHandler }, { provideCmdline }] = await Promise.all([
		importFromApp("@deepseek-ai/dsh-app-boot"),
		importFromApp("@deepseek-ai/dsh-host-apiproxy"),
		importFromApp("@deepseek-ai/dsh-cmdline"),
	]);

	const basePatchPath = require.resolve("@deepseek-ai/dsh-base/cordis.patch.yml");
	const patches = loadOverlayPatches("pideck-dsh", basePatchPath);
	patches.push({ id: "hmr", disabled: true });
	patches.push({ id: "session-telemetry-otel", disabled: true });
	patches.push({
		insert: [
			{ id: "storage", name: "@deepseek-ai/dsh-storage" },
			{
				id: "storage-json",
				name: "@deepseek-ai/dsh-storage-json",
				config: { root: { __jsExpr: "dshHomePath('storages')" } },
			},
			{ id: "storage-domain", name: "@deepseek-ai/dsh-storage-domain", config: { backend: "json" } },
			{ id: "workspace", name: "@deepseek-ai/dsh-workspace" },
			{ id: "api-gateway", name: "@deepseek-ai/dsh-host-apiproxy" },
			{ id: "pideck-directory-picker", name: "./pideck-directory-picker.js" },
			{ id: "pideck-slash-bridge", name: "./pideck-slash-bridge.js" },
			// 持久 pwsh 工具（应用侧插件，仿 dsh-tool-bash-persistent）：
			// 常驻 pwsh 会话复用，避免每次调用 ~350ms 冷启动（实测 30 倍提速）。
			// 自包含 node-pty，不依赖 ctx.terminals（dsh-terminal-bash 的进程组
			// 空闲检测在 win32 不可用）。name 用绝对路径指向构建产物。
			{
				id: "tool-pwsh-persistent",
				name: join(__dirname, "pideckPwshPersistent.js"),
			},
			// Agent preset 名单（standard/code/minimal/cordis 等组合预设）：与 dsh-web
			// 同一部署形态——随包 system 根 + $DSH_HOME/.agent-presets 用户根（插件
			// includeUserRoot 默认追加），默认 standard（标准模式）。不声明该行时
			// agentPreset.list 返回空名单，配置页「预设设置」无模式可选。
			agentPresetsRow(dirname(require.resolve("@deepseek-ai/dsh/package.json"))),
			// 动态 Cordis 插件管理（G13 深化）：运行器（define/run/stop/undefine，
			// 进程内临时扩展、按会话归属）+ 只读静态 Loader 清单 + PiDeck 管理桥。
			// 与 dsh-web-app 的 cordis.patch.yml 同一挂载形态（无 config 的普通行）。
			{ id: "plugin-inventory", name: "@deepseek-ai/dsh-host-plugin-inventory" },
			{ id: "cordis-host-runner", name: "@deepseek-ai/dsh-cordis-host-runner" },
			{ id: "pideck-plugin-bridge", name: join(__dirname, "pideckPluginBridge.js") },
		],
	});

	const configPath = join(configDir, "cordis.yml");
	if (!existsSync(configPath)) writeFileSync(configPath, "[]\n");
	const pickerPath = join(configDir, "pideck-directory-picker.js");
	if (!existsSync(pickerPath)) {
		writeFileSync(
			pickerPath,
			[
				"export default {",
				"  apply(ctx) {",
				"    ctx.provide('directoryPicker', {",
				"      capability() { return { kind: 'none' }; },",
				"    });",
				"  },",
				"};",
				"",
			].join("\n"),
		);
	}
	// Slash 命令桥：dsh-web 的命令执行（/permission /plan /compact 等）走浏览器
	// 客户端通道（commands.execute Remote），PiDeck 只有 api-proxy RPC 通道，拿不到
	// 该 Remote。本插件把「以 / 开头的单条用户消息」在 agent/pre-step（步骤组装前）
	// 拦截下来，经 ctx.commands.execute 执行：命中则 reject 该步骤（命令日志事件
	// command/run + command/done 由执行器落盘，消息不进模型、不上时间线），
	// 未命中（未知命令/非命令）原样放行。与 dsh-web 的客户端语义一致。
	const slashBridgePath = join(configDir, "pideck-slash-bridge.js");
	if (!existsSync(slashBridgePath)) {
		writeFileSync(
			slashBridgePath,
			[
				"export default {",
				"  apply(ctx) {",
				"    ctx.inject(['commands'], (commandCtx) => {",
				"      commandCtx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {",
				"        try {",
				"          // 只认 source.kind === 'user' 的输入：回合注入的运行时上下文等",
				"          // 系统消息也作为 user/message 进 claimed 批次，必须排除。",
				"          const userMessages = Array.isArray(messages)",
				"            ? messages.filter((m) => m && m.source && m.source.kind === 'user')",
				"            : [];",
				"          if (userMessages.length !== 1) return next();",
				"          const content = userMessages[0] && userMessages[0].content;",
				"          const block = Array.isArray(content) && content.length === 1 ? content[0] : undefined;",
				"          const line = block && block.type === 'text' && typeof block.text === 'string'",
				"            ? block.text.trim()",
				"            : '';",
				"          if (!line.startsWith('/')) return next();",
				"          // 未知命令 execute 返回 undefined：放行给模型当普通文本；",
				"          // 已知命令执行成功后 reject 步骤（消息已 claim，不会重入）。",
				"          const result = await commandCtx.commands.execute(agent, line, signal);",
				"          if (result === undefined) return next();",
				"          return { kind: 'reject' };",
				"        } catch (error) {",
				"          // 执行异常（含用户中止）不吞消息：放行回正常步骤流。",
				"          return next();",
				"        }",
				"      });",
				"    });",
				"  }",
				"};",
				"",
			].join("\n"),
		);
	}

	const startedAt = Date.now();
	const ctx = await boot(
		"pideck-dsh",
		configPath,
		patches,
		(hostCtx: import("@deepseek-ai/cordis").Context) => {
			provideCmdline(hostCtx, {
				args: [],
				exit: (code: number) => {
					console.log(`[dsh-host-entry] host requested exit code=${code}`);
					port.postMessage({ type: "host-exit", code });
				},
			});
		},
		nodeModulesUrl,
	);
	const apiHandler = toFetchHandler(ctx.apiProxy as never);
	// PiDeck 插件管理桥（G13 深化）：/pideck-plugin/rpc 走桥插件服务（动态插件
	// 生命周期 + 静态 Loader 清单），其余路径原样交给 ApiProxy RPC handler。
	const handler = (url: URL, init?: RequestInit): Promise<Response> => {
		if (url.pathname === PIDECK_PLUGIN_BRIDGE_PATH) {
			return handlePluginBridgeFetch(ctx, {
				method: init?.method,
				// 桥协议 headers 是 Record<string,string>（见 DshFetchMessage）；RequestInit
				// 的 HeadersInit 形状更宽，此处收窄到桥协议形状。body 同理只透传字符串。
				headers: init?.headers as Record<string, string> | undefined,
				body: typeof init?.body === "string" ? init.body : undefined,
			});
		}
		return apiHandler.fetch(url, init);
	};
	console.log(`[dsh-host-entry] boot OK in ${Date.now() - startedAt}ms`);
	port.postMessage({ type: "host-ready" });

	// ── fetch 桥循环：每请求一个 Response，SSE 流逐帧回传 ──
	port.on("message", (message: unknown) => {
		void (async () => {
			// utilityProcess 的 parentPort 消息是 MessageEvent 风格：载荷在 data 字段
			// （{ data: {...}, ports: [...] }）。兼容直接对象两种形状。
			const raw = (message as { data?: unknown } | null)?.data ?? message;
			const msg = raw as Partial<DshFetchMessage>;
			if (msg?.type !== "fetch-request") return;
			const id = msg.id ?? "";
			if (!id) return;
			const url = new URL(msg.path ?? "/", "http://dsh.internal");
			const init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {
				method: msg.method ?? "GET",
				...(msg.headers ? { headers: msg.headers } : {}),
				...(msg.body !== undefined ? { body: msg.body } : {}),
			};
			const controller = new AbortController();
			init.signal = controller.signal;
			// 主进程 abort 转发：取消 host 侧进行中的请求（SSE 流 / 超时）。
			// 注册必须在任何 await 之前（E9）：fetch-abort 是独立消息，若注册晚于
			// handler.fetch 的同步段，先到的 abort 会丢失 → unary 请求无取消路径。
			const onAbortMessage = (abortMessage: unknown) => {
				const abortRaw = (abortMessage as { data?: unknown } | null)?.data ?? abortMessage;
				const parsed = abortRaw as Partial<DshFetchMessage>;
				if (parsed?.type === "fetch-abort" && parsed.id === id) controller.abort();
			};
			port.on("message", onAbortMessage);
			try {
				const response = await handler(url, init);
				const status = response.status;
				const headers: Record<string, string> = {};
				response.headers.forEach((value: string, key: string) => {
					headers[key] = value;
				});
				const isStream = response.body !== null && !(response.headers.get("content-type") ?? "").includes("application/json");
				if (!isStream) {
					const body = await response.text();
					port.postMessage({ type: "fetch-response", id, status, headers, body });
					return;
				}
				port.postMessage({ type: "fetch-stream-start", id, status, headers });
				const reader = response.body!.getReader();
				const decoder = new TextDecoder();
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						port.postMessage({ type: "fetch-chunk", id, data: decoder.decode(value, { stream: true }) });
					}
				} catch (error) {
					port.postMessage({ type: "fetch-error", id, message: String(error) });
					return;
				} finally {
					await reader.cancel().catch(() => undefined);
				}
				port.postMessage({ type: "fetch-end", id });
			} catch (error) {
				port.postMessage({ type: "fetch-error", id, message: String(error) });
			} finally {
				port.off("message", onAbortMessage);
			}
		})();
	});
}

main().catch((error) => {
	console.error("[dsh-host-entry] fatal:", error);
	// 错误经 parentPort 回传主进程（utilityProcess 的 stderr 不可靠），
	// DshHostProcess 收到 host-error 后记入主进程日志。
	try {
		process.parentPort?.postMessage({
			type: "host-error",
			message: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
		});
	} catch {
		// parentPort 不可用（ELECTRON_RUN_AS_NODE 等）时只能靠 stderr
	}
	process.exit(1);
});
