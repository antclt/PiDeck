import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";
import z from "@deepseek-ai/schemastery";
import {
	parsePwshCommandOutput,
	pwshPromptCompleted,
	SHELL_PROMPT,
	stripPwshControl,
	wrapPwshCommand,
} from "./protocol.js";
import { formatPwshStartupError, resolvePwshPath } from "./pwshResolver.js";

export {
	parsePwshCommandOutput,
	pwshPromptCompleted,
	quoteForPwsh,
	stripPwshControl,
	wrapPwshCommand,
} from "./protocol.js";
export {
	candidatePwshPaths,
	formatPwshStartupError,
	resolvePwshPath,
} from "./pwshResolver.js";

/** ESM 下解析 CJS 原生模块（node-pty 无 ESM 入口）。 */
const require = createRequire(import.meta.url);

/**
 * 持久 PowerShell 工具（标准 DSH Cordis 插件，仿 @deepseek-ai/dsh-tool-bash-persistent）。
 *
 * 动机：普通 pwsh 工具每次 `pwsh -NoLogo -NoProfile -NonInteractive -Command` 冷启动
 * 约 350-400ms（.NET 运行时加载）；常驻会话复用后单命令往返约 13ms（实测 30 倍差距）。
 *
 * 机制（与 bash-persistent 对齐）：
 * - 每个 agent（owner）一个常驻 pwsh（node-pty，`-NoExit` 交互会话），按需懒创建；
 * - 命令经 marker 协议包裹（start/end 标记 + 退出码），轮询 PTY 输出缓冲提取结果；
 * - 会话状态（cwd、变量、函数）跨调用保持——这是特性（文档与普通 pwsh 的区别）；
 * - 超时/取消/崩溃后重置会话，下次调用自动重建；同 owner 命令串行化；
 * - host 退出时 kill 全部会话（生命周期配对，见 ctx.effect dispose）。
 *
 * 沙箱语义：持久会话是交互式 PTY，无法做 ACL 沙箱（等效 danger-full-access）。
 * 需要沙箱隔离时模型应使用普通 pwsh 工具。
 *
 * Windows 适配（与 bash-persistent 的差异）：
 * - pwsh 的 prompt 输出带 ANSI 控制序列（光标移动/标题 OSC），检测前先剥离；
 * - 无 stty -echo 等价物：命令回显行包含 start marker，解析用 lastIndexOf 天然跳过；
 * - node-pty 直接 require，不依赖 ctx.terminals。官方 rc.8 虽已有 win32
 *   process inspector，但 `@deepseek-ai/dsh-tool-pwsh-persistent` 走
 *   ctx.terminals、工具名是 `pwsh`（会和一次性沙箱 pwsh 冲突），且预设默认
 *   不挂；本插件保留独立工具名 `pwsh_persistent` 并卸掉 PSReadLine。
 */

const TIMEOUT_CODE = "PERSISTENT_PWSH_TIMEOUT";
const POLL_INTERVAL_MS = 25;
const SCROLLBACK_MAX_CHARS = 512 * 1024;
// 模型可见的默认描述：刻意只讲持久会话的收益（复用进程、状态保留），
// 不再写「沙箱下请用普通 pwsh」这类取舍——那条引导会让模型几乎永不选本工具
// （见 2026-08 会话实测：15 次调用全是 one-shot pwsh）。沙箱语义仍由权限预设
// 在工具准入层把关，描述层不替模型做"该不该用"的决策。
const DEFAULT_DESCRIPTION =
	"Run PowerShell commands in a persistent pwsh shell: prefer this tool for PowerShell work. The shell is reused across calls, so there is no per-call cold start. State — the current directory and exported environment variables — persists between calls; use `Set-Location` to change directory or pass absolute paths. Non-zero exits are reported as `[exit code: N]`; after a crash or timeout the shell resets automatically.";

function markers(): { start: string; end: string } {
	const nonce = randomUUID();
	return { start: `__DSH_PWSH_START_${nonce}__`, end: `__DSH_PWSH_END_${nonce}:` };
}

// ── 持久会话（node-pty 自包含）───────────────────────────────────────────────

