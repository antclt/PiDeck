/**
 * 会话文件修改解析（跨进程共用纯函数）。
 *
 * 从会话消息的 write/edit/create/patch 工具调用中提取路径与 diff 目标，按文件聚合。
 * main（会话文件修改汇总 IPC）与 renderer（TimelineFormat / 文件 tab）共用同一份实现，
 * 避免两处各自复制解析逻辑导致口径漂移。
 *
 * 注意：工具参数解析已收口到 `shared/toolArgs.ts`，main / renderer 共用同一实现。
 * 本模块无运行时依赖，可被 node 单测直接加载。
 */
import type { ChatMessage } from "./types.ts";
import type { SessionFileChange } from "./types/fileChanges.ts";
// ANSI 净化与工具参数解析的唯一实现在 shared/ 下；本模块只转出 stripAnsi 维持旧调用点。
import { stripAnsiCsi as stripAnsi } from "./ansiText.ts";
import { parseToolArgs } from "./toolArgs.ts";

export { stripAnsi };

export function getToolFilePath(args: unknown): string | undefined {
	if (!args) return undefined;
	let a: unknown = args;
	if (typeof a === "string" && a.trim()) {
		try {
			a = JSON.parse(a);
		} catch {
			return undefined;
		}
	}
	if (typeof a !== "object" || a === null) return undefined;
	const r = a as Record<string, unknown>;
	return typeof r.filePath === "string" && r.filePath
		? r.filePath
		: typeof r.file_path === "string" && r.file_path
			? r.file_path
			: typeof r.path === "string" && r.path
				? r.path
				: typeof r.targetPath === "string" && r.targetPath
					? r.targetPath
					: typeof r.target_path === "string" && r.target_path
						? r.target_path
						: typeof r.outputPath === "string" && r.outputPath
							? r.outputPath
							: typeof r.output_path === "string" && r.output_path
								? r.output_path
								: typeof r.file === "string" && r.file
									? r.file
									: typeof r.fileName === "string" && r.fileName
										? r.fileName
										: typeof r.filename === "string" && r.filename
											? r.filename
											: undefined;
}

function countTextLines(value: string): number {
	return value ? value.split(/\r\n|\r|\n/).length : 0;
}

function getToolEditDiff(args: Record<string, unknown>): { oldText: string; newText: string } | undefined {
	const edits = Array.isArray(args.edits) ? args.edits : undefined;
	if (edits) {
		const parts = edits
			.map((edit: unknown) => {
				if (!edit || typeof edit !== "object") return null;
				const e = edit as Record<string, unknown>;
				const oldText = String(e.oldText ?? e.old_text ?? e.old_string ?? "");
				const newText = String(e.newText ?? e.new_text ?? e.new_string ?? "");
				return { oldText, newText };
			})
			.filter((p): p is { oldText: string; newText: string } => p !== null);
		if (parts.length === 0) return undefined;
		return {
			oldText: parts.map((p) => p.oldText).join("\n"),
			newText: parts.map((p) => p.newText).join("\n"),
		};
	}
	const oldText = typeof args.oldText === "string" ? args.oldText : typeof args.old_text === "string" ? args.old_text : typeof args.old_string === "string" ? args.old_string : undefined;
	const newText = typeof args.newText === "string" ? args.newText : typeof args.new_text === "string" ? args.new_text : typeof args.new_string === "string" ? args.new_string : undefined;
	if (oldText === undefined || newText === undefined) return undefined;
	return { oldText, newText };
}

/**
 * 纯函数结果缓存（v0.9.7 渲染虚拟化补丁，#406）：同输入直接返回上次结果，条目到上限整表清空，
 * 超过 maxInput 的输入不缓存（防长正文撑爆）。本模块原有的 stripAnsi 缓存包装在 dev 侧
 * stripAnsi 迁往 shared/ansiText.ts 时一并让位——这里只保留通用 helper，
 * 供 renderer 的 cleanAnswerText 等多趟正则变换使用（见 timeline/answerText.ts）。
 */
