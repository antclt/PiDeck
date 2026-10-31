/**
 * 本机 → 远端项目的文件上传（任意字节，不是"文本编辑器保存"）。
 *
 * 为什么必须另开一条通道：`RemoteProjectFileService.save` 是编辑器语义——只收 UTF-8 文本、上限
 * 256 KiB、数据经 argv 传入（受 8192 字符命令预算约束，单块只能 4 KiB）。上传图片/压缩包/大文件
 * 三样都不成立。这里改成 **stdin 分块**：命令只带元数据，字节走子进程 stdin，块大小由帧上限决定
 * 而不是命令行长度。
 *
 * 安全边界与其它远端写面逐字一致：
 * - 脚本前缀直接拼接 `BOUNDARY_SCRIPT`（canonical root 重证 + 父链逐级非链接 + /proc/self/fd 锚定），
 *   本文件不复制那套判据；
 * - argv 里只有元数据（相对路径、字节数、sha256、覆盖开关），没有任何字节内容；
 * - 先写临时文件（同目录、0600、O_EXCL|O_NOFOLLOW），校验大小与 sha256 后才 rename——失败不会留下
 *   半个文件，也不会破坏原文件；
 * - 目标已存在且未显式要求覆盖时拒绝（错误码与本地 backend 的语义对齐）。
 */

import { createHash, randomBytes } from "node:crypto";
import type { SshLauncherHandle, SshProcessLauncher } from "./RemoteHostConnectionTypes";
import { quotePosixArgument } from "./RemoteBootstrapContract";
import { buildPinnedSshInvocation } from "./SshVerifiedConnection";
import type { SshClientRuntime } from "./SshClientRuntime";
import { BOUNDARY_SCRIPT, validateRemoteProjectTextPath } from "./RemoteProjectFileCommands";
import { readCanonicalBrowseRoot } from "./RemoteBrowseRoot";
import { isRemoteProjectTrashPath } from "./RemoteProjectEntryCommands";
import { REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH } from "./RemoteHelperContract";

/** 单个文件上限：与远端读通道（`REMOTE_WORKSPACE_MAX_READ_BYTES`）对齐，下载能拿回来的东西才允许上传。 */
export const REMOTE_PROJECT_UPLOAD_MAX_BYTES = 16 * 1024 * 1024;

/** 单块原始字节数：base64 后约 1.4 MB，远小于 8 MiB 帧上限，16 MiB 的文件是 16 块。 */
export const REMOTE_PROJECT_UPLOAD_CHUNK_BYTES = 1024 * 1024;

/**
 * 上传临时文件名的形状：`.<32 hex>.pideck-put`，写在目标同目录。
 *
 * 它只在一次上传窗口内存在；进程被强杀（超时 kill / OOM）时 `finally` 来不及跑，文件会留在远端。
 * 列表与搜索据此把它隐藏——让用户看到「一个他没传过的文件」比残留本身更糟。带上 32 位 hex
 * 是为了「只有我们造的名字会被隐藏」，用户自己的 `.foo.pideck-put` 照常显示。
 */
export const REMOTE_UPLOAD_TEMP_NAME = /^\.[a-f0-9]{32}\.pideck-put$/;

export const REMOTE_PROJECT_UPLOAD_CODES = {
	inputInvalid: "REMOTE_FILE_INPUT_INVALID",
	tooLarge: "REMOTE_FILE_TOO_LARGE",
	trashPath: "REMOTE_FILE_PROTECTED_PATH",
	pathInvalid: "REMOTE_FILE_PATH_INVALID",
	/** 目标已存在且调用方没有要求覆盖。 */
	exists: "REMOTE_FILE_TARGET_EXISTS",
	commandFailed: "REMOTE_FILE_COMMAND_FAILED",
} as const;

/**
 * 上传脚本：`<node> -e <script> put <marker> <root> <relative> <jsonArgs>`。
 *
 * stdin 逐行读 base64 块，最后一行是 `END`。写临时文件时边写边算 sha256，收完先校验
 * （字节数 + 摘要）再 rename —— 这一步之前任何失败都只删临时文件。
 */
