/**
 * 用真实 pi 进程做一次性模型调用，验证某个 provider/model 是否真的能跑通。
 *
 * 为什么不用 net.fetch 模拟：模拟请求与真实会话的差异（SDK User-Agent、请求体、
 * reasoning 参数、流式、代理）会导致「测试失败、会话正常」或反向的误报。
 * 直接 fork pi --mode json --print 走的是 pi 真实的 provider 解析 + SDK 调用路径，
 * 测试结果与会话结果一致。
 *
 * 最小化启动参数：
 * - --no-session：不落盘会话文件；
 * - --no-extensions/--no-skills/--no-tools/--no-context-files/--no-prompt-templates/--no-themes：
 *   跳过扩展/技能/工具/上下文文件/模板/主题的发现与加载，纯对话且冷启动更快；
 * - --offline：跳过启动期网络操作（目录刷新等），模型调用本身不受影响。
 */

import { execFile } from "node:child_process";
import type { PiLocator } from "./PiLocator";
import type { SettingsStore } from "../settings/SettingsStore";
import type { PiModelProbeResult } from "../../shared/types/fetchedModel";

/**
 * 探测超时：放宽到 120s。
 *
 * 放宽容度的原因（issue #173）：reasoning 模型（如 deepseek-v4-flash）在输出前有
 * thinking 阶段，首包延迟显著高于普通模型；叠加 pi 冷启动与网络抖动后，原 45s 会
 * 在模型实际可用时误报 `pi model probe timed out`（用户会话内调用同一模型正常）。
 *
 * 不复用 settings.rpcTimeout（会话 RPC 超时）的原因：rpcTimeout 语义是「等一整轮
 * agent 交互」（含工具调用、多轮命令，见 AgentManager prompt 分支注释），且
 * SettingsStore.ensureRpcTimeoutMinimum 强制下限 600s。测试连接让用户干等 10 分钟
 * 才看到失败不可接受，故探针保留独立常量，取值兼顾 reasoning 模型上界与等待体感。
 */
export const PROBE_TIMEOUT_MS = 120_000;

const PROBE_BASE_ARGS = [
	"--mode", "json",
	"--print",
	"--no-session",
	"--no-extensions",
	"--no-skills",
	"--no-tools",
	"--no-context-files",
	"--no-prompt-templates",
	"--no-themes",
	"--offline",
];

export type { PiModelProbeResult };

/** 从 assistant 消息 content 中提取纯文本（content 可能是 string 或分段数组）。 */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && (part as { type?: string }).type === "text"
				? String((part as { text?: unknown }).text ?? "")
				: "",
		)
		.join("");
}

/**
 * 解析 `pi --mode json --print` 的 stdout（每行一个 JSON 事件）。
 * 找到 `agent_end` 事件的最后一条 assistant 消息：
 * - stopReason === "error" → 失败，取 errorMessage；
 * - 否则 → 成功，取 model / usage / 文本片段。
 */
export function parsePiProbeOutput(stdout: string): Omit<PiModelProbeResult, "latencyMs"> {
	let agentEnd: unknown = null;
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let obj: unknown;
		try {
			obj = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (obj && typeof obj === "object" && (obj as { type?: string }).type === "agent_end") {
			agentEnd = obj;
		}
	}

	const messages = (agentEnd as { messages?: unknown[] } | null)?.messages;
	if (!Array.isArray(messages)) {
		return { success: false, error: "pi returned no result" };
	}

	// 取最后一条 assistant 消息作为最终结果（agent_end.messages 里可能含 user 消息）。
	let lastAssistant: Record<string, unknown> | null = null;
	for (const message of messages) {
		if (message && typeof message === "object" && (message as { role?: string }).role === "assistant") {
			lastAssistant = message as Record<string, unknown>;
		}
	}
	if (!lastAssistant) {
		return { success: false, error: "pi returned no assistant message" };
	}

	const model = typeof lastAssistant.model === "string" ? lastAssistant.model : undefined;
	const snippet = extractText(lastAssistant.content);

	if (lastAssistant.stopReason === "error") {
		return {
			success: false,
			error:
				typeof lastAssistant.errorMessage === "string" && lastAssistant.errorMessage
					? lastAssistant.errorMessage
					: "model call failed",
			model,
			snippet,
		};
	}

	const usage = lastAssistant.usage as Record<string, unknown> | undefined;
	const tokens =
		usage && typeof usage.input === "number"
			? { input: usage.input, output: typeof usage.output === "number" ? usage.output : undefined }
			: undefined;

	return { success: true, model, snippet, tokens };
}

/**
 * fork pi 做一次性模型调用。成功后由 parsePiProbeOutput 解析结果；
 * pi 进程级失败（未安装/unknown option/超时/崩溃）时返回失败而非抛出。
 */
export async function probePiModel(
	piLocator: PiLocator,
	settingsStore: SettingsStore,
	providerName: string,
	modelId: string,
): Promise<PiModelProbeResult> {
	const startedAt = Date.now();
	const settings = settingsStore.get();
	// 拉测试可以等 WSL which；不能在 resolveCommand 里同步卡住主进程。
	if (settings.wslEnabled && settings.wslDistro && settings.wslUser) {
		await piLocator.warmWslCommand(settings.wslDistro, settings.wslUser);
	}
	const command = piLocator.resolveCommand(
		settings.customPiPath,
		settings.wslEnabled,
		settings.wslDistro,
		settings.wslUser,
	);
	const invocation = piLocator.createInvocation(command, [
		...PROBE_BASE_ARGS,
		"--provider", providerName,
		"--model", modelId,
		"Hi",
	]);

	try {
		const stdout = await new Promise<string>((resolve, reject) => {
			execFile(
				invocation.command,
				invocation.args,
				{
					env: piLocator.createProcessEnv(settings, invocation.pathPrefix, invocation.wsl),
					shell: invocation.shell,
					windowsHide: true,
					timeout: PROBE_TIMEOUT_MS,
					encoding: "utf8",
					windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				},
				(error, stdout, stderr) => {
					if (error) {
						const errObj = error as NodeJS.ErrnoException & { killed?: boolean };
						const timedOut = errObj.killed || errObj.code === "ETIMEDOUT";
						// 超时信息带上秒数：便于一眼区分「探针超时」与「模型报错」，
						// 也方便后续回收用户反馈时判断是否真到了 thinking 阶段的上界。
						const message = timedOut
							? `pi model probe timed out after ${Math.round(PROBE_TIMEOUT_MS / 1000)}s`
							: (stderr?.trim() || error.message).slice(0, 500);
						reject(new Error(message));
						return;
					}
					resolve(stdout);
				},
			);
		});
		return { ...parsePiProbeOutput(stdout), latencyMs: Date.now() - startedAt };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			error: message.slice(0, 500),
			latencyMs: Date.now() - startedAt,
		};
	}
}
