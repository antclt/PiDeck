/**
 * DSH 子代理 transcript 页投影（纯函数）。
 *
 * 从 DshAgentManager.readSubagentHistory 抽出：host session/page 的原始事件流
 * → ChatMessage 页。除消息外携带 oldestSeq 游标（本页最早事件的 seq）——渲染层
 * 「加载更早」用它回传 beforeSeq；没有游标时长子会话只能读到尾部一页，hasMore
 * 成了死信息（2026-10 用户反馈「点进子代理会话一半没渲染」的直接成因之一）。
 */

import type { ChatMessage } from "../../shared/types";
import { projectDshEvent } from "./dshEventProjector";
import type { DshHistoryEntry } from "./dshRemoteClient";

export type DshSubagentTranscriptPage = {
	messages: ChatMessage[];
	hasMore: boolean;
	/** 本页最早事件的 seq：渲染层「加载更早」的 beforeSeq 游标；空页/事件无 seq 时缺省。 */
	oldestSeq?: number;
};

export function projectDshSubagentTranscriptPage(events: readonly DshHistoryEntry[], childAgentId: string, hasMore: boolean): DshSubagentTranscriptPage {
	const entries = (events ?? [])
		.map((entry) => ({ event: entry.event, view: entry.view }))
		.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event))
		.sort((left: { event: { seq?: number } }, right: { event: { seq?: number } }) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
	let projection = projectDshEvent(undefined, undefined, childAgentId);
	for (const { event, view } of entries) {
		projection = projectDshEvent(projection, event, childAgentId, view);
	}
	const oldestEventSeq = entries[0]?.event.seq;
	return {
		messages: projection.messages,
		hasMore,
		...(typeof oldestEventSeq === "number" ? { oldestSeq: oldestEventSeq } : {}),
	};
}
