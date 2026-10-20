/**
 * 拖放上传的本机路径解析（纯函数，主进程边界）。
 *
 * 单独成模块的理由：这段校验是「渲染层能断言本机路径」这条信任边界的唯一门，用真实输入行为测它
 * 比在 IPC 文件里对源码写正则可靠得多（后者连「函数根本没被调用」都测不出来）。
 *
 * 规则：只接受**绝对**路径（POSIX `/`、Windows 盘符、UNC `\\`），拒空、控制字符、超长；
 * 一次最多 32 条；任一条不合法就整批拒（fail-closed），不跳过——部分跳过的结果是用户以为传了
 * 一堆、实际只传了几个。
 */

export const REMOTE_UPLOAD_MAX_FILES = 32;
const MAX_PATH_LENGTH = 4096;
const CONTROL = /[\u0000-\u001f\u007f]/;
const POSIX_ABSOLUTE = /^\//;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const UNC_ABSOLUTE = /^\\\\/;

/** 只校验形状，不改写路径：首尾空格在 POSIX 里是合法文件名的一部分。 */
function isAbsoluteLocalPath(value: string): boolean {
	return POSIX_ABSOLUTE.test(value) || WINDOWS_ABSOLUTE.test(value) || UNC_ABSOLUTE.test(value);
}

export type LocalUploadPathsResult = { ok: true; paths: string[] } | { ok: false };

export function parseLocalUploadPaths(value: unknown): LocalUploadPathsResult {
	if (!Array.isArray(value) || value.length === 0 || value.length > REMOTE_UPLOAD_MAX_FILES) return { ok: false };
	const paths: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return { ok: false };
		if (item.length === 0 || item.length > MAX_PATH_LENGTH || CONTROL.test(item)) return { ok: false };
		if (!isAbsoluteLocalPath(item)) return { ok: false };
		paths.push(item);
	}
	return { ok: true, paths };
}
