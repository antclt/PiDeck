/**
 * 主进程侧的远端文件名搜索读取器（`fs.searchNames`，F2）。
 *
 * 与 `RemoteWorkspaceReader` 同一套纪律，理由相同：helper 的回答是**远端数据**。调用方要拿结果的
 * `path` 去显示、拆段、跳转，所以每个值都必须先被证明符合 `RemoteHelperContract` 才允许通过。
 * 本模块不 spawn 进程、不碰本地文件系统：一个窄 port（一个 `request`）承载帧，因此同一套逻辑可以跑在
 * 真实连接、录制的 transcript 或单测替身上。
 *
 * 不变量（全部 fail-closed）：
 * - 每个结果都带稳定码，且复用 reader 的既有词汇（`PROTOCOL_INVALID`、`RESULT_TOO_LARGE`、
 *   `QUERY_INVALID`、`REMOTE_WORKSPACE_REQUEST_FAILED`）。远端的 `message`、errno 与路径绝不外传：
 *   只有本身已经是稳定码的失败才被转述。
 * - 结果严格逐字段校验并**重建**：缺字段、多字段、类型错一律 `PROTOCOL_INVALID`；`entries` 非数组、
 *   `truncated` 非布尔更是如此。
 * - entry 的 `path` 必须是合法的**相对 POSIX 路径**（非绝对、无 `.`/`..` 段、无空段、无尾斜杠、
 *   无控制字节、无反斜杠、无盘符前缀），`name` 必须是单段名且与 `path` 末段一致——结果会被拆成路径段，
 *   一个不规矩的值就是一条错路。
 * - 上限在本地**再复核一次**：匹配数超过契约上限是 `RESULT_TOO_LARGE`（有界结果被拒绝，绝不悄悄截断），
 *   `scanned` 越过契约上限或小于匹配数是对端违约（`PROTOCOL_INVALID`）。
 * - `truncated` **如实透传**：本模块绝不自行推导、绝不吞掉，调用方必须能区分「没有更多匹配」与
 *   「扫描被上限切断」。
 *
 * query 来自渲染层，因此在这里（而不是更远的地方）按契约重新校验：长度 1..128、无控制字节，
 * 非法即 `QUERY_INVALID`，一个字节都不发出去。
 */

import {
	REMOTE_HELPER_MAX_CONTENT_MATCHES,
	REMOTE_HELPER_MAX_CONTENT_SCANNED_BYTES,
	REMOTE_HELPER_MAX_CONTENT_SCANNED_FILES,
	REMOTE_HELPER_MAX_CONTENT_SNIPPET_LENGTH,
	REMOTE_HELPER_MAX_HOST_ID_LENGTH,
	REMOTE_HELPER_MAX_PATH_LENGTH,
	REMOTE_HELPER_MAX_SEARCH_MATCHES,
	REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH,
	REMOTE_HELPER_MAX_SEARCH_SCANNED,
	REMOTE_HELPER_METHOD_FS_SEARCH_CONTENT,
	REMOTE_HELPER_METHOD_FS_SEARCH_NAMES,
	type RemoteHelperPathKind,
	type RemoteHelperSearchContentMatch,
	type RemoteHelperSearchContentReason,
	type RemoteHelperSearchEntry,
} from "./RemoteHelperContract";
import { REMOTE_WORKSPACE_READER_CODES, RemoteWorkspaceError } from "./RemoteWorkspaceReader";

/** 本 reader 用到的稳定码；除 `QUERY_INVALID`（query 专用）外全部沿用既有词汇。 */
export const REMOTE_SEARCH_READER_CODES = {
	/** query 缺失/空/超长/含控制字节：helper 侧是 `QUERY_INVALID`，这里在发帧前就拒。 */
	queryInvalid: "QUERY_INVALID",
	/** 传输失败但自己不带稳定码；自由文本被折叠，绝不转述。 */
	requestFailed: REMOTE_WORKSPACE_READER_CODES.requestFailed,
	/** 装配时没给可用的 port（与其它远端模块一致，构造期抛出）。 */
	optionsInvalid: REMOTE_WORKSPACE_READER_CODES.optionsInvalid,
} as const;

