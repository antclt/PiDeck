import type {
	SessionCommandError,
	SessionCommandResult,
	SessionRuntimeTarget,
} from "../../../shared/types";
import { t, type TranslationKey } from "../i18n";

/**
 * 取消息携带的文件条目 id（meta.entryId）。meta 是 Record<string, unknown>，
 * 这里收窄成 string；编辑/删除/重发用它对 JSONL 做锚点定位（live randomUUID 无效）。
 */
export function messageEntryId(message: { meta?: Record<string, unknown> | undefined } | undefined): string | undefined {
	return typeof message?.meta?.entryId === "string" ? message.meta.entryId : undefined;
}

const SESSION_COMMAND_ERROR_KEYS: Record<SessionCommandError["code"], TranslationKey> = {
	SESSION_NOT_FOUND: "sessionCommand.sessionNotFound",
	MESSAGE_NOT_FOUND: "sessionCommand.messageNotFound",
	SESSION_RUNTIME_UNAVAILABLE: "sessionCommand.runtimeUnavailable",
	SESSION_RUNTIME_CHANGED: "sessionCommand.runtimeChanged",
	SESSION_RUNTIME_BUSY: "sessionCommand.runtimeBusy",
	SESSION_COMMAND_FAILED: "sessionCommand.commandFailed",
	SESSION_MODEL_NOT_FOUND: "sessionCommand.modelNotFound",
};

export class SessionCommandFailure extends Error {
	readonly code: SessionCommandError["code"];
	readonly params?: SessionCommandError["params"];
	readonly debugDetails?: string;
	/** 模型在本地 models.json 存在但运行中 Agent 未加载：需重启 Agent 生效。 */
	readonly needsRestart?: boolean;

	constructor(error: SessionCommandError) {
		super(t(SESSION_COMMAND_ERROR_KEYS[error.code], error.params));
		this.name = "SessionCommandFailure";
		this.code = error.code;
		this.params = error.params;
		this.debugDetails = error.debugDetails;
		this.needsRestart = error.needsRestart;
	}
}

export function requireSessionCommand<T>(result: SessionCommandResult<T>): T {
	if (result.ok) return result.value;
	throw new SessionCommandFailure(result.error);
}

const DEBUG_DETAILS_TOAST_MAX = 140;

/**
 * 会话命令失败 toast：稳定 i18n 文案不够定位时（如「会话操作失败，请重试」），
 * 附带 debugDetails 原文，避免用户只能看到泛化失败、开发者也看不到日志。
 */
export function sessionCommandFailureToast(
	error: unknown,
	translateRaw?: (message: string) => string,
): string {
	const raw = error instanceof Error ? error.message : String(error);
	const message = translateRaw ? translateRaw(raw) : raw;
	const details = error instanceof SessionCommandFailure
		? error.debugDetails?.trim()
		: undefined;
	if (!details || details === raw || details === message) return message;
	const clipped = details.length > DEBUG_DETAILS_TOAST_MAX
		? `${details.slice(0, DEBUG_DETAILS_TOAST_MAX)}…`
		: details;
	return `${message}（${clipped}）`;
}

/**
 * 判定运行时状态是否仍可接受命令（live）。
 * starting/idle/running 才是「进程仍在、可接收命令」的 live 状态；error/closed 是终态
 * （进程已失败/已关闭），detached 是已解绑，undefined 表示没有运行时——均不可作为
 * 重启/停止/重发等运行时命令的目标，也不应显示「重启」入口。
 */
export function isLiveRuntimeStatus(status?: string | null): boolean {
	return status === "starting" || status === "idle" || status === "running";
}

export function toSessionRuntimeTarget(
	sessionId: string,
	runtime: { agentId?: string; runtimeGeneration?: number; status?: string | null } | undefined,
): SessionRuntimeTarget | undefined {
	// target 只表达「会话 → 当前绑定运行实例」的句柄，不做 live 判定：
	// stop/restart 对 error/closed 终态 Agent 仍有效（主进程幂等 stop + 重启重建），
	// 而「重发是否需要先停」这类 live 判定由各调用点用 isLiveRuntimeStatus 单独判断。
	if (!runtime?.agentId || runtime.runtimeGeneration === undefined) return undefined;
	return {
		sessionId,
		agentId: runtime.agentId,
		runtimeGeneration: runtime.runtimeGeneration,
	};
}
