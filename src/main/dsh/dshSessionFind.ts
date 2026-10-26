import { SESSION_FIND_MAX_MATCHES, findSessionMatches, type FindableMessage, type SessionFindMatchesResult } from "../sessions/sessionFindMatches";

/**
 * DSH 会话内查找的匹配层：薄再导出（实现已抽到 main/sessions/sessionFindMatches）。
 *
 * 为什么保留这一层：匹配语义被 pi / DSH / ACP 三个后端共用（同一个 Ctrl/Cmd+Shift+F
 * 换后端不能换规则），但 DSH 的调用面（DshAgentManager）与既有回归测试按
 * findDshSessionMatches / DSH_SESSION_FIND_MAX_MATCHES 命名断言，改名等于制造无谓
 * 的跨文件改动；这里只做别名转发，行为零变化。
 *
 * 与 Go 的差异只有「id 形态」：pi 命中回的是会话文件条目 id（渲染层再归一），
 * DSH 没有会话文件条目，直接用投影消息 id（`dsh:<seq>`），jumpToMessage 按消息 id
 * 就能定位。消息正文只取 user/assistant（工具卡片、系统提示不参与），与 host
 * session.search 的面一致。
 */

/** 会话内查找的命中上限（与 pi 的 DEFAULT_IN_SESSION_LIMIT 一致：单会话、按时间线导航）。 */
export const DSH_SESSION_FIND_MAX_MATCHES = SESSION_FIND_MAX_MATCHES;

export type DshSessionFindResult = SessionFindMatchesResult;

/** 会话内查找只需要消息的这几个字段：接受任意投影消息切片，测试可用工厂构造。 */
export type DshFindableMessage = FindableMessage;

export function findDshSessionMatches(messages: ReadonlyArray<DshFindableMessage>, query: string, limit = DSH_SESSION_FIND_MAX_MATCHES): DshSessionFindResult {
	return findSessionMatches(messages, query, limit);
}