export const REMOTE_PROJECT_PUT_SCRIPT =
	BOUNDARY_SCRIPT +
	`
const crypto = require("node:crypto");
const LIMIT = ${REMOTE_PROJECT_UPLOAD_MAX_BYTES};
let result, made = false, temp = null;
try {
  const bound = B();
  if (String(args.bytes) === "" || !Number.isSafeInteger(args.bytes) || args.bytes < 1 || args.bytes > LIMIT) T("REMOTE_FILE_TOO_LARGE");
  if (typeof args.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(args.sha256)) T("REMOTE_FILE_INPUT_INVALID");
  // 占用判据必须以 lstat 为准：symlink 与目录同样是"有个东西在那儿"，用 rename 覆盖它们等于
  // 悄悄把用户的链接换成普通文件。overwrite 只允许替换**常规文件**。
  let occupied = false;
  try { fs.lstatSync(bound.file); occupied = true; } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (!occupied) {
    // 新建：没问题。
  } else if (args.overwrite !== true) {
    T("REMOTE_FILE_TARGET_EXISTS");
  } else if (!fs.lstatSync(bound.file).isFile()) {
    T("REMOTE_FILE_PATH_INVALID");
  }
  temp = bound.anchor + "/." + args.nonce + ".pideck-put";
  const fd = fs.openSync(temp, O.O_WRONLY | O.O_CREAT | O.O_EXCL | O.O_NOFOLLOW, 384);
  try {
    const hash = crypto.createHash("sha256");
    let total = 0, rest = Buffer.alloc(0), ended = false;
    const read = Buffer.alloc(65536);
    const handle = (line) => {
      if (line === "END") { ended = true; return; }
      if (ended) T("REMOTE_FILE_INPUT_INVALID");
      if (!/^[A-Za-z0-9+/=]*$/.test(line)) T("REMOTE_FILE_INPUT_INVALID");
      const chunk = Buffer.from(line, "base64");
      total += chunk.length;
      if (total > args.bytes) T("REMOTE_FILE_TOO_LARGE");
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        const n = fs.writeSync(fd, chunk, written, chunk.length - written);
        if (!Number.isInteger(n) || n <= 0) T("REMOTE_FILE_COMMAND_FAILED");
        written += n;
      }
    };
    for (;;) {
      const n = fs.readSync(0, read, 0, read.length, null);
      if (!n) break;
      rest = Buffer.concat([rest, read.subarray(0, n)]);
      let index;
      while ((index = rest.indexOf(10)) >= 0) { handle(rest.subarray(0, index).toString("utf8")); rest = rest.subarray(index + 1); }
    }
    if (rest.length > 0) handle(rest.toString("utf8"));
    if (!ended) T("REMOTE_FILE_INPUT_INVALID");
    if (total !== args.bytes || hash.digest("hex") !== args.sha256) T("REMOTE_FILE_TRANSFER_INVALID");
    // 校验"实际写进去的字节"而不仅是累计意图：短写只在这里能被发现，而且必须在 rename 之前。
    if (fs.fstatSync(fd).size !== args.bytes) T("REMOTE_FILE_TRANSFER_INVALID");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  C(bound);
  fs.renameSync(temp, bound.file);
  made = true;
  const after = fs.lstatSync(bound.file);
  if (!after.isFile() || after.size !== args.bytes) T("REMOTE_FILE_CHANGED");
  result = { ok: true, bytes: after.size };
} catch (e) {
  result = { ok: false, code: made ? "REMOTE_FILE_COMMAND_FAILED" : /^REMOTE_FILE_[A-Z_]+$/.test(e.message) ? e.message : e.code === "EACCES" || e.code === "EPERM" ? "REMOTE_FILE_PERMISSION_DENIED" : e.code === "ENOENT" ? "REMOTE_FILE_NOT_FOUND" : "REMOTE_FILE_COMMAND_FAILED" };
} finally {
  try { if (!made && temp !== null) fs.unlinkSync(temp); } catch {}
  Q();
}
process.stdout.write(marker + JSON.stringify(result));
`;

export function buildRemoteProjectPutCommand(input: { nodePath: string; root: string; relative: string; bytes: number; sha256: string; overwrite: boolean; nonce: string }): { command: string; marker: string } {
	if (typeof input.relative !== "string") throw new Error(REMOTE_PROJECT_UPLOAD_CODES.inputInvalid);
	validateRemoteProjectTextPath(input.relative);
	// 空路径已被 validateRemoteProjectTextPath 拒（它不是「根」，是非法目标）。
	if (isRemoteProjectTrashPath(input.relative)) throw new Error(REMOTE_PROJECT_UPLOAD_CODES.trashPath);
	try {
		if (readCanonicalBrowseRoot(input.root).canonicalPath !== input.root) throw new Error();
		if (readCanonicalBrowseRoot(input.nodePath).canonicalPath !== input.nodePath) throw new Error();
	} catch {
		throw new Error(REMOTE_PROJECT_UPLOAD_CODES.pathInvalid);
	}
	if (!input.nodePath.endsWith("/node")) throw new Error(REMOTE_PROJECT_UPLOAD_CODES.inputInvalid);
	if (!/^[a-f0-9]{32}$/.test(input.nonce)) throw new Error(REMOTE_PROJECT_UPLOAD_CODES.inputInvalid);
	if (!Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > REMOTE_PROJECT_UPLOAD_MAX_BYTES) throw new Error(REMOTE_PROJECT_UPLOAD_CODES.tooLarge);
	if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error(REMOTE_PROJECT_UPLOAD_CODES.inputInvalid);
	const marker = "PIDECK_PUT_" + input.nonce;
	const args = JSON.stringify({ bytes: input.bytes, sha256: input.sha256, overwrite: input.overwrite === true, nonce: input.nonce });
	const script = REMOTE_PROJECT_PUT_SCRIPT.replace(/[ \t]+/g, " ")
		.replace(/ ?\n ?/g, " ")
		.trim();
	const command = [input.nodePath, "-e", script, "put", marker, input.root, input.relative, args].map(quotePosixArgument).join(" ");
	if (command.length > REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH) throw new Error(REMOTE_PROJECT_UPLOAD_CODES.inputInvalid);
	return { command, marker };
}

