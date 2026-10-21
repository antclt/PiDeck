/**
 * 本机文件 IO 的有界等待 + 拖放上传的路径解析（主进程边界，纯逻辑可测）。
 *
 * 为什么需要超时：断开或失联的 UNC / 网络盘路径上 `fs.stat` 既不返回也不报错，JS 层没有任何办法
 * 取消这次系统调用。没有上限时一次拖放就能把界面永久停在「上传中」。
 * 这里只让**调用方**不再等下去；底层那次调用会自行结束，代价可接受。
 *
 * 为什么解析放在同一个文件：两者都是「本机路径能不能用」的判定，分开放会各自演化出不同的边界。
 */

export const REMOTE_UPLOAD_MAX_FILES = 32;

/**
 * 单个本机文件的 `stat`/`readFile` 等待上限。
 *
 * 30s 是「慢但在动」与「已经死了」之间的分界：正常本机文件是这个值的千分之一。
 */
export const LOCAL_FILE_IO_TIMEOUT_MS = 30_000;

/** 一次上传请求里所有本机 IO 的总预算：超过就统按「本机 IO 不可用」失败，不再逐条等。 */
export const LOCAL_IO_BATCH_BUDGET_MS = 60_000;

const MAX_PATH_LENGTH = 4096;
const CONTROL = /[\u0000-\u001f\u007f]/;
const POSIX_ABSOLUTE = /^\//;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const UNC_ABSOLUTE = /^\\\\/;

export const LOCAL_IO_TIMEOUT_CODE = "REMOTE_UPLOAD_LOCAL_IO_TIMEOUT";

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

/**
 * 给一个本机 IO promise 加上等待上限。
 *
 * 超时抛稳定码（`LOCAL_IO_TIMEOUT_CODE`），且**清理定时器**：每条文件都要走一次，漏清就会在长列表
 * 上传里堆出成百上千个活着的 timer。`Promise.race` 会把底层迟到的 rejection 挂到已 settle 的
 * race 上，因此超时之后不会再冒出 unhandledRejection。
 */
export async function withLocalIoTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return work;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(LOCAL_IO_TIMEOUT_CODE)), timeoutMs);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * 批级本机 IO 预算。
 *
 * 单条超时只解决「一个文件卡住」；33 个文件各等 30s 仍然是半小时且没有取消手段。这里在第一条超时
 * 之后就让剩余项直接失败：`stat` 都不返回说明本机路径在整体层面已经不可用，继续逐条试没有信息增量。
 */
export function createLocalIoBudget(totalMs: number = LOCAL_IO_BATCH_BUDGET_MS): {
	remaining: () => number;
	exhausted: () => boolean;
	spend: (ms: number) => void;
} {
	let left = Math.max(0, Math.trunc(totalMs));
	return {
		remaining: () => left,
		exhausted: () => left <= 0,
		spend: (ms: number) => {
			left = Math.max(0, left - Math.max(0, Math.trunc(ms)));
		},
	};
}
