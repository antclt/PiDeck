import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { opOk, opFail, isOpFailure, codeOf, opError, STABLE_CODE_PATTERN } = loadTsCommonJs("src/shared/op.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * 单信封（v5 §2）：`outcome` 决定上层能不能重试，所以它的默认值和传递都不能靠自觉。
 * 这组用例钉的是「默认必须安全」和「拆装一次不丢信息」。
 */
test("opOk / opFail 的形状与默认 outcome", () => {
	assert.deepEqual(plain(opOk(7)), { ok: true, value: 7 });
	// 默认 rejected：确定什么都没发生，重试安全。
	assert.deepEqual(plain(opFail("REMOTE_FILE_CHANGED")), { ok: false, code: "REMOTE_FILE_CHANGED", outcome: "rejected" });
	assert.deepEqual(plain(opFail("REMOTE_FILE_RESULT_UNCONFIRMED", "unknown")), { ok: false, code: "REMOTE_FILE_RESULT_UNCONFIRMED", outcome: "unknown" });

	assert.equal(isOpFailure(opOk(1)), false);
	assert.equal(isOpFailure(opFail("X".padEnd(3, "X"))), true);
});

test("稳定码判据是闭集形状，不认自由文本", () => {
	for (const code of ["REMOTE_FILE_CHANGED", "SSH_HOST_NOT_READY", "OP_X"]) assert.equal(STABLE_CODE_PATTERN.test(code), true, code);
	for (const code of ["", "ab", "remote_file_changed", "REMOTE FILE CHANGED", "A".repeat(65), "REMOTE_FILE_FAILED\n"]) assert.equal(STABLE_CODE_PATTERN.test(code), false, code);
});

test("codeOf 只透传稳定码，其余一律回落调用方给的域常量", () => {
	const fallback = "REMOTE_FILE_COMMAND_FAILED";
	assert.equal(codeOf("REMOTE_FILE_BUSY", fallback), "REMOTE_FILE_BUSY", "字符串稳定码原样透传");
	assert.equal(codeOf(new Error("REMOTE_FILE_TOO_LARGE"), fallback), "REMOTE_FILE_TOO_LARGE", "message 里的稳定码");
	assert.equal(codeOf(Object.assign(new Error("boom"), { code: "REMOTE_FILE_PROTECTED_PATH" }), fallback), "REMOTE_FILE_PROTECTED_PATH", "挂在 code 上的稳定码");
	assert.equal(codeOf(new Error("EACCES: permission denied"), fallback), fallback, "自由文本不外传");
	assert.equal(codeOf("not a code", fallback), fallback);
	assert.equal(codeOf(undefined, fallback), fallback);
	assert.equal(codeOf(null, fallback), fallback);
	assert.equal(codeOf({ message: "REMOTE_OK_LOOKING" }, fallback), fallback, "普通对象不是码来源");
});

test("信封 → 异常：code 与 outcome 一起过边界，不退化", () => {
	const rejected = opError(opFail("REMOTE_FILE_CHANGED"));
	assert.equal(rejected.message, "REMOTE_FILE_CHANGED");
	assert.equal(rejected.code, "REMOTE_FILE_CHANGED");
	assert.equal(rejected.outcome, "rejected");

	const unknown = opError(opFail("REMOTE_FILE_RESULT_UNCONFIRMED", "unknown"));
	assert.equal(unknown.outcome, "unknown", "「可能已经执行」不能被 catch 抹平成普通失败");
	// 再被 codeOf 折回稳定码时，仍然是同一个码。
	assert.equal(codeOf(unknown, "REMOTE_FILE_COMMAND_FAILED"), "REMOTE_FILE_RESULT_UNCONFIRMED");
});
