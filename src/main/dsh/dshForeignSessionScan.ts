import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { DshForeignSessionItem } from "./dshForeignSync";

/**
 * 从 DSH_HOME 磁盘只读扫描外部根会话（不启动 host、不 attach、不写文件）。
 *
 * 为什么不走 host `sessions.list` / `sessions.history`：
 * - DSH 官方不支持同一 DSH_HOME 双 host；PiDeck 再 fork 会写 `.pideck-host.lock`，
 *   并对冷会话打 history（相当于 attach），会把 dsh-web 正在用的 session log 抢走/覆盖。
 * - 用户要的是「启动侧栏就有会话」，不是「先把 host 拉起来再手动导入」。
 *
 * 布局与 `@deepseek-ai/dsh-session-persistence-jsonl` 一致：
 * `$DSH_HOME/sessions/<workspaceDir>/<sessionId>/session.jsonl.zstd`（或未压缩 `.jsonl`）。
 * 只读 header 帧/首行：`{ type:'session', id, cwd?, origin?, parentSession?, delegationDepth? }`。
 */

/** 与 dsh-session-persistence-jsonl 相同的 Zstandard magic（小端 0xFD2FB528）。 */
const ZSTD_MAGIC = 4_247_762_216;
/** header 帧极小（实测 ~169B）；超过此上限视为损坏/非标准，跳过以免读整段日志。 */
const HEADER_READ_LIMIT = 64 * 1024;

/** 磁盘 header 的最小字段（只取过滤/归属需要的）。 */
export type ScannedDshSessionHeader = {
	id: string;
	cwd?: string;
	origin?: string;
	parentSession?: string;
	delegationDepth?: number;
	/** 日志文件 mtime（ms）；list 投影没有 title 时当 updatedAt）。 */
	updatedAt: number;
};

/**
 * 根会话判定（与 DshHost.listForeignSessions 的 host 过滤对齐）：
 * subagent / 带 parent / delegationDepth>0 都不是用户侧栏该直接打开的「外部会话」。
 */
export function isForeignRootSession(header: ScannedDshSessionHeader): boolean {
	if (header.origin === "subagent") return false;
	if (header.parentSession) return false;
	if ((header.delegationDepth ?? 0) > 0) return false;
	return Boolean(header.id);
}

