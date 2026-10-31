/**
 * 远端会话**扫描**的一次性命令源（R1a：读会话列表 / 解析会话根不再抢 helper 的 root）。
 *
 * 为什么需要它：helper 是「一个 host 同时只有一个活动 root」——`--root` 在启动时固定，换 root 就连会话
 * 一起 `discard` 重建（`RemoteHostConnectionService.establishProjectSession`）。会话文件在用户 home 下、
 * 不在任何项目 root 内，于是借 `withProjectSession(hostId, 会话根, …)` 读一次列表 = 把用户项目的活动 root
 * 踢下线再连回来（见 docs/remote-file-tree-and-git-unification-plan.md §1.2 的 R1）。会话历史**写**早就是
 * 另一条路：`RemoteSessionHistoryWriter` 走 pinned SSH **一次性命令**，全程不碰 helper、不切 root。本模块把
 * 「会话根解析」与「会话列表读取」这两件事也搬到同一条路上。
 *
 * 与 `port.withProjectSession` 的关系（两种实现，同一套语义）：
 * - **命令源（本模块）**：装配注入 `transport.runRemoteCommand`（生产是 `runPinnedRemoteCommand`：每次都重过
 *   pin/指纹/路由摘要/严格配置）时使用，不碰 helper；
 * - **helper 会话**：未注入 transport 时退回现状（`RemoteSessionScanner` 里的 helper 适配器）。装配侧把
 *   `transport` 传进来即切换到本模块；两者都实现同一个 `RemoteSessionTreeSource` 面，候选选择、上限、字节
 *   预算、排序与归属仍**全部**留在 scanner 里 —— 本模块只负责「把这四件只读操作变成命令，再把 stdout 解析
 *   成契约形状」（列表 / 批量描述 / 有界头读 / 有界窗口读；后两件服务于会话标题的两段式解析）。
 *
 * 命令形态（与 `RemoteSessionHistoryReader` / `RemoteSessionArchive` 同一套判据）：
 * - **路径先判后发**：绝对路径判据是读取/归档/写守卫共用的 `validateRemoteSessionHistoryPath`，相对身份用
 *   同一模块的 `joinRemoteSessionRoot`（`..`/空段/反斜杠在本地就被拒，远端 shell 永远看不到它们）；
 * - **只出现单引号字面量**：判据已拒单引号与控制字节，命令里不再有第二层转义；
 * - **输出有界**：头读/窗口读 ≤ `REMOTE_WORKSPACE_MAX_HEAD_BYTES` / `..._WINDOW_BYTES`（各 64 KiB，base64
 *   后仍在传输层 256 KiB 内）、目录项数上限 `REMOTE_HELPER_MAX_LIST_ENTRIES`（越界是**拒绝**，不是截断——
 *   用一个 `T` 标记如实上报）、命令长度 ≤ `REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH`；
 * - **失败词汇与 helper 同域**：目标不存在 ⇒ `PATH_NOT_FOUND`，不是普通文件 ⇒ `NOT_A_FILE`（shell 用 exit 6/5
 *   区分），其余失败折叠成本模块的闭集码——于是 title/register 在两条通道上得到同一套原因。
 * - **标记**：每次调用一个本地随机 marker，输出里必须**恰好出现一次**，登录横幅之类的噪声因此进不了解析；
 * - **闭集稳定码**：stderr/errno/路径/命令行一律不外传，失败折叠成本模块的码（见
 *   `REMOTE_SESSION_SCAN_SOURCE_CODES`）。
 *
 * 已知代价（如实记录，不要当成已完成）：
 * - 目录列表由 shell 的 `*` 展开，因此**一目录一次往返**，不像 helper 的 `fs.list` 那样按帧复用会话；
 *   一次扫描的请求数 = 1（配置探测）+ 1（根列表）+ 目录数 + ceil(候选/64)（元数据批）。
 * - mtime 由 `stat -c %Y`（GNU）/ `stat -f %m`（BSD）取**秒**精度，`mtimeMs` 因此是秒×1000：只用于展示与排序，
 *   不参与任何判定。两侧都不可用时整次扫描按 `COMMAND_FAILED` 失败，绝不退化成「看起来空」的列表。
 * - 列表与批量描述之间消失/换类型的条目被跳过（与 helper 路径对「非 file」的处理同口径），不登记成会话。
 * - 远端 home 或会话根里出现单引号/控制字节时 fail closed（`PATH_INVALID`），而不是静默扫错目录——判据与
 *   读取/归档/写守卫同源，pi 的会话目录形状里没有这些字符。
 */

