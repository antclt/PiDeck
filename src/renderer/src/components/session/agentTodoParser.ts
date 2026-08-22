import type { TodoItem, TodoItemStatus } from "../agents/todo-list";

/** 与官方 BeUI TodoItem 对齐的解析结果（title 恒为 string）。 */
export type AgentTodoItem = TodoItem;

// 内置扩展（resources/extensions/pi-deck-todo.ts / pi-deck-plan-mode.ts）的 widget 行格式
// 是数据契约而非 UI 文案，解析侧硬编码这些字面量是合理的（不经过 i18n）。
/** 计划元数据由 pi-deck-todo 专用入口过滤；通用 parser 不解释它，避免影响第三方 widget。 */
const PI_DECK_TODO_PLAN_METADATA_LINE = /^\[\[pid:todo-plan:[^\]]+\]\]$/;
/** todo/plan 的摘要行不是列表项。 */
const SUMMARY_LINE = /^\d+\/\d+$/;
/** plan 扩展首行进度摘要（如 "计划进度 1/3"），不是列表项。 */
const PLAN_PROGRESS_LINE = /^计划进度\s*\d+\/\d+$/;
/** plan 扩展草案首行（如 "计划草案 3 步"），不是列表项。 */
const PLAN_DRAFT_LINE = /^计划草案\s*\d+\s*步$/;
/** 分组标题行（如 "── 待办 ──" / "── 已完成 ──"），仅作分组提示，不进入列表。 */
const SECTION_HEADER_LINE = /^── .+ ──$/;
/** 完成态标记：todo 扩展用 ☑，兼容 [x]/[X] 文本标记。 */
const COMPLETED_MARKER = /^(?:☑|\[[xX]\])/;
/** 进行中标记（扩展未输出，但类型支持；parser 保守支持以免未来扩展复用行式）。 */
const IN_PROGRESS_MARKER = /^(?:◐|⏳)/;

export function stripPiDeckTodoWidgetMetadata(lines: readonly string[]): string[] {
	return lines.filter((line) => !PI_DECK_TODO_PLAN_METADATA_LINE.test(line.trim()));
}

/**
 * 将 pi 扩展的轻量 widget 行转换为官方 BeUI TodoItem 数据模型。
 *
 * 规则：
 * - `pi-deck-todo` 的计划身份元数据必须先由 `stripPiDeckTodoWidgetMetadata` 过滤；
 *   该元数据只属于内置 widget 协议，通用 parser 不应误伤第三方 widget；
 * - 跳过空行、折叠摘要（"2/4" / "计划进度 1/3" / "计划草案 3 步"）、
 *   分组标题（"── 待办 ──"）——
 *   旧实现会把标题行误解析成 pending 项，这里按真实扩展格式修正；
 * - 状态映射：☑/[x]/[X] → completed，◐/⏳ → in-progress，其余（含 ☐）→ pending；
 * - 标题剥离标记与前缀：todo 的 "#3"、plan 的 "1." / "1)" 均不进标题，
 *   todo id 与 plan 步骤号信息保留在原行中（widget 快照可随时重建）；
 * - id 以清洗后的标题为基（同标题追加出现序号消歧）：状态切换 / 行增删时 key 稳定，
 *   官方 TodoList 的 strikethrough 与 layout 动画才能正确播放。
 */
export function parseAgentTodoItems(lines: readonly string[]): AgentTodoItem[] {
	const seenTitles = new Map<string, number>();
	const items: AgentTodoItem[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (SUMMARY_LINE.test(trimmed) || PLAN_PROGRESS_LINE.test(trimmed) || PLAN_DRAFT_LINE.test(trimmed)) continue;
		if (SECTION_HEADER_LINE.test(trimmed)) continue;

		const completed = COMPLETED_MARKER.test(trimmed);
		const active = IN_PROGRESS_MARKER.test(trimmed);
		const title = trimmed
			.replace(/^(?:☑|☐|◐|⏳|\[[ xX]\])\s*/, "")
			.replace(/^#\d+\s*/, "")
			.replace(/^\d+[.)]\s*/, "")
			.trim();
		// 只有标记没有正文的行（如 "☑"）不产生列表项
		if (!title) continue;

		const occurrence = (seenTitles.get(title) ?? 0) + 1;
		seenTitles.set(title, occurrence);
		items.push({
			id: occurrence === 1 ? title : `${title}#${occurrence}`,
			title,
			status: completed ? "completed" : active ? "in-progress" : "pending",
		});
	}
	return items;
}