type PwshPty = {
	pid: number;
	write(data: string): void;
	kill(): void;
	onData(listener: (data: string) => void): void;
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
};

type Owner = { ctx: { effect(fn: () => () => void, label: string): void }; session: { header: { cwd?: string } } };

type PersistentSession = {
	pty: PwshPty;
	buffer: string;
	dead: boolean;
};

function createPtySession(pwshPath: string, cwd: string | undefined, env: Record<string, string>): PersistentSession {
	const pty = require("node-pty") as {
		spawn(file: string, args: string[], options: Record<string, unknown>): PwshPty;
	};
	const initCommand = [
		// PSReadLine 在 conpty 下对长命令（含转义引号）的输入解析有问题——命令回显后
		// 不执行（实测）；常驻会话改用原生行编辑（无语法高亮、回车直接提交）。
		// 回显仍存在，由 marker 的 lastIndexOf + 退出码判定天然跳过。
		"Remove-Module PSReadLine -ErrorAction SilentlyContinue",
		// UTF-8 输出（PTY 下 pwsh 7 默认已 UTF-8，双保险）
		"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
		// 自定义提示符：persistentShells 用它在命令间隙判断 shell 空闲
		`function prompt { '${SHELL_PROMPT} ' }`,
	].join("; ");
	const ptyHandle = pty.spawn(
		pwshPath,
		["-NoLogo", "-NoProfile", "-NoExit", "-Command", initCommand],
		{
			// 列宽取大：减少 conpty 对超长命令的折行（折行已由续行语义 + 独立 end 语句兜底）
			name: "xterm-256color",
			cols: 1000,
			rows: 30,
			...(cwd !== undefined ? { cwd } : {}),
			env: { ...process.env, ...env },
		},
	);
	const session: PersistentSession = { pty: ptyHandle, buffer: "", dead: false };
	ptyHandle.onData((data) => {
		if (session.buffer.length + data.length > SCROLLBACK_MAX_CHARS) {
			session.buffer = session.buffer.slice(-SCROLLBACK_MAX_CHARS / 2) + data;
		} else {
			session.buffer += data;
		}
	});
	ptyHandle.onExit(() => {
		session.dead = true;
	});
	return session;
}

function waitForPrompt(session: PersistentSession, signal: AbortSignal, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const timer = setInterval(() => {
			if (signal.aborted) {
				clearInterval(timer);
				// signal.reason 不保证是 Error（如 AbortSignal.any 的聚合对象）；
				// 统一包装，避免工具层把启动异常渲染成 "[object Object]"。
				const reason = signal.reason;
				reject(reason instanceof Error ? reason : new Error(String(reason ?? "aborted")));
				return;
			}
			if (session.dead) {
				clearInterval(timer);
				reject(new Error("persistent pwsh exited during startup"));
				return;
			}
			if (Date.now() - startedAt > timeoutMs) {
				clearInterval(timer);
				reject(new Error("persistent pwsh did not reach readiness before startup timeout"));
				return;
			}
			if (pwshPromptCompleted(stripPwshControl(session.buffer))) {
				clearInterval(timer);
				resolve();
			}
		}, POLL_INTERVAL_MS);
	});
}

/**
 * 持久会话管理器：owner → 会话；懒创建、超时/崩溃/取消后重置、dispose 全清理。
 * 会话创建失败（首启超时）会立刻清理，下次调用重试。
 * 生命周期配对：会话清理注册在插件 ctx（插件卸载即 kill 全部）；owner 缓存清理
 * 注册在 owner.ctx（agent 会话结束即释放该 owner 的引用）。
 */