import { randomBytes } from "node:crypto";
// hostId 的判据只允许有一份：与持久化边界（readSshSessionLocator / 项目域）共用 shared 的权威取值域。
import { PROJECT_HOST_ID_PATTERN } from "../../shared/projectLocation";
import { REMOTE_HELPER_MAX_LIST_ENTRIES, REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH, REMOTE_HELPER_MAX_STAT_MANY_PATHS } from "../remote/RemoteHelperContract";
import { joinRemoteSessionRoot, validateRemoteSessionHistoryPath } from "../remote/RemoteSessionHistoryReader";
// 两个上限与 helper 读取面同一取值域：窗口不许比它大（否则一次有界读会被传输层的 256 KiB 输出上限判成失败）。
import { REMOTE_WORKSPACE_MAX_HEAD_BYTES, REMOTE_WORKSPACE_MAX_WINDOW_BYTES } from "../remote/RemoteWorkspaceReader";

/** 本模块的稳定码词汇（闭集；`message` 永远是一个码，不是一句话）。 */
export const REMOTE_SESSION_SCAN_SOURCE_CODES = {
	/** hostId 不是可用的诊断身份/传输键。 */
	hostIdInvalid: "REMOTE_SESSION_SCAN_SOURCE_HOST_ID_INVALID",
	/** 远端路径不可用（非绝对/非规范形式/含单引号或控制字节/超长）：一个命令都不发。 */
	pathInvalid: "REMOTE_SESSION_SCAN_SOURCE_PATH_INVALID",
	/** 传输层失败（ssh 起不来、超时、输出超上界）且自身不带稳定码。 */
	transportFailed: "REMOTE_SESSION_SCAN_SOURCE_TRANSPORT_FAILED",
	/** 远端命令退出码非 0（目录不可用 / 描述失败；stderr 不外传）。 */
	commandFailed: "REMOTE_SESSION_SCAN_SOURCE_COMMAND_FAILED",
	/** 输出里没有唯一的本次 marker，或字段形状不符合契约。 */
	outputInvalid: "REMOTE_SESSION_SCAN_SOURCE_OUTPUT_INVALID",
	/** 目录项数越过契约上限（拒绝而不是截断：截断后的列表看起来和完整列表一样）。 */
	listLimitExceeded: "REMOTE_SESSION_SCAN_SOURCE_LIST_LIMIT_EXCEEDED",
} as const;

/** 装配/构造期参数不合法（与其它远端模块一致，构造或构命令时即抛，不等到远端往返）。 */
export const REMOTE_SESSION_SCAN_SOURCE_OPTIONS_INVALID = "REMOTE_SESSION_SCAN_SOURCE_OPTIONS_INVALID";

/** 目录项的三种类型，与 helper `fs.list` / `fs.stat` 的词汇逐字一致（symlink 是 `other`，不跟随）。 */
export type RemoteSessionTreeKind = "file" | "directory" | "other";

/** 一个目录项（不含大小：扫描器不需要，也就不用为它发额外请求）。 */
export type RemoteSessionTreeEntry = { readonly name: string; readonly kind: RemoteSessionTreeKind };

/** 批量描述的类型词汇：比目录项多一个 `missing`（列表与描述之间被删），调用方据此区分「没这个路径」与「不是普通文件」。 */
export type RemoteSessionTreeStatKind = RemoteSessionTreeKind | "missing";

/** 一次批量描述的单个结果，按请求顺序回显请求路径。 */
export type RemoteSessionTreeStat = {
	readonly path: string;
	readonly kind: RemoteSessionTreeStatKind;
	readonly bytes: number;
	readonly mtimeMs: number;
};

/** 一段有界字节 + 远端文件完整大小（头读与窗口读共用；`bytes === content.length`）。 */
export type RemoteSessionTreeBytes = { readonly content: Uint8Array; readonly bytes: number; readonly size: number };

