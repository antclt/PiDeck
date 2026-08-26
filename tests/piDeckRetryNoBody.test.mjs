import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * pi-deck-retry-no-body 扩展的契约与纯函数测试。
 *
 * 纯函数 isNoBodyError / makeRetryableErrorMessage 以「副本」形式内联在下方，
 * 与 resources/extensions/pi-deck-retry-no-body.ts 保持同步（契约断言保证锚点一致）。
 * 内联副本避免测试文件 import pi 依赖（@earendil-works/pi-coding-agent 是 ESM + 运行时依赖）。
 */

// =========================================================================
// 纯函数副本（与 pi-deck-retry-no-body.ts 保持同步）
// =========================================================================

function isNoBodyError(errorMessage) {
	if (!errorMessage) return false;
	return (
		/\(no body\)/i.test(errorMessage) ||
		/no body\s*$/i.test(errorMessage) ||
		/empty\s+response\s+body/i.test(errorMessage) ||
		/no\s+response\s+body/i.test(errorMessage)
	);
}

function makeRetryableErrorMessage(errorMessage) {
	return `${errorMessage} (connection error)`;
}

// =========================================================================
// pi 重试判定副本（与 pi-ai/dist/utils/retry.js 的 isRetryableAssistantError 一致）
// =========================================================================

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = new RegExp(
	[
		"GoUsageLimitError",
		"FreeUsageLimitError",
		"Monthly usage limit reached",
		"available balance",
		"insufficient_quota",
		"out of budget",
		"quota exceeded",
		"billing",
	].join("|"),
	"i",
);

const RETRYABLE_PROVIDER_ERROR_PATTERN = new RegExp(
	[
		"overloaded",
		"rate.?limit",
		"too many requests",
		"429",
		"500",
		"502",
		"503",
		"504",
		"524",
		"service.?unavailable",
		"server.?error",
		"internal.?error",
		"provider.?returned.?error",
		"network.?error",
		"connection.?error",
		"connection.?refused",
		"connection.?lost",
		"other side closed",
		"fetch failed",
		"getaddrinfo",
		"ENOTFOUND",
		"EAI_AGAIN",
		"upstream.?connect",
		"reset before headers",
		"socket hang up",
		"socket connection was closed",
		"timed? out",
		"timeout",
		"terminated",
		"websocket.?closed",
		"websocket.?error",
	].join("|"),
	"i",
);

function isRetryableAssistantError(message) {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const errorMessage = message.errorMessage;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}

// =========================================================================
// 纯函数行为测试
// =========================================================================

test("isNoBodyError 识别 thetoken 风格空响应", () => {
	assert.equal(isNoBodyError("400 status code (no body)"), true);
	assert.equal(isNoBodyError("503 status code (no body)"), true);
	assert.equal(isNoBodyError("502 status code (no body)"), true);
	assert.equal(isNoBodyError("400 STATUS CODE (NO BODY)"), true);
});

test("isNoBodyError 识别其他空响应变体", () => {
	assert.equal(isNoBodyError("empty response body"), true);
	assert.equal(isNoBodyError("no response body"), true);
	assert.equal(isNoBodyError("request failed no body"), true);
});

test("isNoBodyError 不误伤有 body 的真实错误", () => {
	assert.equal(isNoBodyError("400 Bad Request"), false);
	assert.equal(isNoBodyError("Request failed with status 400"), false);
	assert.equal(isNoBodyError("insufficient_quota"), false);
	assert.equal(isNoBodyError("context length exceeded"), false);
	assert.equal(isNoBodyError(""), false);
	assert.equal(isNoBodyError(undefined), false);
});

test("makeRetryableErrorMessage 追加连接错误说明并保留原文", () => {
	assert.equal(
		makeRetryableErrorMessage("400 status code (no body)"),
		"400 status code (no body) (connection error)",
	);
});

// =========================================================================
// 核心契约：改写让 400 空响应从「不可重试」变为「可重试」（复用 pi 重试机制）
// =========================================================================

test("原始 400 空响应被 pi 判定为不可重试（问题的根源）", () => {
	const original = { stopReason: "error", errorMessage: "400 status code (no body)" };
	assert.equal(isRetryableAssistantError(original), false);
});

test("改写后的 400 空响应被 pi 判定为可重试（复用内置重试）", () => {
	const rewritten = {
		stopReason: "error",
		errorMessage: makeRetryableErrorMessage("400 status code (no body)"),
	};
	assert.equal(isRetryableAssistantError(rewritten), true);
});

test("503 空响应原始即可重试（对照组：网关空响应本应重试）", () => {
	const original = { stopReason: "error", errorMessage: "503 status code (no body)" };
	assert.equal(isRetryableAssistantError(original), true);
});

test("额度耗尽错误不会被误判为重试（改写只对空响应生效）", () => {
	const quota = { stopReason: "error", errorMessage: "insufficient_quota" };
	assert.equal(isRetryableAssistantError(quota), false);
	// 改写函数只追加连接说明，不改额度类文本；即便追加也不应命中额度拦截之外的可重试词
	assert.equal(isNoBodyError("insufficient_quota"), false);
});

// =========================================================================
// 契约：扩展源码结构与注册
// =========================================================================

const extensionSource = readFileSync(
	"resources/extensions/pi-deck-retry-no-body.ts",
	"utf8",
);
const builtInsSource = readFileSync("src/main/extensions/builtInExtensions.ts", "utf8");

test("扩展注册了 message_end 拦截与纯函数", () => {
	assert.match(extensionSource, /pi\.on\("message_end"/);
	assert.match(extensionSource, /export function isNoBodyError/);
	assert.match(extensionSource, /export function makeRetryableErrorMessage/);
	assert.match(extensionSource, /message\.role !== "assistant"/);
	assert.match(extensionSource, /message\.stopReason !== "error"/);
	// 展开保留其余字段，避免 _replaceMessageInPlace 删掉 content/api/usage
	assert.match(extensionSource, /\.\.\.message,\s*\n\s*errorMessage:/);
});

test("扩展已注册进 BUILT_IN_EXTENSIONS 白名单", () => {
	assert.match(builtInsSource, /"pi-deck-retry-no-body\.ts"/);
});
