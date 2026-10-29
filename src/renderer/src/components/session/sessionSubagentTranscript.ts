/**
 * 子代理会话读取预算与 DSH transcript 分页（纯函数 + 注入式读取）。
 *
 * 两条读路径的「子代理会话读不全」兜底（2026-10 用户反馈：点进子代理会话记录
 * 一半没渲染）：
 * - pi 子会话：首开数据页从 9 轮放宽到 40 轮（readSessionFirstScreenPage 沿
 *   nextBefore 游标补页合并）。DOM 挂载窗口仍按 2026-08 内存治理只挂尾部 3 轮
 *   渐进展开——这里只放宽数据页，上滚/「显示更早」在缓存内零延迟。
 * - DSH 子代理 transcript：单页条数显式化（主进程缺省 100 且旧渲染层丢弃
 *   hasMore，长子会话只渲染尾部 100 条）+ oldestSeq 游标支持「加载更早」。
 */

import type { ChatMessage, SessionMessagePage } from "../../../../shared/types";
import { sessionHistoryUnavailableState } from "../../utils/sessionHistoryAvailability";
import { replaceExpandedRefBlocksWithLabels } from "./composer/quoteChip";
import { countUserTurns } from "./timeline/turnRenderWindow";

/** 历史会话（disk 路径）首开数据页的轮数：与运行时窗口 DISPLAY_WINDOW_TURNS(9) 对齐，
 *  首次上滚 9 轮内零延迟；翻页与 runtime 同用 3 轮 cohort。
 *  2026-09 统一轮次协议：废除旧的「按消息条数(100)」页大小，页大小只以轮次计。 */
export const DISK_INITIAL_TURN_PAGE_SIZE = 9;

/** 子代理子会话首开数据页的轮数预算：点进子会话只看到尾部一小段的观感来源，
 *  沿游标补页把数据窗口读满；DOM 挂载窗口治理口径不变。 */
const CHILD_SESSION_INITIAL_TURN_BUDGET = 40;

/** DSH 子代理 transcript 单页条数：显式传给主进程，不再吃 100 的隐式缺省。 */
export const DSH_SUBAGENT_TRANSCRIPT_PAGE_SIZE = 200;

/** DSH transcript 行：渲染层只吃 role + 折叠引用后的纯文本；id 供去重与 React key。 */
export type DshTranscriptRow = { id: string; role: string; text: string };

export function dshTranscriptRowFromMessage(message: ChatMessage): DshTranscriptRow {
	return {
		id: message.id,
		role: message.role,
		// 转录是纯文本出口：折叠自包含引用块，避免露出 <quoted_context> 等 XML 原文。
		text: replaceExpandedRefBlocksWithLabels(message.text),
	};
}

/**
 * 「加载更早」合并：older 页整行插在已有行之前，按消息 id 去重（host 的 beforeSeq
 * 若为包含式语义，边界消息不能渲染两遍）。host 返回空页却仍标 hasMore 时收口为
 * false，否则「加载更早」变成无限空转。
 */
export function mergeOlderDshTranscriptPage(existing: readonly DshTranscriptRow[], page: { messages: ChatMessage[]; hasMore: boolean; oldestSeq?: number }): { rows: DshTranscriptRow[]; hasMore: boolean; oldestSeq?: number } {
	const existingIds = new Set(existing.map((row) => row.id));
	const olderRows = page.messages.map(dshTranscriptRowFromMessage).filter((row) => !existingIds.has(row.id));
	return {
		rows: [...olderRows, ...existing],
		hasMore: page.hasMore === true && olderRows.length > 0,
		oldestSeq: page.oldestSeq,
	};
}

type ReadSessionMessagePage = (sessionId: string, before?: number, pageSize?: number) => Promise<SessionMessagePage>;

/**
 * 历史会话首开数据页：普通会话一页（9 轮）即返；子代理子会话（parentSessionPath
 * 存在）沿 nextBefore 游标连读补页，直到凑满轮数预算或到顶。任何一页带
 * unavailable（如 DSH host 手动停止）时原样返回该页，交给调用方既有的
 * sessionHistoryUnavailableState 闸门进专态——不能把半截数据与「暂时读不了」
 * 混在一起写缓存。
 */
export async function readSessionFirstScreenPage(readPage: ReadSessionMessagePage, sessionId: string, parentSessionPath: string | undefined): Promise<SessionMessagePage> {
	let merged = await readPage(sessionId, undefined, DISK_INITIAL_TURN_PAGE_SIZE);
	if (!parentSessionPath || sessionHistoryUnavailableState(merged)) return merged;
	// 元数据以首读（最新切片）为准：model/thinkingLevel 描述会话当前状态，
	// total 是全会话消息数，indexVersion 供缓存做外部改写比对
	const { total, model, thinkingLevel, indexVersion } = merged;
	let turns = countUserTurns(merged.messages);
	while (typeof merged.nextBefore === "number" && turns < CHILD_SESSION_INITIAL_TURN_BUDGET) {
		const cursor = merged.nextBefore;
		const older = await readPage(sessionId, cursor, DISK_INITIAL_TURN_PAGE_SIZE);
		if (sessionHistoryUnavailableState(older)) return older;
		// 游标必须严格前进：host 异常回放同一游标时收口返回已合并内容，避免死循环
		if (typeof older.nextBefore === "number" && older.nextBefore >= cursor) return merged;
		merged = {
			...older,
			messages: [...older.messages, ...merged.messages],
			total,
			nextBefore: older.nextBefore,
			nextBeforeEntryId: older.nextBeforeEntryId,
			...(model ? { model } : {}),
			...(thinkingLevel ? { thinkingLevel } : {}),
			...(indexVersion ? { indexVersion } : {}),
		};
		turns += countUserTurns(older.messages);
	}
	return merged;
}
