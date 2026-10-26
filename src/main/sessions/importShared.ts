/**
 * 外部 CLI 会话导入的共用工具（Cursor / Kimi / Kimi Work / WorkBuddy 等 *SessionSource/*SessionConvert）。
 *
 * 这几个源格式的目录布局与字段各不相同，但「跑在 ~/.pi/sessions 下的项目目录编码」
 * 「任意 JSON 收窄成 Record」「导入会话的零 usage 占位」「标题清洗」是同一套规则。
 * 2026-10 前这三份 Source/Convert 各自复制了一份，改一处漏两处；现在收口到这里。
 *
 * 只放纯函数与 fs 目录创建；不依赖 electron，便于单测直接加载。
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** 导入源的 JSONL 行结构不固定：统一按 unknown 读入后再逐字段收窄，非对象退化成空对象。 */
export function readRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 项目路径归一（反斜杠→斜杠、去尾斜杠、小写）：只用于「是不是同一个项目」的比较，不用于落盘。 */
export function normalizePath(path?: string): string {
	return String(path ?? "")
		.replace(/\\/g, "/")
		.replace(/\/+$/, "")
		.toLowerCase();
}

/** 项目路径 → pi sessions 子目录名：`D:\a\b` → `--D--a-b--`，`/home/u` → `--home-u--`（与 pi 同口径）。 */
export function safePathToken(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const win = normalized.match(/^([A-Za-z]):\/(.+)$/);
	if (win) return `--${win[1]}--${win[2].replace(/\//g, "-")}--`;
	return `--${normalized.replace(/^\//, "").replace(/\//g, "-")}--`;
}

/** 项目在 pi sessions 下的目录（不保证存在）。 */
export function getProjectSessionDir(piRoot: string, projectPath: string): string {
	return join(piRoot, safePathToken(projectPath));
}

/** 确保项目在 pi sessions 下的目录存在，返回其绝对路径。 */
export async function ensureProjectSessionDir(piRoot: string, projectPath: string): Promise<string> {
	const dir = getProjectSessionDir(piRoot, projectPath);
	await mkdir(dir, { recursive: true });
	return dir;
}

/** 导入会话的 usage 占位：源格式不提供 token 统计，但 pi 会话行要求字段齐备。 */
export function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * 导入会话标题清洗：折叠空白；`untitled` 视为无标题；超 40 字符截断。
 * 各源导出成自己的历史名字（cleanCursorTitle / cleanKimiTitle / cleanWorkBuddyTitle）。
 */
export function cleanImportTitle(value?: string): string {
	const text = value?.replace(/\s+/g, " ").trim();
	if (!text || /^untitled$/i.test(text)) return "";
	return text.length > 40 ? `${text.slice(0, 40)}...` : text;
}