/**
 * 本模块复核用的匹配上限（契约值的再导出）：调用方与测试不必各自再抄一份 512，
 * 也不会出现「契约改了、本地复核没改」的漂移。
 */
export const REMOTE_SEARCH_MAX_MATCHES = REMOTE_HELPER_MAX_SEARCH_MATCHES;

/** 与 `RemoteWorkspacePortRequestOptions` 同形，便于复用同一个 session 适配器（`cancel` 被忽略）。 */
export type RemoteSearchPortRequestOptions = {
	timeoutMs?: number;
	onRequestId?: (requestId: string) => void;
};

/**
 * 这个 reader 需要的全部依赖：一个发起 helper 请求的入口。
 *
 * 有意只开这一条缝——搜索是一问一答的单帧调用，没有分块也没有 commit point，因此不需要 `cancel`；
 * 取消在调用方（渲染层用代次闸门作废迟到结果，主进程的串根边界由 IPC 层负责）。
 */
export type RemoteSearchPort = {
	request: (hostId: string, method: string, params?: unknown, options?: RemoteSearchPortRequestOptions) => Promise<unknown>;
	/**
	 * Withdraw a running request by the id `onRequestId` reported; optional because a transport that cannot
	 * cancel simply lets a bounded walk finish. Content search uses it to turn an AbortSignal into the
	 * helper's own REQUEST_CANCELLED instead of waiting out the time budget.
	 */
	cancel?: (hostId: string, requestId: string, options?: { timeoutMs?: number }) => Promise<unknown>;
};

/** 单次搜索的可选参数。 */
export type RemoteSearchCallOptions = {
	/** 本地期限，转发给传输层；不合理的值被丢弃（传输层默认值比一个没人能兑现的期限更可信）。 */
	timeoutMs?: number;
	/** 匹配上限；缺省交给 helper 的默认值，给出时本地先 clamp 到契约上限。 */
	maxMatches?: number;
};

/** 一条通过的匹配：`path` 已证明是相对 root 的 POSIX 路径，`name` 是它的单段末名。 */
export type RemoteSearchEntry = RemoteHelperSearchEntry;

/** 一次通过的搜索：重建后的条目、真实扫描数，以及如实透传的 `truncated`。 */
export type RemoteSearchResult = {
	entries: RemoteSearchEntry[];
	scanned: number;
	truncated: boolean;
};

/** 一条重建后的内容命中：行号 1 起、列号 0 起、预览是同一行的有界切片（绝不回传文件正文）。 */
export type RemoteSearchContentMatch = RemoteHelperSearchContentMatch;

/** 一次通过的内容搜索：计数描述**真实做过的工作**；`reason` 只在 `truncated` 时出现。 */
export type RemoteSearchContentResult = {
	matches: RemoteSearchContentMatch[];
	matchedFiles: number;
	scannedFiles: number;
	scannedBytes: number;
	truncated: boolean;
	reason?: RemoteHelperSearchContentReason;
};

/** 内容搜索调用参数：除搜索通用项外，`signal` 取消会转成一次 helper cancel（不等待时限）。 */
export type RemoteSearchContentCallOptions = RemoteSearchCallOptions & { signal?: AbortSignal };

/** 脱敏诊断：闭集身份 + 一个稳定码，绝不携带内容。 */
export type RemoteSearchReaderDiagnostic = {
	hostId: string;
	method: string;
	code: string;
};

export type RemoteSearchReaderOptions = {
	port: RemoteSearchPort;
	/** 观测旁路：坏观察者不能弄坏一次调用，且只上报稳定码。 */
	onDiagnostic?: (entry: RemoteSearchReaderDiagnostic) => void;
};

