/**
 * Runtime notify 的进程级去重。
 * 通知会暂存在 session UI 状态里，切换 Tab 后组件可能重新挂载；仅靠组件 ref
 * 会把同一条通知再次当成新事件。按 runtime generation 隔离，新的运行仍可正常提示。
 */
const seenRuntimeNotificationKeys = new Set<string>();
const MAX_SEEN_RUNTIME_NOTIFICATIONS = 200;
const seenBackgroundAskKeys = new Set<string>();

import { formatAskTitle } from "./askUi";

export function getRuntimeNotificationKey(
  sessionId: string,
  runtimeGeneration: number,
  requestId: string,
): string {
  return `${sessionId}:${runtimeGeneration}:${requestId}`;
}

/** 返回 true 表示这条通知是首次消费；超过上限时只保留最近一半。 */
export function rememberRuntimeNotification(key: string): boolean {
  if (seenRuntimeNotificationKeys.has(key)) return false;
  seenRuntimeNotificationKeys.add(key);
  pruneRuntimeNotificationKeys();
  return true;
}

function pruneRuntimeNotificationKeys(): void {
  if (seenRuntimeNotificationKeys.size <= MAX_SEEN_RUNTIME_NOTIFICATIONS) return;
  const retained = Array.from(seenRuntimeNotificationKeys).slice(-100);
  seenRuntimeNotificationKeys.clear();
  for (const retainedKey of retained) seenRuntimeNotificationKeys.add(retainedKey);
}

/** 后台 Ask 在焦点切换期间保持去重，只有请求结束后才显式回收。 */
export function rememberBackgroundAsk(key: string): boolean {
  if (seenBackgroundAskKeys.has(key)) return false;
  seenBackgroundAskKeys.add(key);
  if (seenBackgroundAskKeys.size > MAX_SEEN_RUNTIME_NOTIFICATIONS) {
    const retained = Array.from(seenBackgroundAskKeys).slice(-100);
    seenBackgroundAskKeys.clear();
    for (const retainedKey of retained) seenBackgroundAskKeys.add(retainedKey);
  }
  return true;
}

export function forgetBackgroundAsk(key: string): void {
  seenBackgroundAskKeys.delete(key);
}

export function getRememberedBackgroundAskKeys(): string[] {
  return Array.from(seenBackgroundAskKeys);
}

/** 后台 Ask 通知的展示信息拆分：会话名缺失时回退默认名，问题摘要取请求标题。 */
export type BackgroundAskDisplay = {
  sessionName: string;
  question: string | undefined;
};

/**
 * 拆分「会话名 + 问题摘要」两部分，供 i18n 文案插值：
 * - sessionName：优先会话记录标题，缺失时用 defaultSessionName 兜底；
 * - question：请求自身的标题（即提问内容），无则不提供（调用方选择精简文案）。
 * 纯逻辑，不依赖 React / i18n，便于单测。
 * 标题先过 formatAskTitle：剥掉 Plan/安全确认的内部标记（如安全确认的 JSON 负载），
 * 避免后台通知里出现原始标记/JSON 而不是可读的问题。
 */
export function describeBackgroundAsk(input: {
  sessionName?: string;
  requestTitle?: string;
  defaultSessionName: string;
}): BackgroundAskDisplay {
  const sessionName = input.sessionName?.trim() || input.defaultSessionName;
  const question = input.requestTitle ? formatAskTitle(input.requestTitle) || undefined : undefined;
  return { sessionName, question };
}
