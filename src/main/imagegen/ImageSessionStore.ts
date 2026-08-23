import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ChatMessage } from "../../shared/types";

/**
 * "Image session" 独立存储：生图记录不依赖 pi 会话文件。
 *
 * 为什么：生图直连供应商 API、不启动 pi agent，纯生图 draft 会话没有 pi 会话文件，
 * persistImageGen 的 filePath 落盘分支会跳过 → 生图历史重启即失（2026-08 用户反馈）。
 * 本存储把 user（含参考图）+ assistant（结果图）消息按渲染层 ChatMessage 结构
 * 逐行写进 userData/imagegen/sessions/<sessionId>.jsonl，重启后由会话读取回退恢复。
 *
 * 设计边界：
 * - 会话有 pi 文件时生图仍写 pi 文件（单一真相）；本存储仅兜底无文件的草稿/孤儿；
 * - sessionId 白名单（UUID）防路径注入；
 * - 同一会话多轮生图按行追加（上限 MAX_MESSAGES，防单会话失控）；
 * - 写失败静默（best-effort：生图结果已在响应里，历史记录尽力而为）。
 */
const SESSION_ID_RE =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** 单会话生图历史行数上限（每轮 2 行：user + assistant）。 */
const MAX_MESSAGES = 2000;

export class ImageSessionStore {
	constructor(private readonly deps: { getStorePath: () => string }) {}

	/** sessionId 白名单校验后映射到存储文件；非法 id 返回 null（防路径注入）。 */
	private fileFor(sessionId: string): string | null {
		if (!SESSION_ID_RE.test(sessionId)) return null;
		return join(this.deps.getStorePath(), `${sessionId}.jsonl`);
	}

	/** 追加一轮生图记录（user + assistant 两条）。白名单外/目录不可写时静默降级。 */
	async append(sessionId: string, messages: ChatMessage[]): Promise<void> {
		const file = this.fileFor(sessionId);
		if (!file || messages.length === 0) return;
		try {
			await mkdir(dirname(file), { recursive: true });
			let lines: string[] = [];
			try {
				lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
			} catch {
				// 首次写入：文件尚不存在
			}
			lines.push(...messages.map((message) => JSON.stringify(message)));
			if (lines.length > MAX_MESSAGES) {
				lines = lines.slice(lines.length - MAX_MESSAGES);
			}
			await writeFile(file, `${lines.join("\n")}\n`, "utf8");
		} catch {
			// best-effort：落盘失败不阻断生图返回（响应已在，历史记录尽力而为）
		}
	}

	/** 读回该会话全部生图记录（损坏行跳过）；文件缺失/非法 id 返回空数组。 */
	async readMessages(sessionId: string): Promise<ChatMessage[]> {
		const file = this.fileFor(sessionId);
		if (!file) return [];
		try {
			const raw = await readFile(file, "utf8");
			const messages: ChatMessage[] = [];
			for (const line of raw.split("\n")) {
				if (!line.trim()) continue;
				try {
					const parsed: unknown = JSON.parse(line);
					if (
						parsed &&
						typeof parsed === "object" &&
						typeof Reflect.get(parsed, "id") === "string" &&
						typeof Reflect.get(parsed, "role") === "string"
					) {
						messages.push(parsed as ChatMessage);
					}
				} catch {
					// 单行损坏不应阻断整段历史
				}
			}
			return messages;
		} catch {
			// 文件缺失 = 无 ImageSession 记录
			return [];
		}
	}
}