/**
 * 全局通知（#115 U5 收尾）：统一走 sonner 全局 toast。
 * 保留 showNotice(message, duration, kind, title, actions, id) 旧 API，调用点零改动；
 * 单条 toast 由 toast.custom 渲染的自定义卡片 NoticeToastCard 承载
 * （图标 + 标题/正文 + 复制/关闭 + 操作按钮），kind 映射 error/warning/info/neutral 图标。
 *
 * Toaster 未挂载（App 尚未启动 / 渲染树崩溃）时回退到 DOM toast，
 * 保证全局错误处理仍能给用户可见反馈。
 */

import { createElement } from "react";
import { toast } from "sonner";
import { NoticeToastCard, writeClipboardText } from "../components/ui-shadcn/notice-toast";
import { t } from "../i18n";

type NoticeData = {
	message: string;
	duration: number;
	kind?: "info" | "error" | "warning";
};

/** toast 上的可点击按钮（对应 sonner 的 action/cancel）。 */
export type NoticeAction = {
	label: string;
	onClick?: () => void;
};

/** 提示的可选操作按钮：action 为主按钮、cancel 为次按钮（对应 sonner 语义）。 */
export type NoticeActions = {
	action?: NoticeAction;
	cancel?: NoticeAction;
};

let fallbackHost: HTMLDivElement | null = null;
let nextFallbackNoticeId = 0;
/** 自定义卡片 toast 的自增 id：toast.custom 不返回 id，需自行生成并回传（用于 dismissNotice 精准关闭）。 */
let nextSonnerNoticeId = 0;
export type NoticeId = string | number;

// sonner 2.x 在没有可见 toast 时不会渲染任何 DOM（源码里 `if (!filteredToasts.length) return null`），
// 因此不能用 DOM 查询该属性来探测挂载态——那会在每次首个 toast 前都误判为未挂载，
// 导致所有通知永远走黑色 DOM 兜底。挂载状态改由 Toaster 组件挂载时显式回报。
let toasterReady = false;

export function setToasterReady(ready: boolean) {
	toasterReady = ready;
}

/**
 * sonner 的 toast()/toast.custom() 在 Toaster 未挂载（启动早期/渲染树崩溃）时静默丢弃，
 * 此时走 DOM 兜底，保证全局异常仍能给用户可见反馈。
 */
function toasterMounted() {
	return toasterReady;
}

function ensureFallbackHost() {
	if (fallbackHost && document.body.contains(fallbackHost)) return fallbackHost;
	const host = document.createElement("div");
	host.id = "app-notice-fallback-host";
	host.setAttribute("aria-live", "polite");
	// 与 sonner 的 top-right 位置保持一致，并让开标题栏拖拽区，避免兑底与正式 toast 位置跳动
	host.style.cssText = [
		"position:fixed",
		"top:calc(var(--window-drag-height, 0px) + 12px)",
		"right:16px",
		"z-index:2147483000",
		"display:flex",
		"flex-direction:column",
		"align-items:flex-end",
		"gap:8px",
		"pointer-events:none",
		"max-width:min(520px, calc(100vw - 32px))",
		"-webkit-app-region:no-drag"
	].join(";");
	document.body.appendChild(host);
	fallbackHost = host;
	return host;
}

/** 关闭兜底通知并回收宿主节点；持久 Ask 通知只能通过这个按钮结束。 */
function dismissFallbackNotice(item: HTMLDivElement, host: HTMLDivElement) {
	item.remove();
	if (host.childElementCount === 0) {
		host.remove();
		if (fallbackHost === host) fallbackHost = null;
	}
}