function persistentSessions(
	ctx: { effect(fn: () => (() => void | Promise<void>) | void, label: string): void },
	config: { pwshPath: string; startupTimeoutMs: number },
) {
	const live = new Map<Owner, PersistentSession>();
	const pending = new Map<Owner, Promise<PersistentSession>>();
	const ownerCleanup = new WeakSet<Owner>();
	const lifecycle = new AbortController();

	const close = async (owner: Owner): Promise<void> => {
		const session = live.get(owner);
		live.delete(owner);
		if (session && !session.dead) session.pty.kill();
	};

	const get = (owner: Owner, signal: AbortSignal): Promise<PersistentSession> => {
		const existing = pending.get(owner);
		if (existing !== undefined) return existing;
		const combined = AbortSignal.any([signal, lifecycle.signal]);
		const tracked = (async () => {
			try {
				const cwd = owner.session.header.cwd;
				const session = createPtySession(config.pwshPath, cwd, {});
				live.set(owner, session);
				if (!ownerCleanup.has(owner)) {
					ownerCleanup.add(owner);
					owner.ctx.effect(() => () => {
						live.delete(owner);
						pending.delete(owner);
					}, "tool-pwsh-persistent owner cache cleanup");
				}
				await waitForPrompt(session, combined, config.startupTimeoutMs);
				return session;
			} catch (error) {
				await close(owner);
				pending.delete(owner);
				// Cancellation is expected control flow; only startup failures should
				// carry the executable path and installation guidance to the user.
				if (combined.aborted) {
					// 取消 reason 可能是非 Error 对象；包装成可读 Error 再抛。
					const reason = signal.reason;
					throw reason instanceof Error ? reason : new Error(String(reason ?? "aborted during shell creation"));
				}
				throw formatPwshStartupError(error, config.pwshPath);
			}
		})();
		pending.set(owner, tracked);
		return tracked;
	};

	const reset = async (owner: Owner): Promise<void> => {
		pending.delete(owner);
		await close(owner);
	};

	ctx.effect(() => async () => {
		lifecycle.abort(new Error("tool-pwsh-persistent disposed during shell creation"));
		for (const session of live.values()) {
			if (!session.dead) session.pty.kill();
		}
		live.clear();
		pending.clear();
	}, "tool-pwsh-persistent shell cleanup");

	return { get, reset };
}

// ── 命令执行（marker 协议 + 超时/取消）────────────────────────────────────────