/** 扫描 DSH_HOME/sessions 下全部带合法 header 的会话（含子代理；只读）。 */
export function scanDshSessionHeaders(dshHome: string): ScannedDshSessionHeader[] {
	const sessionsRoot = join(dshHome, "sessions");
	if (!existsSync(sessionsRoot)) return [];
	let workspaceDirs: string[];
	try {
		workspaceDirs = readdirSync(sessionsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
	const found: ScannedDshSessionHeader[] = [];
	for (const workspaceDir of workspaceDirs) {
		const workspacePath = join(sessionsRoot, workspaceDir);
		let sessionDirs: string[];
		try {
			sessionDirs = readdirSync(workspacePath, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
		} catch {
			continue;
		}
		for (const sessionDir of sessionDirs) {
			const header = readSessionHeader(join(workspacePath, sessionDir));
			if (header) found.push(header);
		}
	}
	return found;
}

/** 外部根会话清单（catalog 映射用）：磁盘扫描 + 根会话过滤。 */
export function listForeignSessionsFromDisk(dshHome: string): DshForeignSessionItem[] {
	return scanDshSessionHeaders(dshHome)
		.filter(isForeignRootSession)
		.map((header) => ({
			dshSessionId: header.id,
			...(header.cwd ? { cwd: header.cwd } : {}),
			updatedAt: header.updatedAt,
		}));
}

/** 读单个会话目录的 header；优先 zstd，其次未压缩 jsonl。读失败/损坏返回 undefined。 */
function readSessionHeader(sessionDir: string): ScannedDshSessionHeader | undefined {
	const zstdPath = join(sessionDir, "session.jsonl.zstd");
	if (existsSync(zstdPath)) return readZstdHeader(zstdPath);
	const jsonlPath = join(sessionDir, "session.jsonl");
	if (existsSync(jsonlPath)) return readJsonlHeader(jsonlPath);
	return undefined;
}

function readZstdHeader(filePath: string): ScannedDshSessionHeader | undefined {
	const prefix = readFilePrefix(filePath, HEADER_READ_LIMIT);
	if (!prefix) return undefined;
	const frameEnd = firstZstdFrameEnd(prefix.bytes);
	if (frameEnd === undefined) return undefined;
	try {
		const plain = zstdDecompressSync(prefix.bytes.subarray(0, frameEnd));
		return parseHeaderLine(plain.toString("utf8"), prefix.mtimeMs);
	} catch {
		return undefined;
	}
}

function readJsonlHeader(filePath: string): ScannedDshSessionHeader | undefined {
	const prefix = readFilePrefix(filePath, HEADER_READ_LIMIT);
	if (!prefix) return undefined;
	return parseHeaderLine(prefix.bytes.toString("utf8"), prefix.mtimeMs);
}

/** 只读文件前缀 + mtime（不把整段会话日志读进内存）。 */
function readFilePrefix(
	filePath: string,
	limit: number,
): { bytes: Buffer; mtimeMs: number } | undefined {
	let fd: number | undefined;
	try {
		const stat = statSync(filePath);
		if (!stat.isFile() || stat.size <= 0) return undefined;
		fd = openSync(filePath, "r");
		const bytes = Buffer.alloc(Math.min(limit, stat.size));
		const n = readSync(fd, bytes, 0, bytes.length, 0);
		if (n <= 0) return undefined;
		return { bytes: bytes.subarray(0, n), mtimeMs: stat.mtimeMs };
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch { /* 关闭失败不阻断扫描 */ }
		}
	}
}

/**
 * 定位第一个完整 Zstandard frame 的结尾（与 persistence-jsonl `scanZstdFrames(..., 1)` 同构）。
 * 帧不完整或 magic 不对返回 undefined——调用方跳过该会话，绝不截断/修复文件。
 */
export function firstZstdFrameEnd(buffer: Buffer): number | undefined {
	if (buffer.length < 5) return undefined;
	if (buffer.readUInt32LE(0) !== ZSTD_MAGIC) return undefined;
	let offset = 4;
	const descriptor = buffer.readUInt8(offset);
	offset += 1;
	if ((descriptor & 24) !== 0) return undefined;
	const contentSizeFlag = descriptor >>> 6;
	const singleSegment = (descriptor & 32) !== 0;
	const checksum = (descriptor & 4) !== 0;
	const dictionaryFlag = descriptor & 3;
	const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
	const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
	const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
	if (buffer.length - offset < remainingHeaderBytes) return undefined;
	offset += remainingHeaderBytes;
	for (;;) {
		if (buffer.length - offset < 3) return undefined;
		const blockHeader = buffer.readUIntLE(offset, 3);
		offset += 3;
		const lastBlock = (blockHeader & 1) !== 0;
		const blockType = (blockHeader >>> 1) & 3;
		const blockSize = blockHeader >>> 3;
		if (blockType === 3) return undefined;
		const payloadBytes = blockType === 1 ? 1 : blockSize;
		if (buffer.length - offset < payloadBytes) return undefined;
		offset += payloadBytes;
		if (lastBlock) break;
	}
	if (checksum) {
		if (buffer.length - offset < 4) return undefined;
		offset += 4;
	}
	return offset;
}

/** 解析 header 行：第一行必须是 `type: session` 且带 id；其余字段按可选处理。 */
export function parseHeaderLine(text: string, updatedAt: number): ScannedDshSessionHeader | undefined {
	const line = text.split(/\r?\n/, 1)[0]?.trim();
	if (!line) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const record = parsed as Record<string, unknown>;
	if (record.type !== "session" || typeof record.id !== "string" || !record.id.trim()) {
		return undefined;
	}
	return {
		id: record.id.trim(),
		updatedAt,
		...(typeof record.cwd === "string" && record.cwd ? { cwd: record.cwd } : {}),
		...(typeof record.origin === "string" && record.origin ? { origin: record.origin } : {}),
		...(typeof record.parentSession === "string" && record.parentSession
			? { parentSession: record.parentSession }
			: {}),
		...(typeof record.delegationDepth === "number" && Number.isFinite(record.delegationDepth)
			? { delegationDepth: record.delegationDepth }
			: {}),
	};
}
