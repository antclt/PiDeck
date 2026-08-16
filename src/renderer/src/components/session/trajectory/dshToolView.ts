/**
 * DSH 工具视图（host ToolEventView）→ 轨迹可读信息（纯函数，可单测）。
 *
 * dsh-web 的工具卡片信息源是 host 为每个 tool/call、tool/result 计算好的
 * `view`（ToolCallView / ToolResultView：terminal/diff/generic/search/read 等
 * 卡片形态，含命令/输出/退出码/diff/搜索命中）。投影器把 call 视图存在
 * `meta.view`、result 视图存在 `meta.resultView`（信封 = { for, view }），
 * 轨迹账本据此展示比「工具名 + 原文」更完整的信息（与 dsh-web 历史页同数据）。
 */

export type DshToolViewEnvelope = { for?: unknown; view?: unknown } | undefined | null;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 从 ToolEventView 信封中按 call/result 取出视图本体。 */
export function unwrapToolView(
	envelope: DshToolViewEnvelope,
	want: "call" | "result",
): Record<string, unknown> | undefined {
	if (!isRecord(envelope)) return undefined;
	if (envelope.for !== want) return undefined;
	return isRecord(envelope.view) ? envelope.view : undefined;
}

/** content 块（harness ContentBlock[]）拼文本：text 块拼接，其余忽略。 */
function contentText(blocks: unknown): string | undefined {
	if (!Array.isArray(blocks)) return undefined;
	const parts: string[] = [];
	for (const block of blocks) {
		if (!isRecord(block) || block.type !== "text") continue;
		if (typeof block.text === "string" && block.text.trim()) parts.push(block.text.trim());
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function rawInputText(rawInput: unknown): string | undefined {
	if (rawInput === undefined || rawInput === null) return undefined;
	if (typeof rawInput === "string") return rawInput.trim() ? rawInput : undefined;
	try {
		const serialized = JSON.stringify(rawInput);
		return serialized && serialized !== "{}" ? serialized : undefined;
	} catch {
		return undefined;
	}
}

/** diff 条目 → "path (+a −b 行)" 摘要；无 path 用索引。 */
function diffsSummary(diffs: unknown): string | undefined {
	if (!Array.isArray(diffs)) return undefined;
	const parts: string[] = [];
	for (const diff of diffs) {
		if (!isRecord(diff)) continue;
		const path = asString(diff.path) ?? asString(diff.file) ?? asString(diff.filePath);
		const oldLines = asNumber(diff.oldLines) ?? asNumber(diff.removedLines);
		const newLines = asNumber(diff.newLines) ?? asNumber(diff.addedLines);
		const label = path ?? "?";
		if (oldLines !== undefined || newLines !== undefined) {
			parts.push(`${label} (+${newLines ?? 0} −${oldLines ?? 0})`);
		} else {
			parts.push(label);
		}
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

/** search 结果 → "path: N 处命中" 列表。 */
function searchSummary(view: Record<string, unknown>): string | undefined {
	const shape = view.shape;
	const groups = Array.isArray(view.files)
		? (view.files as unknown[])
		: Array.isArray(view.paths)
			? (view.paths as unknown[])
			: undefined;
	if (shape !== "matches" && !Array.isArray(view.files)) return undefined;
	const parts: string[] = [];
	for (const group of groups ?? []) {
		if (!isRecord(group)) continue;
		const path = asString(group.path);
		const matches = Array.isArray(group.matches) ? (group.matches as unknown[]) : undefined;
		if (path && matches !== undefined) {
			parts.push(`${path}: ${matches.length} 处命中`);
		} else if (path) {
			parts.push(path);
		}
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

/** read 结果 → "N 行" 摘要。 */
function readSummary(view: Record<string, unknown>): string | undefined {
	const lines = Array.isArray(view.lines) ? (view.lines as unknown[]) : undefined;
	if (lines === undefined) return undefined;
	const offset = asNumber(view.offset);
	const label = offset !== undefined ? `L${offset}+` : "";
	return `${label}${lines.length} 行`;
}

/**
 * 视图标题（卡片头，如 terminal 的命令、diff 的 "Write foo.txt"）。
 * call 优先，result 可替换标题（缺省保持 call 标题）。
 */
export function toolViewTitle(
	meta: { view?: DshToolViewEnvelope; resultView?: DshToolViewEnvelope } | undefined,
): string | undefined {
	const call = meta ? unwrapToolView(meta.view, "call") : undefined;
	const result = meta ? unwrapToolView(meta.resultView, "result") : undefined;
	return asString(result?.title) ?? asString(call?.title);
}

/**
 * 视图详情（按卡片形态拼可读信息，轨迹 inspector 用）：
 * - terminal：命令（call title）+ cwd；result 追加输出尾部与退出码；
 * - diff：改动文件摘要（call/result 取后者优先）；
 * - generic：rawInput + content 文本；
 * - search：命中列表；read：行数；web：标题/URL。
 */
export function toolViewDetail(
	meta: { view?: DshToolViewEnvelope; resultView?: DshToolViewEnvelope } | undefined,
): string | undefined {
	if (!meta) return undefined;
	const call = unwrapToolView(meta.view, "call");
	const result = unwrapToolView(meta.resultView, "result");
	if (!call && !result) return undefined;

	const card = result?.card ?? call?.card;
	const parts: string[] = [];
	if (card === "terminal") {
		const command = asString(result?.title) ?? asString(call?.title);
		if (command) parts.push(`$ ${command}`);
		const cwd = asString(call?.cwd);
		if (cwd) parts.push(`cwd: ${cwd}`);
		const output = asString(result?.output);
		if (output) parts.push(output.length > 800 ? `${output.slice(0, 800)}…` : output);
		const exitCode = asNumber(result?.exitCode);
		if (exitCode !== undefined) parts.push(`exit ${exitCode}`);
		const signal = asString(result?.signal);
		if (signal) parts.push(`signal ${signal}`);
	} else if (card === "diff") {
		const summary = diffsSummary(result?.diffs) ?? diffsSummary(call?.diffs);
		if (summary) parts.push(summary);
	} else if (card === "search") {
		const summary = searchSummary(result ?? {});
		if (summary) parts.push(summary);
	} else if (card === "read") {
		const summary = readSummary(result ?? {});
		if (summary) parts.push(summary);
	} else {
		// generic / web：rawInput + content 文本
		const raw = rawInputText(call?.rawInput);
		if (raw) parts.push(raw);
		const content = contentText(result?.content) ?? contentText(call?.content);
		if (content) parts.push(content);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}
