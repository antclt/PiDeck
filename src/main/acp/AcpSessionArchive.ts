/**
 * ACP 会话归档：把投影消息按 acpSessionId 落盘到 deck 数据目录（userData/acp-sessions）。
 *
 * 为什么需要这一层：ACP 历史此前只活在 agent CLI 侧 + 进程内内存快照
 * （AcpMessageSnapshotStore：LRU 32 会话 × 400 条，重启即清）。重开历史会话只能靠
 * CLI 的 session/load 重放；换机器、清 ~/.codebuddy 之后 CLI 存档没了历史就永久丢失，
 * 会话内查找（Ctrl/Cmd+Shift+F）也没有任何检索源。这里存一份 deck 自己的 JSON 快照：
 * 重启后仍能读回，检索有稳定输入。
 *
 * 硬约束（每条都在防「归档把主功能搞坏」）：
 * - 单会话有界：≤ ACP_ARCHIVE_MAX_MESSAGES 条 / ≤ ACP_ARCHIVE_MAX_BYTES 字节；超出
 *   从头截断，并把被丢掉的条数记进 truncatedFrom（读回时可判断不是全量）。
 * - 原子写：同目录临时文件 + rename，崩在写盘中途也不会留下半截 JSON；并发写各用
 *   独立临时名，任何时刻磁盘上都是一份完整快照（后写入者胜）。
 * - 失败只记日志：save/read 都不抛，归档坏掉不影响会话本身与 IPC 返回。
 * - 损坏/半截/非 JSON 读回降级为空数组：历史读不到是「没有历史」，不是错误。
 * - 空快照不写盘：投影为空的分支（load 重放为空等）绝不能把已有归档清成空。
 * - base64 不进归档：images[].data 落盘前剔除，只保留 ref 形态（AGENTS.md「生图存储」
 *   同源契约——内联 base64 会瞬间吃光字节预算，且跨进程也展示不了）。
 * - 路径安全：文件名是 sha1(acpSessionId)。sessionId 由外部 CLI 产生（可能含 / \ ..），
 *   裸拼路径会穿越目录；写入前再校验目标目录确实在 userData 下（fail-closed）。
 *
 * 写盘时机由调用方（AcpAgentManager）负责：只在回合结算后与 stop()/stopAll() 写，
 * 不挂 80ms 流式 flush——那里每次都写会持续吃 IO，且中间态没有任何读者。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ChatMessage, ImageContent } from "../../shared/types/session";

/** 单会话归档条数上限：正常长会话远用不到，超出的部分是「不会再看的历史」。 */
export const ACP_ARCHIVE_MAX_MESSAGES = 2000;
/** 单会话归档字节上限（8 MiB）：4096 条工具卡片也到不了，真正防的是异常巨型正文。 */
export const ACP_ARCHIVE_MAX_BYTES = 8 * 1024 * 1024;

/** 归档目录名（userData 下的固定子目录）。 */
const ARCHIVE_DIR_NAME = "acp-sessions";
/** 归档格式版本：字段将来变更时靠它做读取兼容（旧版本数据必须仍能读出）。 */
const ARCHIVE_VERSION = 1;
/** 信封预留：version/acpSessionId/updatedAt/truncatedFrom 等固定字段的字节开销。 */
const ENVELOPE_RESERVE_BYTES = 1024;

const CHAT_ROLES: ReadonlySet<string> = new Set(["user", "assistant", "tool", "system", "error"]);

export type AcpSessionArchiveLogger = {
	warn(channel: string, message: string, meta?: Record<string, unknown>): void;
};

export type AcpSessionArchiveDeps = {
	/** deck 数据根（app.getPath("userData")）；归档固定落在其 acp-sessions/ 子目录。 */
	userDataDir: string;
	/** 写/读失败只记日志（缺省静默）：归档不得影响会话与 IPC 返回。 */
	logger?: AcpSessionArchiveLogger;
};

/** 落盘信封：messages 之外只留排查/兼容用元数据，读取侧只消费 messages。 */
type AcpSessionArchivePayload = {
	version: number;
	acpSessionId: string;
	updatedAt: number;
	/** 从头部截断掉的条数（缺省 0 = 完整快照）。 */
	truncatedFrom?: number;
	messages: ChatMessage[];
};

export class AcpSessionArchive {
	/**
	 * 写入串行链：回合结算与 stop() 可能相邻触发两次写。单次写用原子 rename 本身不会
	 * 撕裂，但并发下落地顺序不定（旧快照可能后落地）；排队保证「后入队的内容最后落地」。
	 */
	private writeChain: Promise<void> = Promise.resolve();

	constructor(private readonly deps: AcpSessionArchiveDeps) {}

