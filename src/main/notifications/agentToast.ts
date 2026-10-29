/**
 * Agent 会话桌面通知（Windows toast）的统一出口：品牌字标 + 点击深链跳回会话。
 *
 * 为什么要收口：pi / DSH / ACP 三条后端都要发「会话完成」与「Ask 提问」通知，
 * toast XML、logo、点击跳转与失败日志只要各写一份就会漂移（历史上已经出现过
 * 「logo 外一层边框」「点击不跳会话」两次事故，见 notificationToast.ts 注释）。
 *
 * 门控顺序（三条后端一致）：对应开关 → 仅失焦提醒 → 系统支持。
 * pi 在 AgentManager 内部保留自己的门控与文案（行为不变），只复用这里的构造；
 * DSH/ACP 直接走 notifySessionFinished / notifyAskPending。
 */
import { Notification, type BrowserWindow } from "electron";
import type { AppSettings } from "../../shared/types";
import { APP_DISPLAY_NAME } from "../utils/appBrand";
import { isMainWindowFocused, shouldAlertNow } from "./alertFocusGate";
import { buildToastXml, notificationLaunchUrl } from "./notificationToast";

export type AgentNotificationKind = "done" | "ask";

export type AgentToastCopyKey = "mainNotification.sessionDone" | "mainNotification.askQuestion" | "mainNotification.askPending";

export type AgentToastDeps = {
	/** 宿主未就绪时返回 null（通知静默跳过）。 */
	settings: () => AppSettings | null;
	getWindow: () => BrowserWindow | null;
	logoUri: () => string | null;
	translate: (key: AgentToastCopyKey, params?: Record<string, string | number>) => string;
	/** 点击通知后：聚焦窗口并切到会话（sessionId 缺省只聚焦）。 */
	activate: (sessionId?: string) => void;
	logger?: { warn: (scope: string, message: string, detail?: unknown) => void };
};

/** 门控：对应开关 → 仅失焦提醒 → 系统支持。 */
export function agentToastGate(deps: AgentToastDeps, kind: AgentNotificationKind): boolean {
	const settings = deps.settings();
	if (!settings) return false;
	if (kind === "done" ? !settings.enableNotifications : !settings.askNotificationEnabled) return false;
	if (!shouldAlertNow(settings.alertOnlyWhenUnfocused, isMainWindowFocused(deps.getWindow()))) return false;
	return Notification.isSupported();
}

/** 构造并弹出 toast；失败静默——通知不得影响会话主流程。 */
export function showAgentToast(deps: AgentToastDeps, input: { agentId: string; kind: AgentNotificationKind; body: string; sessionId?: string }): void {
	try {
		const appName = APP_DISPLAY_NAME;
		const notification = new Notification({
			title: appName,
			body: input.body,
			silent: false,
			// 自定义 toast XML：launch 携带 sessionId，点击后经 pideck:// 协议唤起应用并跳转对应会话
			toastXml: buildToastXml({ title: appName, body: input.body, launch: notificationLaunchUrl(input.sessionId), logoUri: deps.logoUri() }),
		});
		notification.on("click", () => deps.activate(input.sessionId));
		notification.on("failed", (_event, error) => {
			// Windows 拒绝显示 toast 时触发（show() 本身不抛异常），记 warn 便于排查
			void deps.logger?.warn("agent", input.kind === "done" ? "Session notification failed to show" : "Ask notification failed to show", { agentId: input.agentId, error: String(error) });
		});
		notification.show();
	} catch {
		// 通知失败不影响主流程，静默处理
	}
}

/** 会话完成通知（ACP/DSH 用；pi 在 AgentManager 内保留自己的门控后复用 showAgentToast）。 */
export function notifySessionFinished(deps: AgentToastDeps, input: { agentId: string; title: string; sessionId?: string }): void {
	if (!agentToastGate(deps, "done")) return;
	showAgentToast(deps, { agentId: input.agentId, kind: "done", body: deps.translate("mainNotification.sessionDone", { title: input.title }), ...(input.sessionId ? { sessionId: input.sessionId } : {}) });
}

/**
 * Ask 提问通知（ACP/DSH 用）。返回是否真的弹出：调用方据此维护「每轮只提醒一次」，
 * 开关关着时不占用去重位（用户中途打开开关仍能收到当前提问）。
 */
export function notifyAskPending(deps: AgentToastDeps, input: { agentId: string; sessionId: string; sessionTitle: string; question: string }): boolean {
	if (!agentToastGate(deps, "ask")) return false;
	const title = input.sessionTitle;
	const questionText = input.question.length > 60 ? `${input.question.slice(0, 60)}…` : input.question;
	const body = questionText ? deps.translate("mainNotification.askQuestion", { title, question: questionText }) : deps.translate("mainNotification.askPending", { title });
	showAgentToast(deps, { agentId: input.agentId, kind: "ask", body, sessionId: input.sessionId });
	return true;
}
