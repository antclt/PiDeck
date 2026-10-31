import type { PiResourceCode } from "../../../shared/piConfig";
import { piResourceCodeFromError } from "../../../shared/piConfig";
import { t, type TranslationKey } from "../i18n";

/**
 * 资源 list/read 失败时的稳定码 → 用户文案（task-14）。
 *
 * 主进程只回闭集稳定码；直接把它丢进错误区会让用户看到 "PI_RESOURCE_HOST_NOT_FOUND" 这种实现细节。
 * 这里只映射已知码，未知码/普通异常保留原始消息——不为了好看吞掉排障信息。
 */
const CODE_COPY: Record<PiResourceCode, TranslationKey> = {
	PI_RESOURCE_TARGET_INVALID: "config.resourceTarget.errorTargetInvalid",
	PI_RESOURCE_SSH_UNSUPPORTED: "config.resourceTarget.errorSshUnsupported",
	PI_RESOURCE_WRITE_UNSUPPORTED: "config.resourceTarget.errorWriteUnsupported",
	PI_RESOURCE_HOST_NOT_FOUND: "config.resourceTarget.errorHostNotFound",
	PI_RESOURCE_DISTRO_UNAVAILABLE: "config.resourceTarget.errorDistroUnavailable",
	PI_RESOURCE_UNAVAILABLE: "config.resourceTarget.errorUnavailable",
};

function isMappedCode(value: string): value is PiResourceCode {
	return Object.prototype.hasOwnProperty.call(CODE_COPY, value);
}

/** 已知稳定码 → i18n 文案；未知码返回 undefined（调用方保留原文）。 */
export function resourceTargetCodeCopy(code: string | undefined): string | undefined {
	if (code === undefined || !isMappedCode(code)) return undefined;
	return t(CODE_COPY[code]);
}

/** 把资源域 IPC 错误转成可读文案；非资源错误逐字保留原消息。 */
export function resourceTargetErrorMessage(error: unknown): string {
	const fallback = error instanceof Error ? error.message : String(error);
	const copy = resourceTargetCodeCopy(piResourceCodeFromError(error));
	return copy ?? fallback;
}