/** 窗口读的入参（与 `RemoteWorkspaceWindowOptions` 同义；`size` 给了就不必自己再量一次文件大小）。 */
export type RemoteSessionTreeWindowOptions = { readonly offset: number; readonly maxBytes: number; readonly size?: number };

/**
 * 绑定在某个 root 上的只读访问面：四件操作都只收**相对 root 的路径**，root 由 `withRoot` 固定。
 * 两个实现（一次性命令 / helper 会话）语义必须逐字一致，否则 scanner 的上限与预算就失去了统一口径。
 */
export type RemoteSessionTree = {
	/**
	 * 有界读一个文件头部（≤ `REMOTE_WORKSPACE_MAX_HEAD_BYTES`）：返回字节与文件大小。
	 * 不存在 ⇒ `PATH_NOT_FOUND`，不是普通文件 ⇒ `NOT_A_FILE`（与 helper `fs.stat`/`fs.read` 同一词汇）。
	 */
	readHead(relativePath: string, maxBytes: number): Promise<RemoteSessionTreeBytes>;
	/**
	 * 有界窗口读（≤ `REMOTE_WORKSPACE_MAX_WINDOW_BYTES`）：`offset` 超过文件尾 ⇒ 空窗口（那是真话，不是错误）。
	 * 会话标题的第二段（pi 的 `/name` 追加在文件尾）就走这里，全程仍只有 1 次文件大小读取。
	 */
	readWindow(relativePath: string, window: RemoteSessionTreeWindowOptions): Promise<RemoteSessionTreeBytes>;
	/** 列一个目录（`.` = root 自己）。越界是稳定码，不是截断。 */
	list(relativeDirectory: string): Promise<readonly RemoteSessionTreeEntry[]>;
	/** 批量描述（≤ `REMOTE_HELPER_MAX_STAT_MANY_PATHS` 条/次），结果按请求顺序、路径原样回显。 */
	statMany(relativePaths: readonly string[]): Promise<readonly RemoteSessionTreeStat[]>;
};

export type RemoteSessionTreeSource = {
	/** 在指定 root 上跑完整个读任务。helper 实现会因此**切换 host 的活动 root**；命令实现不会。 */
	withRoot<T>(hostId: string, root: string, task: (tree: RemoteSessionTree) => Promise<T>): Promise<T>;
};

/**
 * 远端短命令传输端口：与阅读/归档/写守卫同一条 pinned SSH 通道（装配传入同一个 `runPinnedRemoteCommand`）。
 * 超时归传输层（`SshClientRuntime.run` 自带 30 s 上限与 256 KiB 输出上限），本模块不另给 deadline。
 */
export type RemoteSessionCommandTransportPort = {
	runRemoteCommand(input: { hostId: string; remoteCommand: string }): Promise<{ exitCode: number; stdout: string }>;
};

/** marker 的字符形状：本地随机 hex（构造与解析两侧共用同一个函数，绝不各写一份）。 */
const NONCE = /^[a-f0-9]{32}$/;
/** 只用于量命令长度的固定 nonce（marker 长度固定，因此量出来的长度与真实命令逐字一致）。 */
const MEASUREMENT_NONCE = "0".repeat(32);
/** 一个稳定码就是一个码，绝不是自由文本。 */
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
/** 目录项名字：单段、无分隔符、无控制字节（与 helper 契约的判据一致）。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** 元数据里的十进制字段（大小非负；mtime 允许 1970 前）。 */
const COUNT_FIELD = /^\d{1,20}$/;
const SECONDS_FIELD = /^-?\d{1,20}$/;
/** base64 载荷：只认标准字母表（解码前已去掉 base64 的折行）。 */
const BASE64_FIELD = /^[A-Za-z0-9+/]+={0,2}$/;
/** 目录项被上限截断时远端追加的标记（随后按稳定码拒绝，绝不返回半截列表）。 */
const TRUNCATED_FIELD = "T";
/** 目标不存在 / 不是普通文件：沿用 helper 契约已有的两个码（title/register 一直转述它们）。 */
const PATH_NOT_FOUND = "PATH_NOT_FOUND";
const NOT_A_FILE = "NOT_A_FILE";