/** 只读的远端文件名搜索；每个失败都带稳定码。 */
export type RemoteSearchReader = {
	/**
	 * 在 `path`（相对 root 的 POSIX 路径，`"."` 表示根）下按名称子串搜索 `query`。
	 * 超过 512 条匹配被拒绝而不是截断；真实截断由 `truncated` 如实表达。
	 */
	search(hostId: string, path: string, query: string, options?: RemoteSearchCallOptions): Promise<RemoteSearchResult>;
	/**
	 * 在 `path` 下按行做有界内容搜索。匹配数超过契约上限是 `RESULT_TOO_LARGE`（helper 自己不会超过，
	 * 对端越界即违约）；真正的上限截断由 `truncated` 与 `reason` 如实表达。`signal` 取消会转成 helper
	 * 的 cancel 请求，因此取消是一次正常结算，而不是等超时。
	 */
	searchContent(hostId: string, path: string, query: string, options?: RemoteSearchContentCallOptions): Promise<RemoteSearchContentResult>;
};

/** 一个码就是一个码，绝不是自由文本。 */
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
/** helper 拒绝路径/query 里的控制字节，这里也不把它们当成词汇的一部分。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** 本地生成的、重试可能解决的失败，与 control client 的重试集合一致。 */
const RETRYABLE_CODES = new Set<string>(["REQUEST_TIMEOUT", "REMOTE_CONNECTION_LOST"]);
/** 契约字段集：精确匹配，多一个未知字段与少一个同样致命。 */
const RESULT_FIELDS = ["entries", "scanned", "truncated"] as const;
const ENTRY_FIELDS = ["path", "name", "kind"] as const;
const ENTRY_FILE_FIELDS = ["path", "name", "kind", "bytes"] as const;
/** 内容搜索契约字段集：结果与命中都精确匹配，`reason` 是唯一可选字段。 */
const CONTENT_RESULT_FIELDS = ["matches", "matchedFiles", "scannedFiles", "scannedBytes", "truncated"] as const;
const CONTENT_RESULT_FIELDS_WITH_REASON = [...CONTENT_RESULT_FIELDS, "reason"] as const;
const CONTENT_MATCH_FIELDS = ["path", "name", "line", "column", "snippet"] as const;
/** 契约的 reason 闭集；一个没见过的值就是对端违约，不转述。 */
const CONTENT_REASONS: ReadonlySet<string> = new Set(["matches", "files", "bytes", "time", "depth", "file-size"]);
/** 预览里不允许出现换行/NUL 等控制字节（制表符除外）：它不是文件正文的通道。 */
const SNIPPET_CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;
/** 盘符形态的首段（`C:`）：相对 POSIX 路径里没有它，出现即拒绝。 */
const DRIVE_PREFIX = /^[A-Za-z]:$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `Array.isArray` 会把元素窄化成 `any[]`；这里保持元素是 `unknown` 直到逐个校验。 */
function isUnknownArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}

/** 精确字段集：缺字段与多字段都是协议违例。 */
function hasExactFields(record: Record<string, unknown>, fields: readonly string[]): boolean {
	const keys = Object.keys(record);
	return keys.length === fields.length && fields.every((field) => Object.hasOwn(record, field));
}

/** 计数：契约只携带安全非负整数。 */
function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 取消判据放进函数：调用点不因控制流收窄而漏掉「请求期间被 abort」的可能性。 */
function isAborted(signal: AbortSignal | undefined): boolean {
	return signal !== undefined && signal.aborted === true;
}

function readPathKind(value: unknown): RemoteHelperPathKind | undefined {
	if (value === "file" || value === "directory" || value === "other") return value;
	return undefined;
}

/** host id 要在发帧前就能当诊断身份与传输键用；非法值**不回显**（调用方搞错的可能是路径或凭据）。 */
function readHostId(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > REMOTE_HELPER_MAX_HOST_ID_LENGTH || CONTROL_CHARS.test(value)) return undefined;
	return value;
}

/**
 * 请求侧路径只做**协议形状**校验（非空、在契约上限内、无控制字节），容器边界由 helper 自己的 root
 * 决定——本地复刻一份只会得到第二份迟早漂移的意见，何况 reader 根本不知道 root。
 */
function readRequestPath(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > REMOTE_HELPER_MAX_PATH_LENGTH || CONTROL_CHARS.test(value)) return undefined;
	return value;
}

