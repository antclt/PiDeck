import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 资源域错误码文案（task-14）：已知稳定码给用户文案，未知码/普通异常保留原文。
 * 不把 PI_RESOURCE_* 实现细节直接丢给用户，也不为了好看吞掉排障信息。
 */

const shared = loadTsCommonJs("src/shared/piConfig.ts");
const copy = loadTsCommonJs("src/renderer/src/config/resourceTargetErrorCopy.ts");
const zh = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts").zhCN;

const MESSAGES = {
	PI_RESOURCE_TARGET_INVALID: "config.resourceTarget.errorTargetInvalid",
	PI_RESOURCE_SSH_UNSUPPORTED: "config.resourceTarget.errorSshUnsupported",
	PI_RESOURCE_WRITE_UNSUPPORTED: "config.resourceTarget.errorWriteUnsupported",
	PI_RESOURCE_HOST_NOT_FOUND: "config.resourceTarget.errorHostNotFound",
	PI_RESOURCE_DISTRO_UNAVAILABLE: "config.resourceTarget.errorDistroUnavailable",
	PI_RESOURCE_UNAVAILABLE: "config.resourceTarget.errorUnavailable",
};

test("每个闭集稳定码都有对应文案，且走 i18n 词典", () => {
	for (const code of Object.values(shared.PI_RESOURCE_CODES)) {
		assert.equal(copy.resourceTargetCodeCopy(code), zh[MESSAGES[code]], code);
		assert.ok(zh[MESSAGES[code]].length > 0);
	}
	assert.equal(copy.resourceTargetCodeCopy("PI_RESOURCE_UNKNOWN_CODE"), undefined);
	assert.equal(copy.resourceTargetCodeCopy(undefined), undefined);
});

test("从 IPC 错误里抓码并转文案；非资源错误逐字保留", () => {
	const error = new Error("Error invoking remote method 'extensions:list': Error: PI_RESOURCE_HOST_NOT_FOUND");
	assert.equal(copy.resourceTargetErrorMessage(error), zh[MESSAGES.PI_RESOURCE_HOST_NOT_FOUND]);
	const plain = new Error("boom");
	assert.equal(copy.resourceTargetErrorMessage(plain), "boom");
	assert.equal(copy.resourceTargetErrorMessage("plain string"), "plain string");
});
