/**
 * useToolDerivedActivity — ACP 会话的「工具推导活动」数据源（待办 / 子代理）。
 *
 * 为什么放在渲染层而不是主进程投影：ACP 的 CLI 把待办和子代理都当普通工具调用上报，
 * 协议层没有对应字段（详见 shared/toolActivityDerivation.ts）。渲染层已经持有完整的
 * 工具卡消息（实时链 + 归档回放），在这里折叠一次即可**同时覆盖活会话与重开的历史
 * 会话**——主进程的投影状态在 stop 之后就没了，历史会话重新激活也不会重建工具卡索引。
 *
 * 只在 `enabled`（ACP 后端）时推导：pi 有扩展 widget + record 三源，DSH 有官方
 * projection，重复推导会变成同一批条目的第二份拷贝。
 *
 * @module useToolDerivedActivity
 */

import { useAtomValue } from "jotai";
import { useMemo } from "react";
import type { PiSubagentEntry, TodoItem } from "../../../shared/types";
import { deriveSubagents, deriveTodoPlan } from "../../../shared/toolActivityDerivation";
import { sessionMessageCacheBySessionIdAtomFamily } from "../atoms";

type DerivedActivity = {
	todos: TodoItem[];
	subagents: PiSubagentEntry[];
};

/** 稳定空值：避免每次渲染都造新对象，下游 memo 依赖才不会被无谓打断。 */
const EMPTY: DerivedActivity = { todos: [], subagents: [] };

export function useToolDerivedActivity(sessionId: string, enabled: boolean): DerivedActivity {
	const messages = useAtomValue(sessionMessageCacheBySessionIdAtomFamily(sessionId))?.messages;
	return useMemo(() => {
		if (!enabled || !messages || messages.length === 0) return EMPTY;
		return { todos: deriveTodoPlan(messages), subagents: deriveSubagents(messages) };
	}, [enabled, messages]);
}
