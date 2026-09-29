import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { replySuggestionsForMessages } = loadTsCommonJs("src/renderer/src/utils/replyActionSuggestions.ts");
const message = (role, text, extra = {}) => ({ id: `${role}-${text}`, agentId: "agent-a", role, text, timestamp: 1, ...extra });
const user = message("user", "修复问题");
const answer = (text = "已完成。", stopReason = "stop") => message("assistant", text, { stopReason });
const diagnostic = (i18nKey) => message("error", "", { meta: { i18nKey } });
const ids = (messages) => Array.from(replySuggestionsForMessages(messages), (suggestion) => suggestion.id);

test("最新回复提供继续，提交意图仍提供提交与提交推送", () => {
	assert.deepEqual(ids([user, answer()]), ["continue"]);
	assert.deepEqual(ids([user, answer("可以提交当前改动。")]), ["commit", "commitPush", "continue"]);
});

test("只看最近一次回复，新问题和新回复不会继承旧轮建议", () => {
	const old = [user, answer("可以提交当前改动。")];
	assert.deepEqual(ids([...old, user]), []);
	assert.deepEqual(ids([...old, user, answer()]), ["continue"]);
	assert.deepEqual(ids([]), []);
});

test("请求失败或自动重试耗尽后只提供重试，空错误回复也能恢复", () => {
	for (const key of ["diagnostic.requestFailed", "diagnostic.requestFailedAfterRetries", "diagnostic.requestFailedUnknown", "diagnostic.requestFailedUnknownAfterRetries", "diagnostic.retryFailed"]) {
		assert.deepEqual(ids([user, diagnostic(key)]), ["retry"], key);
	}
	assert.deepEqual(ids([user, answer("", "error")]), ["retry"]);
	assert.deepEqual(ids([user, answer("本来可以提交", "error")]), ["retry"]);
});

test("截断与主动停止提供继续，不把工具错误当整轮失败", () => {
	assert.deepEqual(ids([user, answer("", "aborted")]), ["continue"]);
	assert.deepEqual(ids([user, answer("尚未完成", "length")]), ["continue"]);
	assert.deepEqual(ids([user, message("tool", "失败", { meta: { status: "error" } })]), []);
});

test("失败后恢复成功不再展示重试，自动重试进行中不展示人工动作", () => {
	assert.deepEqual(ids([user, diagnostic("diagnostic.requestFailed"), answer()]), ["continue"]);
	for (const key of ["diagnostic.retryScheduled", "diagnostic.retryScheduledAfterDelay"]) {
		assert.deepEqual(ids([user, answer("", "error"), diagnostic(key)]), []);
	}
});

test("未完成、工具中间回复与纯思考不冒出建议", () => {
	for (const reason of ["pending", "toolUse"]) assert.deepEqual(ids([user, answer("准备提交", reason)]), []);
	assert.deepEqual(ids([user, answer("<thinking>提交这些内容</thinking>")]), []);
});

test("历史无 stopReason 的回复可用，扩展诊断不冒充请求失败", () => {
	assert.deepEqual(ids([user, message("assistant", "历史回复")]), ["continue"]);
	assert.deepEqual(ids([user, diagnostic("diagnostic.extensionError")]), []);
	assert.deepEqual(ids([user, answer(), diagnostic("diagnostic.extensionError")]), ["continue"]);
});
