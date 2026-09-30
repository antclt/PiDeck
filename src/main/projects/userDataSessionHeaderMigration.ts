import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, writeSync, type Stats } from "node:fs";
import { join, posix, win32 } from "node:path";

/** header 只需容纳路径等元数据；超限或损坏文件保守跳过，不能加载整份聊天历史。 */
const MAX_HEADER_BYTES = 64 * 1024;
const COPY_CHUNK_BYTES = 256 * 1024;

/** 只修复旧根内已不存在、且新根内确有对应目录的 cwd。 */
function relocatedCwd(cwd: string, oldRoot: string, newRoot: string, platform: NodeJS.Platform): string | null {
	const paths = platform === "win32" ? win32 : posix;
	if (!paths.isAbsolute(cwd)) return null;
	const normalized = paths.normalize(cwd).replace(/\\/g, "/");
	const root = paths.normalize(oldRoot).replace(/\\/g, "/");
	const insensitive = platform === "win32" || platform === "darwin";
	const candidate = insensitive ? normalized.toLowerCase() : normalized;
	const prefix = insensitive ? root.toLowerCase() : root;
	if (candidate !== prefix && !candidate.startsWith(`${prefix}/`)) return null;
	const next = join(newRoot, normalized.slice(root.length));
	try {
		statSync(cwd);
		return null;
	} catch (error) {
		// 权限/磁盘错误不等于目录已迁走，不能据此覆盖用户元数据。
		if (!error || typeof error !== "object" || !("code" in error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) return null;
	}
	try {
		return statSync(next).isDirectory() ? next : null;
	} catch {
		return null;
	}
}

/** 有界读取首行；offset 停在换行符之前，以便连同 CRLF 一起逐字节复制正文。 */
function readHeader(fd: number): { text: string; bodyOffset: number } | null {
	const buffer = Buffer.allocUnsafe(MAX_HEADER_BYTES);
	let length = 0;
	while (length < buffer.length) {
		const bytes = readSync(fd, buffer, length, buffer.length - length, length);
		if (bytes === 0) return { text: buffer.toString("utf8", 0, length), bodyOffset: length };
		const newline = buffer.subarray(length, length + bytes).indexOf(0x0a);
		if (newline >= 0) {
			const end = length + newline;
			const bodyOffset = end > 0 && buffer[end - 1] === 0x0d ? end - 1 : end;
			return { text: buffer.toString("utf8", 0, bodyOffset), bodyOffset };
		}
		length += bytes;
	}
	return null;
}

/** writeSync 允许短写，必须写满后才可以发布临时文件。 */
function writeAll(fd: number, data: Buffer): void {
	let offset = 0;
	while (offset < data.length) {
		const bytes = writeSync(fd, data, offset, data.length - offset);
		if (bytes === 0) throw new Error("Session header migration made no write progress");
		offset += bytes;
	}
}

/** 会话在其他进程中追加/替换过时放弃本次发布，避免覆盖并行写入。 */
function unchanged(before: Stats, after: Stats): boolean {
	return after.isFile() && before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

/** 仅重写首行的 cwd；正文按固定大小 Buffer 复制，成功落盘后才原子替换原文件。 */
function repairSessionHeader(filePath: string, oldRoot: string, newRoot: string, platform: NodeJS.Platform): void {
	let source: number | undefined;
	let target: number | undefined;
	let temporary: string | undefined;
	try {
		const initial = lstatSync(filePath);
		if (!initial.isFile()) return;
		source = openSync(filePath, "r");
		if (!unchanged(initial, fstatSync(source))) return;
		const first = readHeader(source);
		if (!first) return;
		const header: unknown = JSON.parse(first.text);
		if (!header || typeof header !== "object" || !("type" in header) || header.type !== "session" || !("cwd" in header) || typeof header.cwd !== "string") return;
		const cwd = relocatedCwd(header.cwd, oldRoot, newRoot, platform);
		if (!cwd) return;

		const tempPath = `${filePath}.${randomUUID()}.tmp`;
		target = openSync(tempPath, "wx", initial.mode);
		temporary = tempPath;
		writeAll(target, Buffer.from(JSON.stringify({ ...header, cwd }), "utf8"));
		const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
		let position = first.bodyOffset;
		while (position < initial.size) {
			const bytes = readSync(source, buffer, 0, Math.min(buffer.length, initial.size - position), position);
			if (bytes === 0) throw new Error("Session changed during header migration");
			writeAll(target, buffer.subarray(0, bytes));
			position += bytes;
		}
		fsyncSync(target);
		closeSync(target);
		target = undefined;
		closeSync(source);
		source = undefined;
		if (!unchanged(initial, lstatSync(filePath))) return;
		renameSync(temporary, filePath);
		temporary = undefined;
	} finally {
		if (source !== undefined) closeSync(source);
		if (target !== undefined) closeSync(target);
		if (temporary !== undefined) rmSync(temporary, { force: true });
	}
}

/** 修复指定 encoded 目录中的原生 JSONL；坏文件/被占用文件不阻断启动，下次仍可重试。 */
export function repairUserDataSessionHeaders(sessionDir: string, oldRoot: string, newRoot: string, platform: NodeJS.Platform): void {
	try {
		for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			try {
				repairSessionHeader(join(sessionDir, entry.name), oldRoot, newRoot, platform);
			} catch {
				// ready 前尚无日志器；原文件不受失败影响，保留旧 cwd 作为下次修复判据。
			}
		}
	} catch {
		// 无会话目录或暂时不可读，不影响 userData 迁移。
	}
}