function stable(code: string): Error {
	return new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只透传本身已经是稳定码的 message；路径/命令行/errno 永不外传。 */
function codeOf(error: unknown, fallback: string): string {
	if (isRecord(error)) {
		const message = error.message;
		if (typeof message === "string" && STABLE_CODE.test(message)) return message;
	}
	return fallback;
}

/** 本次调用的 marker：`PIDECK_SCAN_<nonce>`，构造命令与解析输出必须用同一个函数。 */
export function remoteSessionScanMarker(nonce: unknown): string {
	if (typeof nonce !== "string" || !NONCE.test(nonce)) throw stable(REMOTE_SESSION_SCAN_SOURCE_OPTIONS_INVALID);
	return `PIDECK_SCAN_${nonce}`;
}

/** 绝对路径的唯一判据：与读取/归档/写守卫共用同一实现（本模块不抄第二套归一化）。 */
function readAbsolutePath(value: unknown): string {
	const path = validateRemoteSessionHistoryPath(value);
	if (path === undefined) throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.pathInvalid);
	return path;
}

/** 头读上限：正安全整数且 ≤ `REMOTE_WORKSPACE_MAX_HEAD_BYTES`（与 helper 同一个值，越界拒绝而不是 clamp）。 */
function readHeadMaxBytes(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > REMOTE_WORKSPACE_MAX_HEAD_BYTES) throw stable(REMOTE_SESSION_SCAN_SOURCE_OPTIONS_INVALID);
	return value;
}

/** 窗口读上限与起点：与 helper `readWindow` 同判据（`offset` 非负、`maxBytes` ≤ 64 KiB、`size` 可选）。 */
function readWindowSpec(value: unknown): { offset: number; maxBytes: number; size: number | undefined } {
	if (!isRecord(value)) throw stable(REMOTE_SESSION_SCAN_SOURCE_OPTIONS_INVALID);
	const offset = value.offset;
	const maxBytes = value.maxBytes;
	const size = value.size;
	if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw stable(REMOTE_SESSION_SCAN_SOURCE_OPTIONS_INVALID);
	if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > REMOTE_WORKSPACE_MAX_WINDOW_BYTES) throw stable(REMOTE_SESSION_SCAN_SOURCE_OPTIONS_INVALID);
	if (size !== undefined && (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)) throw stable(REMOTE_SESSION_SCAN_SOURCE_OPTIONS_INVALID);
	return { offset, maxBytes, size };
}

/**
 * 文件存在性与普通文件校验的 shell 前缀（两件读操作共用）。
 * exit 6 = 不存在（`PATH_NOT_FOUND`），exit 5 = 不是普通文件（`NOT_A_FILE`），其余非 0 由调用方折成 `COMMAND_FAILED`。
 * `-L` 也算存在：悬空链接不是「没有这个路径」，而是「不是普通文件」。
 */
function assertRegularFile(command: string): string {
	return `if [ ! -e ${command} ] && [ ! -L ${command} ]; then exit 6; fi; [ -f ${command} ] || exit 5`;
}

/**
 * 有界头读命令。
 *
 * 形状：`<存在性校验>; printf '<marker>'; wc -c < <path>; head -c <maxBytes> -- <path> | base64`
 * - 输出 = marker + 一行文件大小 + base64 载荷（一次往返同时拿到「大小」与「头部字节」）；
 * - base64 避免二进制/控制字节在 stdout 里被再编码一次；解码前去掉折行（GNU base64 默认 76 列）；
 * - 文件大小是**远端自己的**陈述：解析侧要求「解码字节数 == min(size, maxBytes)」，对不上就是协议违约。
 */
export function buildRemoteSessionHeadCommand(input: { path: unknown; maxBytes: unknown; nonce: unknown }): { command: string; marker: string } {
	const path = readAbsolutePath(input?.path);
	const maxBytes = readHeadMaxBytes(input?.maxBytes);
	const marker = remoteSessionScanMarker(input?.nonce);
	const quoted = `'${path}'`;
	const command = `${assertRegularFile(quoted)}; printf '${marker}'; wc -c < ${quoted}; head -c ${maxBytes} -- ${quoted} | base64`;
	return { command: assertCommandBudget(command), marker };
}