/** query 的契约域：1..128 个字符、无控制字节。渲染层来的值一律在这里重新校验。 */
function readQuery(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH || CONTROL_CHARS.test(value)) return undefined;
	return value;
}

/** 目录条目名是一个路径段；空、点段、分隔符、控制字节都不是。 */
function isEntryName(value: string): boolean {
	if (value.length === 0 || value === "." || value === "..") return false;
	if (value.includes("/") || value.includes("\\")) return false;
	return !CONTROL_CHARS.test(value);
}

/**
 * 结果里的 `path` 必须是合法的相对 POSIX 路径：非空、在长度上限内、无控制字节、无反斜杠、
 * 非绝对、无 `.`/`..` 段、无空段（因此也没有前导/尾随斜杠）、无盘符前缀。
 *
 * 有意**不**拒绝 `%2f`/`%2e` 这类字面量：helper 只会把真实名字拼进来，从不解码，调用方也不解码，
 * 拒绝它就是拒绝一个合法文件名。逃逸风险来自 `..` 与绝对路径，那两条已经堵死。
 */
function isRelativePosixPath(value: string): boolean {
	if (value.length === 0 || value.length > REMOTE_HELPER_MAX_PATH_LENGTH) return false;
	if (CONTROL_CHARS.test(value) || value.includes("\\")) return false;
	if (value.startsWith("/")) return false;
	const segments = value.split("/");
	for (const segment of segments) {
		if (segment.length === 0 || segment === "." || segment === "..") return false;
	}
	const first = segments[0];
	return first === undefined || !DRIVE_PREFIX.test(first);
}

function readSearchEntry(value: unknown): RemoteSearchEntry | undefined {
	if (!isRecord(value)) return undefined;
	const path = value.path;
	if (typeof path !== "string" || !isRelativePosixPath(path)) return undefined;
	const name = value.name;
	if (typeof name !== "string" || !isEntryName(name)) return undefined;
	// `name` 与 `path` 必须讲同一个条目：调用方按 path 拆段跳转，两者不一致就是一条错路。
	if (path !== name && !path.endsWith("/" + name)) return undefined;
	const kind = readPathKind(value.kind);
	if (kind === undefined) return undefined;
	// 与 `fs.list` 同一规矩：大小只随普通文件来（symlink 是 other，其目标大小绝不冒充自己的）。
	if (kind === "file") {
		if (!hasExactFields(value, ENTRY_FILE_FIELDS)) return undefined;
		const bytes = value.bytes;
		if (!isCount(bytes)) return undefined;
		return { path, name, kind, bytes };
	}
	if (!hasExactFields(value, ENTRY_FIELDS)) return undefined;
	return { path, name, kind };
}

/**
 * 归一化传输失败：稳定码原样转述（连接层把码放在 `Error.message` 里，这是它的既有约定），
 * 其余一律折叠成本 reader 的通用码，所以内嵌路径/命令行/errno 的文本永远不会外传。
 */
function readTransportFailure(error: unknown): { readonly code: string; readonly retryable: boolean } {
	if (isRecord(error)) {
		const code = error.code;
		if (typeof code === "string" && STABLE_CODE.test(code)) return { code, retryable: typeof error.retryable === "boolean" ? error.retryable : RETRYABLE_CODES.has(code) };
		const message = error.message;
		if (typeof message === "string" && STABLE_CODE.test(message)) return { code: message, retryable: RETRYABLE_CODES.has(message) };
	}
	return { code: REMOTE_SEARCH_READER_CODES.requestFailed, retryable: false };
}

/** 注入依赖的结构校验：JS 调用方不能在没有传输层的情况下装配 reader。 */
function isRemoteSearchPort(value: unknown): value is RemoteSearchPort {
	return isRecord(value) && typeof value.request === "function";
}

function isRemoteSearchReaderOptions(value: unknown): value is RemoteSearchReaderOptions {
	if (!isRecord(value)) return false;
	if (!isRemoteSearchPort(value.port)) return false;
	const onDiagnostic = value.onDiagnostic;
	return onDiagnostic === undefined || typeof onDiagnostic === "function";
}

