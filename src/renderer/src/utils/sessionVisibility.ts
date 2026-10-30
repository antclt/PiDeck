/**
 * 主窗口可见会话上报（性能治理，discussion #446）。
 *
 * 主进程只对「界面里真的挂载了聊天栏」的会话推送 live 正文/思考流；后台会话的增量
 * 没有消费者，几百路并发时会把渲染进程主线程打满。这里以模块级集合收口：每个
 * ChatSessionPane 挂载/卸载时登记，同一轮提交内的多次变化合并成一次 IPC。
 *
 * 引用计数按会话记（不是按实例直接删）：同一会话在特殊布局下可能同时挂两栏，先卸
 * 载的那一栏不能把还在显示的会话判成不可见。
 *
 * 不持久化、不跨窗口：极简浮窗也走同一个组件，但主进程只接受主窗口的上报。
 */
import { desktopApi } from "../desktopApi";

const mountCountBySession = new Map<string, number>();
let reportScheduled = false;
/** 上次成功上报的集合快照：无变化不重复发 IPC。 */
let lastReportedKey = "";

function scheduleReport(): void {
	if (reportScheduled) return;
	reportScheduled = true;
	queueMicrotask(() => {
		reportScheduled = false;
		flushReport();
	});
}

function flushReport(): void {
	const ids = [...mountCountBySession.keys()].sort();
	const key = ids.join("\u0000");
	if (key === lastReportedKey) return;
	lastReportedKey = key;
	// 旧 preload / 浏览器预览可能没有该 IPC：缺失时按不支持处理，不影响会话渲染。
	const report = desktopApi.sessions.setVisibleSessions;
	if (typeof report !== "function") return;
	void report(ids).catch(() => {
		// 预览/Web 端没有该 IPC；失败不能让下一轮同值上报被吞掉，清掉快照等下次重试。
		if (lastReportedKey === key) lastReportedKey = "";
	});
}

/**
 * 聊天栏挂载时登记。返回卸载函数：返回 true 表示这是该会话的最后一个实例
 * （调用方据此清掉 live 正文；还有其它实例在显示时必须保留）。
 */
export function registerVisibleSession(sessionId: string): () => boolean {
	mountCountBySession.set(sessionId, (mountCountBySession.get(sessionId) ?? 0) + 1);
	scheduleReport();
	let disposed = false;
	return () => {
		if (disposed) return false;
		disposed = true;
		const remaining = (mountCountBySession.get(sessionId) ?? 1) - 1;
		if (remaining > 0) {
			mountCountBySession.set(sessionId, remaining);
			return false;
		}
		mountCountBySession.delete(sessionId);
		scheduleReport();
		return true;
	};
}