/**
 * 有界窗口读命令（标题的第二段：pi 的 `/name` 追加在文件尾）。
 *
 * 形状：`<存在性校验>; printf '<marker>'; wc -c < <path>; tail -c +<offset+1> -- <path> | head -c <maxBytes> | base64`
 * - `tail -c +N` 是 **1-based**，所以起点 = `offset + 1`（offset 0 即整文件）；
 * - 起点超过文件尾 ⇒ 空载荷（与 helper 的「空窗口」同语义）；
 * - 与 helper 一致：`size` 给了也不因此少发 `wc -c`（一次同步调用，不增加往返，换来解析侧能自证长度）。
 */
export function buildRemoteSessionWindowCommand(input: { path: unknown; window: unknown; nonce: unknown }): { command: string; marker: string } {
	const path = readAbsolutePath(input?.path);
	const { offset, maxBytes } = readWindowSpec(input?.window);
	const marker = remoteSessionScanMarker(input?.nonce);
	const quoted = `'${path}'`;
	const start = offset + 1;
	const command = `${assertRegularFile(quoted)}; printf '${marker}'; wc -c < ${quoted}; tail -c +${start} -- ${quoted} | head -c ${maxBytes} | base64`;
	return { command: assertCommandBudget(command), marker };
}

/** marker 之后的唯一性校验：出现零次或多于一次都说明这段输出不是我们那一条命令的答案。 */
function payloadAfterMarker(stdout: unknown, marker: string): string {
	if (typeof stdout !== "string") throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.outputInvalid);
	const index = stdout.indexOf(marker);
	if (index < 0 || index !== stdout.lastIndexOf(marker)) throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.outputInvalid);
	return stdout.slice(index + marker.length);
}

/** 命令长度是硬预算：超了就不是「慢一点」，而是对端 shell 收到一条被截断的命令。 */
function assertCommandBudget(command: string): string {
	if (command.length > REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH) throw stable(REMOTE_SESSION_SCAN_SOURCE_OPTIONS_INVALID);
	return command;
}

/**
 * 目录列表命令（`kind NUL name NUL` 逐项输出，上限 `REMOTE_HELPER_MAX_LIST_ENTRIES`）。
 *
 * - `cd` 失败（不存在 / 不是目录）⇒ exit 3 ⇒ `COMMAND_FAILED`；
 * - `.[!.]*` / `..?*` 覆盖点条目且不匹配 `.` / `..`；不匹配的 glob 保持字面量，被 `-e`/`-L` 双双跳过；
 * - 类型判据与 helper 同义：`-L` ⇒ `O`（symlink 不跟随），`-d` ⇒ `D`，`-f` ⇒ `F`，其余 ⇒ `O`；
 * - 到上限时补一个 `T` 标记：调用方据此**拒绝**整次列表（截断后的列表看起来和完整列表一样）。
 */
export function buildRemoteSessionListCommand(input: { directory: unknown; nonce: unknown }): { command: string; marker: string } {
	const directory = readAbsolutePath(input?.directory);
	const marker = remoteSessionScanMarker(input?.nonce);
	const quoted = `'${directory}'`;
	const command = `cd ${quoted} || exit 3; printf '${marker}'; i=0; for entry in .[!.]* ..?* *; do [ -e "$entry" ] || [ -L "$entry" ] || continue; if [ -L "$entry" ]; then k=O; elif [ -d "$entry" ]; then k=D; elif [ -f "$entry" ]; then k=F; else k=O; fi; printf '%s\\0%s\\0' "$k" "$entry"; i=$((i+1)); if [ "$i" -ge ${REMOTE_HELPER_MAX_LIST_ENTRIES} ]; then printf 'T\\0'; break; fi; done`;
	return { command: assertCommandBudget(command), marker };
}

/**
 * 批量描述命令（每条目标产出 `F NUL size NUL mtimeSeconds NUL`，其余是单个类型字符）。
 *
 * - `-L` ⇒ `O`（symlink 不跟随）；`-f` ⇒ 取 `wc -c` 与 mtime；`-d` ⇒ `D`；`-e` 但仍不是文件/目录 ⇒ `O`；
 *   什么都不命中（列表与描述之间被删）⇒ `X`（调用方跳过，不登记成会话）；
 * - 大小用 POSIX `wc -c`，mtime 先 GNU `stat -c %Y` 再 BSD `stat -f %m`（GNU 上第一条永远成功）；
 *   两条都不可用 ⇒ exit 4 ⇒ `COMMAND_FAILED`（绝不把「读不到时间」变成「这一条不存在」）；
 * - 不可读的普通文件同样 exit 4：宁可整次扫描失败，也不静默丢一条会话。
 */