async function executePwshCommand(
	sessions: ReturnType<typeof persistentSessions>,
	owner: Owner,
	command: string,
	config: { timeoutMs: number; maxOutputChars: number },
	signal: AbortSignal,
): Promise<string> {
	const commandDeadline = deadline(signal, config.timeoutMs, TIMEOUT_CODE);
	const session = await sessions.get(owner, commandDeadline.signal);
	const marker = markers();
	const wrapped = wrapPwshCommand(command, marker);
	session.buffer = ""; // 每命令清缓冲：只保留本命令的滚动（提示符残留可容忍，解析按 marker）
	session.pty.write(`${wrapped}\r`);

	const startedAt = Date.now();
	for (;;) {
		const timedOut = timeoutOf(commandDeadline.signal, TIMEOUT_CODE);
		if (timedOut !== undefined) {
			await sessions.reset(owner);
			return [
				`Your command timed out after ${Math.round(timedOut.timeoutMs / 1000)} seconds. Below is partial output:`,
				maybeTruncate(stripPwshControl(parsePartial(session.buffer, marker)), config.maxOutputChars),
				"The persistent pwsh shell was reset; the next pwsh call starts from the workspace with a fresh current directory and environment.",
			].join("\n");
		}
		if (commandDeadline.signal.aborted) {
			await sessions.reset(owner);
			commandDeadline.signal.throwIfAborted();
		}
		if (session.dead) {
			const snapshot = stripPwshControl(parsePartial(session.buffer, marker));
			await sessions.reset(owner);
			const resetNote = "The persistent pwsh shell exited; it was reset and the next call starts fresh.";
			return snapshot.trim().length > 0 ? `${snapshot}\n${resetNote}` : resetNote;
		}
		const complete = parsePwshCommandOutput(session.buffer, marker);
		if (complete !== undefined) {
			const rendered = maybeTruncate(complete.text, config.maxOutputChars);
			return complete.exitCode !== 0 ? `${rendered}\n[exit code: ${complete.exitCode}]` : rendered;
		}
		// 兜底：超时上限内的命令没有 end marker 也没退出——按超时处理（防御死循环）
		if (Date.now() - startedAt > config.timeoutMs + 30_000) {
			await sessions.reset(owner);
			return "persistent pwsh did not produce a command result; the shell was reset.";
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
}

function parsePartial(text: string, marker: { start: string; end: string }): string {
	const startMarker = text.lastIndexOf(marker.start);
	return startMarker < 0 ? text : text.slice(startMarker + marker.start.length);
}

function maybeTruncate(content: string, maxOutputChars: number): string {
	if (content.length <= maxOutputChars) return content;
	return `${content.slice(0, maxOutputChars)}\n<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with \`grep -n\` in order to find the line numbers of what you are looking for.</NOTE>`;
}

// ── 工具注册 ────────────────────────────────────────────────────────────────

function registerPersistentPwsh(ctx: { tools: { register(def: unknown): void }; effect(fn: () => (() => void | Promise<void>) | void, label: string): void }, config: { description: string; pwshPath: string; startupTimeoutMs: number; timeoutMs: number; maxOutputChars: number }) {
	const sessions = persistentSessions(ctx, { pwshPath: config.pwshPath, startupTimeoutMs: config.startupTimeoutMs });
	const queues = new WeakMap<Owner, Promise<void>>();
	const serialized = async (owner: Owner, operation: () => Promise<string>): Promise<string> => {
		const run = (queues.get(owner) ?? Promise.resolve()).then(operation, operation);
		const tail = run.then(() => undefined, () => undefined);
		queues.set(owner, tail);
		try {
			return await run;
		} finally {
			if (queues.get(owner) === tail) queues.delete(owner);
		}
	};
	ctx.tools.register(defineTool({
		name: "pwsh_persistent",
		description: config.description,
		parameters: {
			command: {
				type: "string",
				required: true,
				description: "The PowerShell command to run. Use absolute paths or Set-Location explicitly — the current directory persists across calls.",
			},
		},
		output: {
			schema: { type: "string" },
			render: (_args: unknown, value: string) => [{ type: "text", text: value }],
		},
		async execute(args: { command: string }, exec: { signal: AbortSignal; agent?: Owner }) {
			if (args.command.trim().length === 0) throw new Error("command must be a non-empty string");
			const owner = exec.agent;
			if (owner === undefined) throw new Error("pwsh_persistent requires an owning agent session");
			return serialized(owner, async () => {
				exec.signal.throwIfAborted();
				return executePwshCommand(sessions, owner, args.command, {
					timeoutMs: config.timeoutMs,
					maxOutputChars: config.maxOutputChars,
				}, exec.signal);
			});
		},
		presentCall: (args: { command: string }) => ({
			card: "terminal",
			title: args.command,
		}),
	}));
}

const name = "tool-pwsh-persistent";
const inject = ["tools"];

/** 运行时配置：pwsh 路径 / 命令超时 / 输出上限 / 工具描述。 */
const Config = z.object({
	pwshPath: z.string().default(""),
	timeoutMs: z.number().default(300_000),
	maxOutputChars: z.number().default(16_000),
	startupTimeoutMs: z.number().default(15_000),
	description: z.string().default(DEFAULT_DESCRIPTION),
});

function apply(ctx: { tools: { register(def: unknown): void }; effect(fn: () => (() => void | Promise<void>) | void, label: string): void }, config: Record<string, unknown>) {
	const resolved = {
		pwshPath: resolvePwshPath({
			configuredPath: typeof config.pwshPath === "string" ? config.pwshPath : undefined,
			platform: process.platform,
		}),
		timeoutMs: typeof config.timeoutMs === "number" && config.timeoutMs > 0 ? config.timeoutMs : 300_000,
		maxOutputChars: typeof config.maxOutputChars === "number" && config.maxOutputChars > 0 ? config.maxOutputChars : 16_000,
		startupTimeoutMs: typeof config.startupTimeoutMs === "number" && config.startupTimeoutMs > 0 ? config.startupTimeoutMs : 15_000,
		description: typeof config.description === "string" && config.description.trim().length > 0
			? config.description
			: DEFAULT_DESCRIPTION,
	};
	registerPersistentPwsh(ctx, resolved);
}

export { Config, apply, inject, name };