	/**
	 * 排队写盘（管理器用的入口）：同一实例内串行，失败只记日志、不抛。
	 * 消息在入队时切一份快照：调用方随后继续投影（下一回合）不会改到本次写入内容。
	 */
	enqueueSave(acpSessionId: string, messages: ReadonlyArray<ChatMessage>): Promise<void> {
		if (!acpSessionId) return Promise.resolve();
		const snapshot = messages.slice();
		const run = this.writeChain.then(() => this.save(acpSessionId, snapshot));
		// 兜底：save 内部已 catch，这里再兜一层，防止 unexpected rejection 卡死后续写入。
		this.writeChain = run.catch(() => undefined);
		return this.writeChain;
	}

	/** 归档目录绝对路径（userData/acp-sessions）。 */
	get dir(): string {
		return join(this.deps.userDataDir, ARCHIVE_DIR_NAME);
	}

	/**
	 * 单会话归档文件路径：sha1 命名，sessionId 不进路径（见文件头「路径安全」）。
	 * 与 session-store 的 tables/<sha1>.table 同口径，排查时能用同一套哈希对照。
	 */
	filePathFor(acpSessionId: string): string {
		return join(this.dir, `${sha1(acpSessionId)}.json`);
	}

	/**
	 * 落盘一份会话快照（失败只记日志，不抛）。
	 *
	 * 调用点只允许「回合结算后」与 stop()/stopAll()：那里投影已 settle、内容稳定，
	 * 且是一回合一次的写入频率；流式中间态不写（见文件头）。
	 */
	async save(acpSessionId: string, messages: ReadonlyArray<ChatMessage>): Promise<void> {
		if (!acpSessionId) return;
		// 空快照不写盘（「有内容 → 空投影」的护栏）。风险链：会话有 loadSession 能力时握手走
		// session/load（不播种快照，投影从空开始），若 CLI 返回成功但重放为空、或迟到 update
		// 还没到，回合结算/stop() 会把原本有内容的归档清成空 —— 下次重启历史就彻底没了。
		// 空归档没有任何信息量，少写一次的代价远小于删掉用户历史。
		if (messages.length === 0) return;
		let tmpPath: string | undefined;
		try {
			await this.ensureArchiveDir();
			const file = this.filePathFor(acpSessionId);
			// 二次校验：目录校验与文件写之间目录可能被替换（软链/异常配置），写前再确认一次。
			if (!isInside(this.deps.userDataDir, file)) throw new Error("ACP archive path escaped userData directory");
			tmpPath = `${file}.${process.pid}-${randomUUID()}.tmp`;
			await writeFile(tmpPath, JSON.stringify(buildPayload(acpSessionId, messages)), "utf8");
			// rename 在同一卷上是原子的：读者要么看到旧快照，要么看到新快照，不会看到半截。
			await rename(tmpPath, file);
			tmpPath = undefined;
		} catch (error) {
			this.deps.logger?.warn("acp", "ACP session archive write failed", { acpSessionId, error: describeError(error) });
		} finally {
			// 临时文件残留会逐渐吃盘：任何失败路径都清掉（成功路径已 rename，force 忽略 ENOENT）。
			if (tmpPath) await rm(tmpPath, { force: true }).catch(() => undefined);
		}
	}

	/**
	 * 读回一份归档；任何失败（文件缺失/损坏/半截/非 JSON/权限）一律返回空数组。
	 * 不抛的原因：调用方是时间线回读与会话内检索，历史读不到应当退化成「没有历史」，
	 * 而不是让一次 IPC 失败或把异常透给渲染层。
	 */
	async read(acpSessionId: string): Promise<ChatMessage[]> {
		if (!acpSessionId) return [];
		let raw: string;
		try {
			raw = await readFile(this.filePathFor(acpSessionId), "utf8");
		} catch (error) {
			// ENOENT = 还没归档过（正常路径，不必刷警告）；其余读失败记一次日志留证据。
			if (!isMissingFileError(error)) {
				this.deps.logger?.warn("acp", "ACP session archive read failed", { acpSessionId, error: describeError(error) });
			}
			return [];
		}
		const messages = parseArchivedMessages(raw);
		if (!messages) {
			// 半截/非 JSON：按「没有历史」降级，下一次结算会重写覆盖掉坏文件。
			this.deps.logger?.warn("acp", "ACP session archive ignored corrupt payload", { acpSessionId, bytes: raw.length });
			return [];
		}
		return messages;
	}

	/**
	 * 归档目录的解析 + 逃逸检查 + 惰性创建。
	 * userDataDir 是外部注入的（单测用临时目录），必须在这里确认写盘位置没跑出根目录。
	 */
	private async ensureArchiveDir(): Promise<string> {
		const root = this.deps.userDataDir;
		if (!root || !root.trim()) throw new Error("ACP archive requires a userData directory");
		const dir = this.dir;
		if (!isInside(root, dir)) throw new Error("ACP archive directory escaped userData path");
		await mkdir(dir, { recursive: true });
		return dir;
	}
}

/** sha1 十六进制：路径安全的会话指纹（外部 id 可能含分隔符/盘符/..）。 */
function sha1(value: string): string {
	return createHash("sha1").update(value, "utf8").digest("hex");
}