export function buildRemoteSessionStatCommand(input: { paths: unknown; nonce: unknown }): { command: string; marker: string } {
	const targets = input?.paths;
	if (!Array.isArray(targets) || targets.length === 0 || targets.length > REMOTE_HELPER_MAX_STAT_MANY_PATHS) throw stable(REMOTE_SESSION_SCAN_SOURCE_OPTIONS_INVALID);
	const absolute = targets.map((value) => readAbsolutePath(value));
	const marker = remoteSessionScanMarker(input?.nonce);
	const quotedPaths = absolute.map((path) => `'${path}'`).join(" ");
	const command = `printf '${marker}'; for f in ${quotedPaths}; do if [ -L "$f" ]; then printf 'O\\0'; elif [ -f "$f" ]; then s=$(wc -c < "$f") || exit 4; m=$(stat -c %Y -- "$f" 2>/dev/null || stat -f %m -- "$f" 2>/dev/null) || exit 4; printf 'F\\0%s\\0%s\\0' "$s" "$m"; elif [ -d "$f" ]; then printf 'D\\0'; elif [ -e "$f" ]; then printf 'O\\0'; else printf 'X\\0'; fi; done`;
	return { command: assertCommandBudget(command), marker };
}

/**
 * 解析「marker + 一行大小 + base64 载荷」（头读与窗口读共用的信封，纯函数）。
 * 长度必须逐字等于请求范围：少一个字节就说明这次读不可信，宁可拒绝也不返回半段内容。
 */
function parseSizedPayload(stdout: unknown, marker: string, expected: (size: number) => number): RemoteSessionTreeBytes {
	const payload = payloadAfterMarker(stdout, marker);
	const newline = payload.indexOf("\n");
	if (newline < 0) throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.outputInvalid);
	const sizeField = payload.slice(0, newline).trim();
	if (!COUNT_FIELD.test(sizeField)) throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.outputInvalid);
	const size = Number(sizeField);
	if (!Number.isSafeInteger(size)) throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.outputInvalid);
	const encoded = payload.slice(newline + 1).replace(/\s+/g, "");
	if (encoded.length > 0 && !BASE64_FIELD.test(encoded)) throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.outputInvalid);
	const content = encoded.length === 0 ? new Uint8Array(0) : Buffer.from(encoded, "base64");
	// 远端自己报的大小与它实际送回来的字节数必须一致（文件在两次 syscall 之间变了就是不可信）。
	if (content.length !== expected(size)) throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.outputInvalid);
	return { content, bytes: content.length, size };
}

/** 解析有界头读的 stdout（纯函数）：期望 `min(size, maxBytes)` 字节。 */
export function parseRemoteSessionHead(stdout: unknown, marker: string, maxBytes: number): RemoteSessionTreeBytes {
	readHeadMaxBytes(maxBytes);
	return parseSizedPayload(stdout, marker, (size) => Math.min(maxBytes, size));
}

/** 解析有界窗口读的 stdout（纯函数）：期望 `min(maxBytes, max(0, size - offset))` 字节。 */
export function parseRemoteSessionWindow(stdout: unknown, marker: string, window: RemoteSessionTreeWindowOptions): RemoteSessionTreeBytes {
	const { offset, maxBytes } = readWindowSpec(window);
	return parseSizedPayload(stdout, marker, (size) => Math.min(maxBytes, Math.max(0, size - Math.min(offset, size))));
}

/**
 * 解析目录列表的 stdout（纯函数）。字段必须成对、类型字符必须在闭集内、名字必须是单段路径；
 * 出现 `T` 标记即按「越界」拒绝（不是返回前 N 条）。
 */
