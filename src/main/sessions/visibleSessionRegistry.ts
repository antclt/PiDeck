/**
 * 主窗口「可见会话」登记：live 流只发给界面里真正挂载的会话（性能治理，discussion #446）。
 *
 * 背景：每个流式会话都以 100ms 节奏向渲染层推送正文/思考（另有一条 runtime-state
 * 补丁），节奏不随会话数收敛。几百个并发会话时，不可见会话的 live 流仍会占满渲染
 * 进程主线程——表现为整页卡顿，停止出流后自行恢复。这里保存渲染层实际挂载的聊天栏
 * （当前会话 + 分屏），主进程据此丢弃不可见会话的 live 增量。
 *
 * 只有 live 流受此约束：消息快照、运行状态、通知仍全量下发，侧栏/Tab/历史缓存都依赖它们。
 * 可见性只接受主窗口上报——极简浮窗是独立渲染进程，它显示的会话不一定在主窗口可见。
 */
import { agentEventTags } from "../../shared/ipc";
import type { SessionRuntimeEvent } from "../../shared/types";

/** 同时可见的会话数量上限（当前 + 分屏；预留余量，防异常调用方传大数组）。 */
const MAX_VISIBLE_SESSION_IDS = 32;
/** 单个会话 id 长度上限：与 catalog id 量级一致，超长按脏数据丢弃。 */
const MAX_SESSION_ID_CHARS = 128;

/** 渲染层入参不可信：去重、trim、限长、限数量；非数组一律视为空。 */
export function normalizeVisibleSessionIds(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const value of input) {
		if (typeof value !== "string") continue;
		const id = value.trim();
		if (!id || id.length > MAX_SESSION_ID_CHARS || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
		if (ids.length >= MAX_VISIBLE_SESSION_IDS) break;
	}
	return ids;
}

/**
 * live 流（正文/思考）只对可见会话下发：它们只在挂载的时间线里被渲染，不可见会话的
 * 增量没有任何消费者。其它通道（messages/state/notice/ui-request）维持全量。
 */
export function shouldDeliverLiveStreamToMainWindow(event: Pick<SessionRuntimeEvent, "sourceChannel" | "sessionId">, isVisible: (sessionId: string) => boolean): boolean {
	if (event.sourceChannel !== agentEventTags.agentsTextStream && event.sourceChannel !== agentEventTags.agentsThinking) return true;
	return isVisible(event.sessionId);
}

export class VisibleSessionRegistry {
	private ids = new Set<string>();
	/** 是否收到过渲染层上报。启动早期（聊天栏还没挂载）按 fail-open 放行，见 shouldDeliver。 */
	private reported = false;

	/** 整表替换；返回本次新增可见的会话 id（调用方为它们补发 live 快照）。 */
	update(input: unknown): string[] {
		this.reported = true;
		const next = new Set(normalizeVisibleSessionIds(input));
		const added: string[] = [];
		for (const id of next) if (!this.ids.has(id)) added.push(id);
		this.ids = next;
		return added;
	}

	isVisible(sessionId: string): boolean {
		return this.ids.has(sessionId);
	}

	/** 收到过上报才启用门控：上报链路异常时宁可多推，也不能让正在看的会话没有正文。 */
	hasReported(): boolean {
		return this.reported;
	}

	clear(): void {
		this.ids.clear();
	}
}
