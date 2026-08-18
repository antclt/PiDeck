import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const timeline = readFileSync(
	"src/renderer/src/components/session/SessionMessageTimeline.tsx",
	"utf8",
);
const notice = readFileSync(
	"src/renderer/src/components/session/timelineFailureNotice.ts",
	"utf8",
);

const i18n = loadTsCommonJs("src/renderer/src/i18n.ts");
const {
	FLOATING_FAILURE_KEYS,
	composeFailureNotice,
	isExtensionErrorMessage,
	isFailureNoticeMessage,
	isFloatingFailureMessage,
} = loadTsCommonJs("src/renderer/src/components/session/timelineFailureNotice.ts", {
	// 与 composeFailureNotice 共用同一份 i18n 模块，否则 setI18nLocale 改不到 toast 文案。
	stubs: { "../../i18n": i18n },
});
const { setI18nLocale } = i18n;

function message(i18nKey, extras = {}) {
	return {
		id: extras.id ?? "msg-1",
		agentId: extras.agentId ?? "agent-1",
		role: extras.role ?? "error",
		text: extras.text ?? "fallback",
		timestamp: 1,
		meta: {
			i18nKey,
			...(extras.debugDetails ? { debugDetails: extras.debugDetails } : {}),
			...(extras.i18nParams ? { i18nParams: extras.i18nParams } : {}),
		},
	};
}

test("floating failure keys: covers retry + failure diagnostics, excludes start/runtime/extension cards", () => {
	const keys = [
		"diagnostic.requestFailed",
		"diagnostic.requestFailedAfterRetries",
		"diagnostic.requestFailedUnknown",
		"diagnostic.requestFailedUnknownAfterRetries",
		"diagnostic.agentStopped",
		"diagnostic.promptRejected",
		"diagnostic.promptDeliveryUnknown",
		"diagnostic.commandFailed",
		"diagnostic.commandDeliveryUnknown",
		"diagnostic.commandCancelled",
		"diagnostic.processReconnectFailed",
		"diagnostic.historyLoadFailed",
		"diagnostic.retryScheduled",
		"diagnostic.retryScheduledAfterDelay",
		"diagnostic.retrySucceeded",
		"diagnostic.retryFailed",
	];
	for (const key of keys) {
		assert.equal(FLOATING_FAILURE_KEYS.has(key), true, `missing ${key} in FLOATING_FAILURE_KEYS`);
	}
	// 扩展错误要保留诊断卡（带 debugDetails），不能再进浮动 Set
	assert.equal(FLOATING_FAILURE_KEYS.has("diagnostic.extensionError"), false);
	assert.equal(isFloatingFailureMessage(message("diagnostic.extensionError")), false);
	assert.equal(isExtensionErrorMessage(message("diagnostic.extensionError")), true);
	assert.equal(isFailureNoticeMessage(message("diagnostic.extensionError")), true);
	assert.equal(isFailureNoticeMessage(message("diagnostic.requestFailed")), true);
	assert.equal(isFailureNoticeMessage(message("diagnostic.agentStartFailed")), false);
	assert.doesNotMatch(notice, /"diagnostic\.agentStartFailed"/);
	assert.doesNotMatch(notice, /"diagnostic\.runtimeError"/);
});

test("timeline render: failure/retry messages return null, extension errors keep the card", () => {
	assert.match(timeline, /if \(message\.role === "error"\) \{\s*\/\/ 失败\/重试类提示已转 toast/s);
	assert.match(timeline, /if \(isFloatingFailureMessage\(message\)\) return null;/);
	assert.match(timeline, /\/\/ 自动重试状态（retryScheduled\/retrySucceeded\/retryFailed 等）\s*\/\/ 属于「重试提示」/s);
	assert.match(timeline, /composeFailureNotice\(message\)/);
	assert.match(timeline, /isFailureNoticeMessage/);
	assert.match(timeline, /from "\.\/timelineFailureNotice"/);
});

test("toast effect: baseline on load completion, only new failures toast", () => {
	assert.match(timeline, /const failureBaselineRef = useRef<string\[\] \| null>\(null\);/);
	assert.match(timeline, /if \(isConversationLoading\) \{\s*failureBaselineRef\.current = null;/s);
	assert.match(timeline, /failureBaselineRef\.current = floating\.map\(\(message\) => message\.id\);/);
	assert.match(timeline, /toastedFailureIds\.has\(message\.id\)/);
	assert.match(timeline, /markFailureToastShown\(message\.id\);/);
	assert.match(timeline, /showFailureToast\(message\);/);
	assert.match(timeline, /lastRetryToastRef/);
	assert.match(notice, /session-retry:\$\{message\.agentId\}/);
	assert.match(timeline, /const toastedFailureIds = new Set<string>\(\);/);
});

test("composeFailureNotice: retry stays info, request failure stays session-error title", () => {
	setI18nLocale("zh-CN");
	const retry = composeFailureNotice(message("diagnostic.retryScheduled", {
		text: "正在自动重试 2",
		i18nParams: { count: 2 },
	}));
	assert.equal(retry.kind, "info");
	assert.equal(retry.duration, 2200);
	assert.equal(retry.id, "session-retry:agent-1");
	assert.equal(retry.title, "自动重试");

	const failed = composeFailureNotice(message("diagnostic.requestFailed", {
		text: "请求失败。",
		debugDetails: "HTTP 429",
	}));
	assert.equal(failed.kind, "error");
	assert.equal(failed.title, "会话失败");
	assert.match(failed.body, /请求失败/);
	assert.match(failed.body, /HTTP 429/);
});

test("composeFailureNotice: extension error uses its own title and shows debugDetails", () => {
	setI18nLocale("zh-CN");
	const noticeContent = composeFailureNotice(message("diagnostic.extensionError", {
		text: "扩展执行错误。",
		debugDetails: "pi-deck-todo: Cannot read properties of undefined",
	}));
	assert.equal(noticeContent.title, "扩展执行错误");
	assert.equal(noticeContent.kind, "error");
	assert.equal(noticeContent.body, "pi-deck-todo: Cannot read properties of undefined");
	assert.notEqual(noticeContent.title, "会话失败");
	assert.equal(noticeContent.id, undefined);

	const clipped = composeFailureNotice(message("diagnostic.extensionError", {
		text: "扩展执行错误。",
		debugDetails: "x".repeat(400),
	}));
	assert.equal(clipped.body.endsWith("…"), true);
	assert.ok(clipped.body.length < 400);
});

test("failure toast i18n keys exist in zh-CN and en-US", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	assert.match(zh, /"diagnostic\.failureToastTitle": "会话失败"/);
	assert.match(zh, /"diagnostic\.extensionErrorToastTitle": "扩展执行错误"/);
	assert.match(zh, /"diagnostic\.retryToastTitle": "自动重试"/);
	assert.match(en, /"diagnostic\.failureToastTitle": "Session error"/);
	assert.match(en, /"diagnostic\.extensionErrorToastTitle": "Extension error"/);
	assert.match(en, /"diagnostic\.retryToastTitle": "Auto retry"/);
});