/** Toaster 未挂载时的 DOM 兜底 toast，避免全局异常完全静默。 */
function showFallbackNotice(message: string, duration: number, kind: NoticeData["kind"] = "info", title?: string, actions?: NoticeActions, id?: NoticeId): NoticeId | undefined {
	if (typeof document === "undefined") return;
	// 同稳定 id 再弹：先撤掉上一条，避免自动重试连发堆一排。
	if (id !== undefined && fallbackHost) {
		const existing = fallbackHost.querySelector<HTMLDivElement>(`[data-notice-id="${CSS.escape(String(id))}"]`);
		if (existing) dismissFallbackNotice(existing, fallbackHost);
	}
	const noticeId = id !== undefined ? String(id) : `fallback-notice-${++nextFallbackNoticeId}`;
	const host = ensureFallbackHost();
	const item = document.createElement("div");
	// 与 sonner 卡片同一套中性面板样式（走 CSS 变量，主题自动适配）；
	// kind 只保留可访问性语义，不叠加高饱和色竖条，避免 fallback 与正式 toast 视觉分裂。
	item.style.cssText = [
		"position:relative",
		"pointer-events:auto",
		"padding:12px 72px 12px 14px",
		"border-radius:10px",
		"background:var(--color-bg-panel, #ffffff)",
		"color:var(--color-text-primary, #1f2328)",
		"border:1px solid var(--color-border-subtle, rgba(0,0,0,0.08))",
		"box-shadow:var(--shadow-popover, 0 4px 12px rgba(0,0,0,0.12))",
		"font:500 13px/1.4 var(--font-family-base, system-ui,-apple-system,Segoe UI,sans-serif)",
		"word-break:break-word",
	].join(";");
	item.setAttribute("role", kind === "error" ? "alert" : "status");
	item.dataset.noticeId = noticeId;
	if (title) {
		// 有标题时：加粗标题行、正文另起一段，与 sonner 的 title+description 结构对齐
		const titleEl = document.createElement("div");
		titleEl.style.cssText = "font-weight:600;margin-bottom:4px;color:var(--color-text-primary, #1f2328)";
		titleEl.textContent = title;
		item.appendChild(titleEl);
	}
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "×";
	close.setAttribute("aria-label", t("common.close"));
	close.title = t("common.close");
	close.style.cssText = [
		"position:absolute",
		"top:8px",
		"right:8px",
		"width:24px",
		"height:24px",
		"border:0",
		"border-radius:6px",
		"background:transparent",
		"color:var(--color-text-tertiary,#8b8f94)",
		"font:600 18px/1 system-ui,sans-serif",
		"cursor:pointer",
	].join(";");
	close.addEventListener("click", () => dismissFallbackNotice(item, host));
	// 复制按钮：与自定义卡片一致，把「标题 + 正文」一并复制（兑底路径同样可复制）
	const copyBtn = document.createElement("button");
	copyBtn.type = "button";
	copyBtn.textContent = "⧉";
	copyBtn.setAttribute("aria-label", t("common.copy"));
	copyBtn.title = t("common.copy");
	copyBtn.style.cssText = [
		"position:absolute",
		"top:8px",
		"right:34px",
		"width:24px",
		"height:24px",
		"border:0",
		"border-radius:6px",
		"background:transparent",
		"color:var(--color-text-tertiary,#8b8f94)",
		"font:600 14px/1 system-ui,sans-serif",
		"cursor:pointer",
	].join(";");
	copyBtn.addEventListener("click", () => {
		void writeClipboardText(title ? `${title}\n${message}` : message);
	});
	item.appendChild(document.createTextNode(message));
	if (actions) {
		// 按钮区：次按钮（cancel）在左、主按钮（action）在右，点击后先执行回调再收起 toast
		const buttons = document.createElement("div");
		buttons.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:10px";
		for (const key of ["cancel", "action"] as const) {
			const action = actions[key];
			if (!action) continue;
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = action.label;
			button.style.cssText = key === "action"
				? "border:0;border-radius:6px;padding:4px 12px;font:600 12px/1.4 system-ui,sans-serif;background:var(--color-accent,#3b82f6);color:#fff;cursor:pointer"
				: "border:1px solid var(--color-border-subtle,rgba(0,0,0,0.12));border-radius:6px;padding:4px 12px;font:500 12px/1.4 system-ui,sans-serif;background:transparent;color:var(--color-text-secondary,#57606a);cursor:pointer";
			button.addEventListener("click", () => {
				action.onClick?.();
				dismissFallbackNotice(item, host);
			});
			buttons.appendChild(button);
		}
		item.appendChild(buttons);
	}
	item.appendChild(copyBtn);
	item.appendChild(close);
	host.appendChild(item);
	if (Number.isFinite(duration)) {
		window.setTimeout(() => dismissFallbackNotice(item, host), Math.max(1200, duration));
	}
	return noticeId;
}

/**
 * 弹出全局 toast。duration 省略时 info=1500ms、error/warning=3000ms。
 * 粘性提示必须传 Number.POSITIVE_INFINITY：sonner 把 duration: 0 当成立刻关闭，
 * 看起来就像“闪一下就没了”。空 message 会直接丢弃，调用方需保证有正文。
 */
export function showNotice(
	message: string,
	duration?: number,
	kind?: NoticeData["kind"],
	title?: string,
	actions?: NoticeActions,
	/** 稳定 id：同 id 再次弹出时顶掉上一条，避免自动重试等连发场景堆一排 toast。 */
	id?: NoticeId,
): NoticeId | undefined {
	const resolvedDuration = duration ?? (kind === "error" || kind === "warning" ? 3000 : 1500);
	const text = String(message ?? "").trim();
	if (!text) return;
	if (!toasterMounted()) {
		return showFallbackNotice(text, resolvedDuration, kind, title, actions, id);
	}
	// 统一走自定义卡片（toast.custom）：一张卡片承载「图标 + 标题/正文 + 复制/关闭 + 操作按钮」，
	// 不再依赖 sonner 内置 title/description/action 布局——后者把按钮塞在正文右侧同一行，
	// 长文案 + 双按钮时会挤成一团（历史 issue）。卡片内容见 NoticeToastCard。
	// 有标题时标题为主文案、正文退为描述；无标题（含空字符串）时整段作为主文案。
	const noticeId = id !== undefined ? id : `notice-${++nextSonnerNoticeId}`;
	const cardTitle = title ? title : text;
	const cardDescription = title ? text : undefined;
	toast.custom(
		(toastId) =>
			createElement(NoticeToastCard, {
				toastId,
				kind: kind ?? "neutral",
				title: cardTitle,
				description: cardDescription,
				actions,
			}),
		{ id: noticeId, duration: resolvedDuration },
	);
	return noticeId;
}

/** 精准关闭由 showNotice 返回的通知，不影响其他全局 toast。 */
export function dismissNotice(id: NoticeId | undefined) {
	if (id === undefined) return;
	if (toasterMounted()) {
		toast.dismiss(id);
		return;
	}
	const item = fallbackHost?.querySelector<HTMLDivElement>(`[data-notice-id="${CSS.escape(String(id))}"]`);
	if (item && fallbackHost) dismissFallbackNotice(item, fallbackHost);
}