export function createTextTransformCache(transform: (text: string) => string, limit = 256, maxInput = 64 * 1024): (text: string) => string {
	const cache = new Map<string, string>();
	return (text: string) => {
		const cached = cache.get(text);
		if (cached !== undefined) return cached;
		const value = transform(text);
		if (text.length <= maxInput) {
			if (cache.size >= limit) cache.clear();
			cache.set(text, value);
		}
		return value;
	};
}
/**
 * 文件修改类工具名（write / edit / create / patch）：产出 diff 目标的工具集合。
 *
 * 单一口径：聚合侧（getToolDiffTarget）与读取侧的「预判要不要把这一行读进内存」
 * （SessionHistoryReader.isFileChangeSource）共用本判定，避免两处正则各写一份漂移。
 */
export const FILE_CHANGE_TOOL_RE = /write|edit|create|patch/i;

export function isFileChangeToolName(toolName: string): boolean {
	return FILE_CHANGE_TOOL_RE.test(toolName);
}

export function getToolName(message: ChatMessage): string {
	const fromMeta = message.meta?.toolName;
	if (typeof fromMeta === "string" && fromMeta.trim()) return fromMeta;
	const text = stripAnsi(message.text)
		.replace(/^[\u25b6\u2713\u2717]\s*/u, "")
		.trim();
	return text.split(/\s+/)[0] || "tool";
}

/**
 * 提取单条工具消息的 diff 目标（write/edit/create/patch）：
 * write/create 提供完整新内容；edit/patch 提供变动区域（oldText/newText）。
 * 与单条工具卡片的 diff 按钮共用，会话文件汇总也复用此逻辑。
 *
 * ACP 的编辑工具还多一条「只有路径」的形态：Qoder 等 CLI 的 rawInput 只上报
 * `{file_path}`（旧/新文本不在 wire 上），而 meta.kind="edit" 是协议里的可靠类别。
 */
export function getToolDiffTarget(message: ChatMessage): { path: string; originalContent: string; content: string; changedLines: number } | undefined {
	const toolName = getToolName(message);
	// ACP 工具卡的 toolName 是 agent 给的人类标题（Qoder 为 "Edit"/"Write"），
	// kind 才是协议类别；只有路径的编辑靠它兜底（见下方 return）。
	const acpEdit = message.meta?.kind === "edit";
	if (!isFileChangeToolName(toolName) && !acpEdit) return undefined;
	const args = parseToolArgs(message.meta?.args);
	const path = getToolFilePath(args);
	if (!args || !path) return undefined;
	if (/write|create/i.test(toolName)) {
		const content = typeof args.content === "string" ? args.content : typeof args.text === "string" ? args.text : undefined;
		if (content !== undefined) return { path, originalContent: "", content, changedLines: countTextLines(content) };
	}
	// edit/patch：不存储 full file originalContent，只展示变动区域
	if (isFileChangeToolName(toolName)) {
		const diff = getToolEditDiff(args);
		if (diff) {
			return {
				path,
				originalContent: diff.oldText,
				content: diff.newText,
				changedLines: Math.max(countTextLines(diff.oldText), countTextLines(diff.newText)),
			};
		}
	}
	// 只有路径（wire 上没有旧/新文本）：文件确实被改过，但没有 diff 内容可展示。
	if (acpEdit) return { path, originalContent: "", content: "", changedLines: 0 };
	return undefined;
}

/** 条目是否带可展示的 diff 内容：只上报路径的 ACP 编辑为空，chip 不显示增删行数、点击退回打开文件。 */
export function hasFileChangePayload(entry: { originalContent: string; content: string }): boolean {
	return entry.originalContent.length > 0 || entry.content.length > 0;
}

/**
 * 遍历会话消息收集 write/edit/create/patch 修改的文件（复用 getToolDiffTarget）。
 * 同文件多次修改取最后一次**带内容**的 diff 并累计次数：ACP 只上报路径的条目
 * 不能把先前拿到的 diff 冲成空串（否则同一文件后一次编辑会把 chip 的增删行数抹掉）。
 */
export function collectSessionFileChanges(messages: readonly ChatMessage[]): SessionFileChange[] {
	const map = new Map<string, SessionFileChange>();
	for (const message of messages) {
		const target = getToolDiffTarget(message);
		if (!target) continue;
		const prev = map.get(target.path);
		// 新条目没有内容（ACP 只上报路径）时保留上一次的 diff 载荷。
		const payload = hasFileChangePayload(target);
		map.set(target.path, {
			path: target.path,
			count: (prev?.count ?? 0) + 1,
			originalContent: payload ? target.originalContent : (prev?.originalContent ?? ""),
			content: payload ? target.content : (prev?.content ?? ""),
		});
	}
	return [...map.values()];
}