export function parseRemoteSessionListing(stdout: unknown, marker: string): readonly RemoteSessionTreeEntry[] {
	const payload = payloadAfterMarker(stdout, marker);
	const fields = payload.split("\u0000");
	if (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
	if (fields.length > 0 && fields[fields.length - 1] === TRUNCATED_FIELD) throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.listLimitExceeded);
	if (fields.length % 2 !== 0) throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.outputInvalid);
	const entries: RemoteSessionTreeEntry[] = [];
	for (let index = 0; index < fields.length; index += 2) {
		const flag = fields[index];
		const name = fields[index + 1] ?? "";
		// 一个名字必须是一段路径：空、`.`/`..`、分隔符、控制字节都不是名字，而是协议违例。
		if (name.length === 0 || name === "." || name === ".." || name.length > 255 || name.includes("/") || name.includes("\\") || CONTROL_CHARS.test(name)) throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.outputInvalid);
		entries.push({ name, kind: readKindFlag(flag) });
	}
	// 顺序固定（按名字 code-unit 升序）：同一棵树的两次扫描逐字可比，字节预算的扣减顺序也才确定。
	return entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

function readKindFlag(value: string | undefined): RemoteSessionTreeKind {
	if (value === "F") return "file";
	if (value === "D") return "directory";
	// `O`（链接/其它）与 `X`（已消失）都按「不是会话文件」处理：列表阶段跳过，绝不登记。
	if (value === "O" || value === "X") return "other";
	throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.outputInvalid);
}

/** 描述阶段的类型字符：`X` 保留成 `missing`，使 register 能把它报成 `PATH_NOT_FOUND`（与 helper 逐字一致）。 */
function readStatKindFlag(value: string | undefined): RemoteSessionTreeStatKind {
	if (value === "X") return "missing";
	return readKindFlag(value);
}

function readCountField(value: string | undefined): number {
	if (typeof value !== "string" || !COUNT_FIELD.test(value.trim())) throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.outputInvalid);
	const count = Number(value.trim());
	if (!Number.isSafeInteger(count)) throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.outputInvalid);
	return count;
}

/** 解析批量描述的 stdout（纯函数）：只给顺序，不带路径——请求与答案的绑定由调用方按位置完成。 */
export function parseRemoteSessionStats(stdout: unknown, marker: string): readonly Omit<RemoteSessionTreeStat, "path">[] {
	const payload = payloadAfterMarker(stdout, marker);
	const fields = payload.split("\u0000");
	if (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
	const stats: Omit<RemoteSessionTreeStat, "path">[] = [];
	let cursor = 0;
	while (cursor < fields.length) {
		const kind = readStatKindFlag(fields[cursor]);
		cursor += 1;
		if (kind !== "file") {
			stats.push({ kind, bytes: 0, mtimeMs: 0 });
			continue;
		}
		const bytes = readCountField(fields[cursor]);
		const secondsField = fields[cursor + 1];
		cursor += 2;
		if (typeof secondsField !== "string" || !SECONDS_FIELD.test(secondsField.trim())) throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.outputInvalid);
		const seconds = Number(secondsField.trim());
		// mtimeMs 是秒×1000：只用于展示与排序（精度损失写在本模块头注释里），但不能是 NaN/Infinity。
		const mtimeMs = seconds * 1000;
		if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(mtimeMs)) throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.outputInvalid);
		stats.push({ kind, bytes, mtimeMs });
	}
	return stats;
}

function randomNonce(): string {
	return randomBytes(16).toString("hex");
}

/**
 * 一次性命令实现：`withRoot` 只校验 root（不建会话、不切 root），三件操作各自发一条短命令。
 */