/**
 * 逃逸检查：解析后必须落在根目录内（根自身或子路径）。
 * 先 resolve 归一（相对片段、多余分隔符），再补分隔符做前缀比较——否则
 * `C:\data-evil` 会被 `C:\data` 前缀误判为内部路径。
 */
function isInside(root: string, target: string): boolean {
	const resolvedRoot = resolve(root);
	const resolvedTarget = resolve(target);
	if (resolvedTarget === resolvedRoot) return true;
	const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
	return resolvedTarget.startsWith(prefix);
}

/** 组装落盘信封：先剔 base64，再按条数/字节双上限截断。 */
function buildPayload(acpSessionId: string, messages: ReadonlyArray<ChatMessage>): AcpSessionArchivePayload {
	const bounded = boundMessages(stripInlineImageData(messages));
	return {
		version: ARCHIVE_VERSION,
		acpSessionId,
		updatedAt: Date.now(),
		...(bounded.truncatedFrom > 0 ? { truncatedFrom: bounded.truncatedFrom } : {}),
		messages: bounded.messages,
	};
}

/**
 * 条数 + 字节双上限：先按条数切片（最便宜），再从尾部累积单条序列化字节到预算内。
 * 超预算的条目一律从头丢弃——归档是「最近可读历史」，宁可少存也不能撑爆磁盘；
 * truncatedFrom 记录被丢掉的条数（含条数上限那部分），读回侧据此知道不是全量。
 * 边界：单条正文本身就超预算时整份归档为空（不截断正文——正文截断等于改内容）。
 */
function boundMessages(messages: ReadonlyArray<ChatMessage>): { messages: ChatMessage[]; truncatedFrom: number } {
	const countTrimmed = Math.max(0, messages.length - ACP_ARCHIVE_MAX_MESSAGES);
	let kept = messages.slice(countTrimmed);
	const budget = ACP_ARCHIVE_MAX_BYTES - ENVELOPE_RESERVE_BYTES;
	let bytes = 0;
	let start = kept.length;
	while (start > 0) {
		const size = Buffer.byteLength(JSON.stringify(kept[start - 1]), "utf8");
		if (bytes + size > budget) break;
		bytes += size;
		start -= 1;
	}
	const byteTrimmed = start;
	if (byteTrimmed > 0) kept = kept.slice(byteTrimmed);
	return { messages: kept, truncatedFrom: countTrimmed + byteTrimmed };
}

/**
 * 剔除内联 base64 图片（AGENTS.md「生图存储」：base64 不进持久化文件，只存 ref）。
 * 规则：
 * - 已有 ref 的图只保留 ref 形态（data 一并丢掉，同一张图不存两份）；
 * - 只有 data、没有 ref 的图整条丢弃——归档里既展示不了（没有协议可解析的 ref），
 *   又会把 8 MiB 预算一次吃光；内存投影仍保留 base64，只是不落盘。
 * 没有内联 data 的消息原样返回（不复制对象，避免每条消息都造新引用）。
 */
function stripInlineImageData(messages: ReadonlyArray<ChatMessage>): ReadonlyArray<ChatMessage> {
	const out: ChatMessage[] = [];
	for (const message of messages) {
		const images = message.images;
		if (!images?.length || !images.some((image) => typeof image.data === "string")) {
			out.push(message);
			continue;
		}
		const keptImages: ImageContent[] = [];
		for (const image of images) {
			const ref = image.ref;
			if (typeof ref !== "string" || !ref) continue;
			keptImages.push({ type: "image", mimeType: image.mimeType, ref });
		}
		out.push(keptImages.length > 0 ? { ...message, images: keptImages } : { ...message, images: undefined });
	}
	return out;
}

/**
 * 解析归档 JSON。返回 null = 整个文件不可用（半截/非 JSON/结构不符），调用方降级为空。
 * 单条消息形状不符只跳过那一条：一条坏数据不该让整段历史消失。
 */
function parseArchivedMessages(raw: string): ChatMessage[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || !("messages" in parsed)) return null;
	const messages = parsed.messages;
	if (!Array.isArray(messages)) return null;
	const out: ChatMessage[] = [];
	for (const entry of messages) {
		if (isArchivedMessage(entry)) out.push(entry);
	}
	return out;
}

/** 单条消息形状校验：只要求读回侧真正消费的字段可信，其余字段原样透传。 */
function isArchivedMessage(value: unknown): value is ChatMessage {
	if (value === null || typeof value !== "object") return false;
	if (!("id" in value) || typeof value.id !== "string" || !value.id) return false;
	if (!("role" in value) || typeof value.role !== "string" || !CHAT_ROLES.has(value.role)) return false;
	if (!("text" in value) || typeof value.text !== "string") return false;
	if (!("timestamp" in value) || typeof value.timestamp !== "number") return false;
	if (!("agentId" in value) || typeof value.agentId !== "string") return false;
	return true;
}

/** ENOENT 判定（不引 fs.constants 的类型噪音；跨 Realm 也按 message/code 读）。 */
function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