type CallOptionsRead = { readonly ok: true; readonly timeoutMs: number | undefined; readonly maxMatches: number | undefined } | { readonly ok: false };

/**
 * 读调用参数：荒唐的期限被丢弃（传输层默认值比一个没人能兑现的期限更可信），但不可能成立的 maxMatches
 * 是调用方的错而不是「取默认值」——悄悄放大成 512 会让一次错误请求看起来成功。
 */
function readCallOptions(value: unknown): CallOptionsRead {
	if (value === undefined) return { ok: true, timeoutMs: undefined, maxMatches: undefined };
	if (!isRecord(value)) return { ok: false };
	const timeout = value.timeoutMs;
	const timeoutMs = typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : undefined;
	const rawMax = value.maxMatches;
	if (rawMax === undefined) return { ok: true, timeoutMs, maxMatches: undefined };
	if (typeof rawMax !== "number" || !Number.isSafeInteger(rawMax) || rawMax < 1) return { ok: false };
	return { ok: true, timeoutMs, maxMatches: Math.min(rawMax, REMOTE_HELPER_MAX_SEARCH_MATCHES) };
}

/** 内容搜索的 maxMatches 钳到内容上限（不是名字搜索的 512）：悄悄放大成更大的值会让请求看起来成功。 */
function readContentCallOptions(value: unknown): CallOptionsRead {
	if (value === undefined) return { ok: true, timeoutMs: undefined, maxMatches: undefined };
	if (!isRecord(value)) return { ok: false };
	const timeout = value.timeoutMs;
	const timeoutMs = typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : undefined;
	const rawMax = value.maxMatches;
	if (rawMax === undefined) return { ok: true, timeoutMs, maxMatches: undefined };
	if (typeof rawMax !== "number" || !Number.isSafeInteger(rawMax) || rawMax < 1) return { ok: false };
	return { ok: true, timeoutMs, maxMatches: Math.min(rawMax, REMOTE_HELPER_MAX_CONTENT_MATCHES) };
}

