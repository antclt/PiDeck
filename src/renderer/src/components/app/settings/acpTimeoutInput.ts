import type { AppSettings } from "../../../../../shared/types/settings";

/**
 * ACP 超时输入的纯逻辑（范围 + 文本 ↔ 毫秒换算），组件只管状态与写盘。
 *
 * 抽出来的原因：分钟/秒与毫秒的换算写错一个 60 只会让看门狗提前或延后十倍触发，
 * 而这类错误在真实会话里要等十分钟才暴露；纯函数可以在单测里直接钉住往返一致。
 * 缺省值与主进程硬编码保持一致：AcpAgentManager.PROMPT_TURN_TIMEOUT_MS（15min）、
 * acpTurnWatchdog.PROMPT_STALL_TIMEOUT_MS（180s）。
 * 取值依据：CodeBuddy 归档实测 intra-turn 静默峰值约 53s（>90s 的空隙全是回合结束后等用户输入），
 * 所以 180s / 15min 对正常回合有 3 倍以上余量，又不会让真卡死拖太久。
 */
export const ACP_TURN_TIMEOUT_DEFAULT_MS = 15 * 60_000;
export const ACP_TURN_TIMEOUT_MINUTES = { min: 1, max: 240 } as const;
export const ACP_STALL_TIMEOUT_DEFAULT_MS = 180_000;
export const ACP_STALL_TIMEOUT_SECONDS = { min: 10, max: 1800 } as const;

export type AcpTimeoutPatch = Pick<AppSettings, "acpPromptTurnTimeoutMs" | "acpPromptStallTimeoutMs">;

/** 输入文本 → 区间内整数；空串/小数/负数/越界一律 null（调用方回退到已保存值并报错）。 */
export function parseBoundedInteger(raw: string, range: { min: number; max: number }): number | null {
	const trimmed = raw.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	const value = Number(trimmed);
	if (!Number.isInteger(value) || value < range.min || value > range.max) return null;
	return value;
}

/** settings 里的毫秒 → 输入框文本（缺省键显示生效中的代码默认值，用户不改就不写盘）。 */
export function acpTurnTimeoutText(timeoutMs: number | undefined): string {
	const minutes = Math.round((timeoutMs ?? ACP_TURN_TIMEOUT_DEFAULT_MS) / 60_000);
	return String(Math.max(1, minutes));
}

export function acpStallTimeoutText(timeoutMs: number | undefined): string {
	const seconds = Math.round((timeoutMs ?? ACP_STALL_TIMEOUT_DEFAULT_MS) / 1_000);
	return String(Math.max(1, seconds));
}

/** 输入框文本（分钟）→ settings patch；非法输入返回 undefined。 */
export function acpTurnTimeoutPatch(raw: string): AcpTimeoutPatch | undefined {
	const minutes = parseBoundedInteger(raw, ACP_TURN_TIMEOUT_MINUTES);
	return minutes === null ? undefined : { acpPromptTurnTimeoutMs: minutes * 60_000 };
}

/** 输入框文本（秒）→ settings patch；非法输入返回 undefined。 */
export function acpStallTimeoutPatch(raw: string): AcpTimeoutPatch | undefined {
	const seconds = parseBoundedInteger(raw, ACP_STALL_TIMEOUT_SECONDS);
	return seconds === null ? undefined : { acpPromptStallTimeoutMs: seconds * 1_000 };
}