export function createRemoteSessionScanSource(input: { transport: RemoteSessionCommandTransportPort }): RemoteSessionTreeSource {
	if (!isRecord(input) || typeof input.transport?.runRemoteCommand !== "function") throw stable(REMOTE_SESSION_SCAN_SOURCE_OPTIONS_INVALID);
	const transport = input.transport;

	/** 发一条命令并返回 stdout：传输失败与退出码都要折叠成闭集码（stderr 永远不外传）。 */
	async function run(hostId: string, command: string): Promise<string> {
		let result: { exitCode: number; stdout: string };
		try {
			result = await transport.runRemoteCommand({ hostId, remoteCommand: command });
		} catch (error) {
			// 连接层自己的稳定码（SSH_HOST_NOT_READY / SSH_HOST_ROUTE_CHANGED …）原样转述。
			throw stable(codeOf(error, REMOTE_SESSION_SCAN_SOURCE_CODES.transportFailed));
		}
		if (!isRecord(result) || typeof result.stdout !== "string" || !Number.isSafeInteger(result.exitCode)) throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.transportFailed);
		// 两个专用退出码与 helper 的词汇对齐，其余非 0 才是「命令失败」。
		if (result.exitCode === 5) throw stable(NOT_A_FILE);
		if (result.exitCode === 6) throw stable(PATH_NOT_FOUND);
		if (result.exitCode !== 0) throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.commandFailed);
		return result.stdout;
	}

	/** 相对身份 → 绝对路径：与读取/归档共用 `joinRemoteSessionRoot`（`..`/空段在这里就被拒）。 */
	function resolveInRoot(root: string, relative: unknown): string {
		if (relative === ".") return root;
		const joined = joinRemoteSessionRoot(root, typeof relative === "string" ? relative : "");
		if (joined === undefined) throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.pathInvalid);
		return joined;
	}

	function tree(hostId: string, root: string): RemoteSessionTree {
		return {
			async readHead(relativePath, maxBytes) {
				const { command, marker } = buildRemoteSessionHeadCommand({ path: resolveInRoot(root, relativePath), maxBytes, nonce: randomNonce() });
				return parseRemoteSessionHead(await run(hostId, command), marker, maxBytes);
			},
			async readWindow(relativePath, window) {
				const { command, marker } = buildRemoteSessionWindowCommand({ path: resolveInRoot(root, relativePath), window, nonce: randomNonce() });
				return parseRemoteSessionWindow(await run(hostId, command), marker, window);
			},
			async list(relativeDirectory) {
				const { command, marker } = buildRemoteSessionListCommand({ directory: resolveInRoot(root, relativeDirectory), nonce: randomNonce() });
				return parseRemoteSessionListing(await run(hostId, command), marker);
			},
			async statMany(relativePaths) {
				if (!Array.isArray(relativePaths) || relativePaths.length === 0 || relativePaths.length > REMOTE_HELPER_MAX_STAT_MANY_PATHS) throw stable(REMOTE_SESSION_SCAN_SOURCE_OPTIONS_INVALID);
				const absolute = relativePaths.map((relative) => resolveInRoot(root, relative));
				// 命令长度是硬预算：长 root + 64 条长名字会超 8 KiB，于是按**长度**再切一次（顺序与计数不变）。
				const chunks: string[][] = [];
				let current: string[] = [];
				for (const path of absolute) {
					const candidate = [...current, path];
					// marker 长度固定，量长度用固定 nonce 就够（不额外消耗随机源）。
					const fits = current.length === 0 || buildRemoteSessionStatCommand({ paths: candidate, nonce: MEASUREMENT_NONCE }).command.length <= REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH;
					if (!fits) {
						chunks.push(current);
						current = [path];
						continue;
					}
					current = candidate;
				}
				if (current.length > 0) chunks.push(current);
				const stats: RemoteSessionTreeStat[] = [];
				let offset = 0;
				for (const chunk of chunks) {
					const { command, marker } = buildRemoteSessionStatCommand({ paths: chunk, nonce: randomNonce() });
					const parsed = parseRemoteSessionStats(await run(hostId, command), marker);
					// 位置绑定：远端不许少答、多答或重排（否则描述与身份就对不上了）。
					if (parsed.length !== chunk.length) throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.outputInvalid);
					for (let index = 0; index < parsed.length; index += 1) {
						const relative = relativePaths[offset + index];
						const stat = parsed[index];
						if (relative === undefined || stat === undefined) throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.outputInvalid);
						stats.push({ path: relative, ...stat });
					}
					offset += chunk.length;
				}
				return stats;
			},
		};
	}

	return {
		async withRoot(hostId, root, task) {
			if (typeof hostId !== "string" || !PROJECT_HOST_ID_PATTERN.test(hostId)) throw stable(REMOTE_SESSION_SCAN_SOURCE_CODES.hostIdInvalid);
			return await task(tree(hostId, readAbsolutePath(root)));
		},
	};
}