export function createRemoteSearchReader(options: RemoteSearchReaderOptions): RemoteSearchReader {
	if (!isRemoteSearchReaderOptions(options)) throw new RemoteWorkspaceError(REMOTE_SEARCH_READER_CODES.optionsInvalid, false);
	const { request, cancel } = options.port;
	const onDiagnostic = options.onDiagnostic;

	/** 脱敏、尽力而为的可观测性：坏观察者不能弄坏一次调用或一次结算。 */
	function diagnose(hostId: string, method: string, code: string): void {
		if (onDiagnostic === undefined) return;
		// 稳定码不变量在这里被强制，而不是仅仅写进注释：未来新增调用点也不能把自由文本推进诊断流。
		if (!STABLE_CODE.test(code)) return;
		try {
			onDiagnostic({ hostId, method, code });
		} catch {
			// 观测是旁路；坏观察者被吞掉，协议照常可用。
		}
	}

	/** 每次拒绝恰好上报一次，且与调用方收到的码完全相同。 */
	function refuse(hostId: string, code: string, retryable = false): RemoteWorkspaceError {
		diagnose(hostId, REMOTE_HELPER_METHOD_FS_SEARCH_NAMES, code);
		return new RemoteWorkspaceError(code, retryable);
	}

	/**
	 * 严格校验并重建一次搜索结果。
	 *
	 * 匹配数超过契约上限是 `RESULT_TOO_LARGE`：与 `fs.list` 的选择一致——有界结果被**拒绝**，
	 * 而不是被悄悄截成一屏「看起来完整」的内容。真正的截断由 `truncated` 表达，且如实透传。
	 */
	function readSearchResult(hostId: string, value: unknown): RemoteSearchResult {
		if (!isRecord(value) || !hasExactFields(value, RESULT_FIELDS)) throw refuse(hostId, "PROTOCOL_INVALID");
		const rawEntries = value.entries;
		if (!isUnknownArray(rawEntries)) throw refuse(hostId, "PROTOCOL_INVALID");
		if (rawEntries.length > REMOTE_HELPER_MAX_SEARCH_MATCHES) throw refuse(hostId, "RESULT_TOO_LARGE");
		const entries: RemoteSearchEntry[] = [];
		for (const raw of rawEntries) {
			const entry = readSearchEntry(raw);
			if (entry === undefined) throw refuse(hostId, "PROTOCOL_INVALID");
			entries.push(entry);
		}
		const scanned = value.scanned;
		// 越过契约上限不是「本地策略拒绝」而是对端违约：helper 自己必须在 20000 处停下。
		if (!isCount(scanned) || scanned > REMOTE_HELPER_MAX_SEARCH_SCANNED) throw refuse(hostId, "PROTOCOL_INVALID");
		// 每个匹配项都必须是它自己那次被访问过的条目，因此 scanned 不可能小于匹配数。
		if (scanned < entries.length) throw refuse(hostId, "PROTOCOL_INVALID");
		const truncated = value.truncated;
		if (typeof truncated !== "boolean") throw refuse(hostId, "PROTOCOL_INVALID");
		return { entries, scanned, truncated };
	}

	/** 一条内容命中：路径规则与 `fs.searchNames` 完全一致，行/列/预览再各自有界。 */
	function readContentMatch(value: unknown): RemoteSearchContentMatch | undefined {
		if (!isRecord(value) || !hasExactFields(value, CONTENT_MATCH_FIELDS)) return undefined;
		const path = value.path;
		if (typeof path !== "string" || !isRelativePosixPath(path)) return undefined;
		const name = value.name;
		if (typeof name !== "string" || !isEntryName(name)) return undefined;
		if (path !== name && !path.endsWith("/" + name)) return undefined;
		const line = value.line;
		if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) return undefined;
		const column = value.column;
		if (typeof column !== "number" || !Number.isSafeInteger(column) || column < 0) return undefined;
		const snippet = value.snippet;
		if (typeof snippet !== "string" || snippet.length > REMOTE_HELPER_MAX_CONTENT_SNIPPET_LENGTH || SNIPPET_CONTROL.test(snippet)) return undefined;
		return { path, name, line, column, snippet };
	}

	/**
	 * 严格校验并重建一次内容搜索结果。
	 *
	 * 计数是「真实工作」的声明，因此交叉约束也在这里强制：匹配文件数不可能超过命中数或已读文件数，
	 * 三项计数越过契约上限都是对端违约（`PROTOCOL_INVALID`），而命中数组越界与 `fs.list` 同一选择——
	 * 有界结果被**拒绝**而不是悄悄截断。真正的截断只由 `truncated`/`reason` 表达。
	 */
	function readContentResult(hostId: string, value: unknown): RemoteSearchContentResult {
		if (!isRecord(value)) throw refuse(hostId, "PROTOCOL_INVALID");
		const withReason = hasExactFields(value, CONTENT_RESULT_FIELDS_WITH_REASON);
		if (!withReason && !hasExactFields(value, CONTENT_RESULT_FIELDS)) throw refuse(hostId, "PROTOCOL_INVALID");
		const rawMatches = value.matches;
		if (!isUnknownArray(rawMatches)) throw refuse(hostId, "PROTOCOL_INVALID");
		if (rawMatches.length > REMOTE_HELPER_MAX_CONTENT_MATCHES) throw refuse(hostId, "RESULT_TOO_LARGE");
		const matches: RemoteSearchContentMatch[] = [];
		for (const raw of rawMatches) {
			const match = readContentMatch(raw);
			if (match === undefined) throw refuse(hostId, "PROTOCOL_INVALID");
			matches.push(match);
		}
		const matchedFiles = value.matchedFiles;
		const scannedFiles = value.scannedFiles;
		const scannedBytes = value.scannedBytes;
		if (!isCount(matchedFiles) || !isCount(scannedFiles) || !isCount(scannedBytes)) throw refuse(hostId, "PROTOCOL_INVALID");
		if (matchedFiles > matches.length || matchedFiles > scannedFiles) throw refuse(hostId, "PROTOCOL_INVALID");
		if (scannedFiles > REMOTE_HELPER_MAX_CONTENT_SCANNED_FILES) throw refuse(hostId, "PROTOCOL_INVALID");
		if (scannedBytes > REMOTE_HELPER_MAX_CONTENT_SCANNED_BYTES) throw refuse(hostId, "PROTOCOL_INVALID");
		const truncated = value.truncated;
		if (typeof truncated !== "boolean") throw refuse(hostId, "PROTOCOL_INVALID");
		const reason = value.reason;
		if (truncated) {
			if (typeof reason !== "string" || !CONTENT_REASONS.has(reason)) throw refuse(hostId, "PROTOCOL_INVALID");
			return { matches, matchedFiles, scannedFiles, scannedBytes, truncated, reason: reason as RemoteHelperSearchContentReason };
		}
		if (reason !== undefined) throw refuse(hostId, "PROTOCOL_INVALID");
		return { matches, matchedFiles, scannedFiles, scannedBytes, truncated };
	}

	return {
		async search(hostId, path, query, options) {
			const host = readHostId(hostId);
			const target = readRequestPath(path);
			const text = readQuery(query);
			const read = readCallOptions(options);
			// 非法调用的具体值不进诊断：host id / path / query 都可能是调用方搞错的秘密。
			if (host === undefined || target === undefined || text === undefined || !read.ok) throw new RemoteWorkspaceError(text === undefined ? REMOTE_SEARCH_READER_CODES.queryInvalid : "PROTOCOL_INVALID", false);
			const params = read.maxMatches === undefined ? { path: target, query: text } : { path: target, query: text, maxMatches: read.maxMatches };
			let raw: unknown;
			try {
				raw = await request(host, REMOTE_HELPER_METHOD_FS_SEARCH_NAMES, params, read.timeoutMs === undefined ? undefined : { timeoutMs: read.timeoutMs });
			} catch (error) {
				const failure = readTransportFailure(error);
				throw refuse(host, failure.code, failure.retryable);
			}
			return readSearchResult(host, raw);
		},

		/**
		 * 有界内容搜索。query/path/host 与名字搜索共用同一套本地校验；`signal` 取消会经 port 的
		 * `cancel` 转成 helper 的 REQUEST_CANCELLED，因此取消是一次正常结算，不会等到时间预算耗尽。
		 */
		async searchContent(hostId, path, query, options) {
			const host = readHostId(hostId);
			const target = readRequestPath(path);
			const text = readQuery(query);
			const read = readContentCallOptions(options);
			if (host === undefined || target === undefined || text === undefined || !read.ok) throw new RemoteWorkspaceError(text === undefined ? REMOTE_SEARCH_READER_CODES.queryInvalid : "PROTOCOL_INVALID", false);
			const params = read.maxMatches === undefined ? { path: target, query: text } : { path: target, query: text, maxMatches: read.maxMatches };
			const signal = options?.signal;
			if (isAborted(signal)) throw new RemoteWorkspaceError("REQUEST_CANCELLED", false);
			let requestId: string | undefined;
			const onAbort = () => {
				if (requestId !== undefined && cancel !== undefined) void Promise.resolve(cancel(host, requestId)).catch(() => undefined);
			};
			if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
			let raw: unknown;
			try {
				raw = await request(host, REMOTE_HELPER_METHOD_FS_SEARCH_CONTENT, params, {
					...(read.timeoutMs === undefined ? {} : { timeoutMs: read.timeoutMs }),
					onRequestId: (id) => {
						requestId = id;
						if (isAborted(signal)) onAbort();
					},
				});
			} catch (error) {
				// An abort is the caller's own withdrawal: report it as the read channel's cancel code instead of
				// the transport's generic failure, exactly like a helper-side REQUEST_CANCELLED.
				if (isAborted(signal)) throw refuse(host, "REQUEST_CANCELLED", false);
				const failure = readTransportFailure(error);
				throw refuse(host, failure.code, failure.retryable);
			} finally {
				if (signal !== undefined) signal.removeEventListener("abort", onAbort);
			}
			return readContentResult(host, raw);
		},
	};
}