/**
 * 把一份字节写到远端项目文件。
 *
 * 与安全策略快照那条通道同构（`launcher.start` + stdin + marker 结果行 + 超时收尾），差别是
 * 分块写入且块数由文件大小决定。`overwrite` 默认为 false：覆盖是显式动作，不是默认行为。
 */
export async function uploadRemoteProjectFile(input: {
	userDataDir: string;
	hostId: string;
	generation: number;
	nodePath: string;
	root: string;
	relative: string;
	bytes: Buffer | Uint8Array;
	overwrite?: boolean;
	client: SshClientRuntime;
	launcher: SshProcessLauncher;
	nonce?: string;
	timeoutMs?: number;
}): Promise<void> {
	const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
	if (bytes.length < 1 || bytes.length > REMOTE_PROJECT_UPLOAD_MAX_BYTES) throw new Error(REMOTE_PROJECT_UPLOAD_CODES.tooLarge);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const nonce = input.nonce ?? randomBytes(16).toString("hex");
	const { command, marker } = buildRemoteProjectPutCommand({ nodePath: input.nodePath, root: input.root, relative: input.relative, bytes: bytes.length, sha256, overwrite: input.overwrite === true, nonce });
	const invocation = await buildPinnedSshInvocation(input.userDataDir, input.hostId, "ssh-batch", { client: input.client, remoteCommand: command });
	// 超时按块数放大：一次 ssh 要传完整个文件，固定 30s 会让大文件中途被掐。
	const timeoutMs = Number.isSafeInteger(input.timeoutMs) && (input.timeoutMs as number) > 0 ? (input.timeoutMs as number) : Math.max(60_000, Math.ceil(bytes.length / REMOTE_PROJECT_UPLOAD_CHUNK_BYTES) * 15_000);
	const handle: SshLauncherHandle = await input.launcher.start({ hostId: input.hostId, generation: input.generation, invocation, stdin: true, timeoutMs, maxOutputBytes: 64 * 1024, maxLineBytes: Math.ceil(REMOTE_PROJECT_UPLOAD_CHUNK_BYTES / 3) * 4 + 64 });
	// 缓冲背压：一整份文件可以到 16 MiB，全部同步塞进 stdin 就是无界积压。有 `writeAwait` 时逐块等对端排空；
	// 旧替身 handle 只有同步 `write`，回退到它但保持 await 形状（顺序不变、END 仍是最后一行）。
	const writeFrame =
		typeof handle.writeAwait === "function"
			? (line: string) => handle.writeAwait!(line)
			: async (line: string) => {
					await handle.write(line);
				};
	try {
		const outcome = await new Promise<{ ok: true } | { ok: false; code: string }>((resolve) => {
			let settled = false;
			let unsubscribe: (() => void) | undefined;
			let unsubscribeExit: (() => void) | undefined;
			const finish = (value: { ok: true } | { ok: false; code: string }): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe?.();
				unsubscribeExit?.();
				resolve(value);
			};
			const timer = setTimeout(() => finish({ ok: false, code: REMOTE_PROJECT_UPLOAD_CODES.commandFailed }), timeoutMs);
			// 先订阅再写：结果行可能在写完块之后立刻到达。
			unsubscribe = handle.onStdoutLine((line) => {
				if (!line.includes(marker)) return;
				try {
					const body = JSON.parse(line.slice(line.indexOf(marker) + marker.length));
					if (body !== null && typeof body === "object" && body.ok === true) finish({ ok: true });
					else finish({ ok: false, code: typeof body?.code === "string" && /^REMOTE_[A-Z_]+$/.test(body.code) ? body.code : REMOTE_PROJECT_UPLOAD_CODES.commandFailed });
				} catch {
					finish({ ok: false, code: REMOTE_PROJECT_UPLOAD_CODES.commandFailed });
				}
			});
			unsubscribeExit = handle.onExit(() => finish({ ok: false, code: REMOTE_PROJECT_UPLOAD_CODES.commandFailed }));
			// 整个写入串行 await：块与 END 的先后顺序由 await 保证，而内存占用只跟单帧有关。
			void (async () => {
				try {
					for (let offset = 0; offset < bytes.length; offset += REMOTE_PROJECT_UPLOAD_CHUNK_BYTES) {
						// launcher **自己补换行**，且显式拒绝含 \n 的行（`SSH_LAUNCHER_STDIN_LINE_INVALID`）：
						// 在这里拼上换行会让第一条就抛错，字节一个都到不了远端。
						await writeFrame(bytes.subarray(offset, offset + REMOTE_PROJECT_UPLOAD_CHUNK_BYTES).toString("base64"));
					}
					await writeFrame("END");
				} catch {
					finish({ ok: false, code: REMOTE_PROJECT_UPLOAD_CODES.commandFailed });
				}
			})();
		});
		if (!outcome.ok) throw new Error(outcome.code);
	} finally {
		await handle.stop("shutdown").catch(() => undefined);
	}
}
