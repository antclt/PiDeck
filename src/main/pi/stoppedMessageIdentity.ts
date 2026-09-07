import { createHash } from "node:crypto";
import type { ChatMessage } from "../../shared/types";

export type StoppedMessageIdentity = {
	entryId?: string;
	role: "user" | "assistant";
	timestamp: number;
	fingerprint: string;
};

/** 内容只用于停止前后的身份核对；摘要避免缓存多份长文本和图片，也不做模糊匹配。 */
export function stoppedMessageFingerprint(message: ChatMessage): string {
	const hash = createHash("sha256");
	hash.update(JSON.stringify([message.role, message.text]));
	for (const image of message.images ?? []) {
		hash.update(JSON.stringify([image.mimeType, image.data]));
	}
	return hash.digest("hex");
}

/**
 * 停止会清空 runtime 消息，但编辑确认框仍可能持有 live ID。
 * 仅留下受限的身份摘要供 catalog 定位，不保留消息正文或已停止的 runtime。
 */
export class StoppedMessageIdentityCache {
	private readonly sessions = new Map<string, Map<string, StoppedMessageIdentity>>();
	private static readonly MAX_SESSIONS = 32;
	private static readonly MAX_MESSAGES = 256;

	/** 以规范化后的会话文件路径隔离身份；只保存 UI 可编辑的消息。 */
	capture(sessionPath: string, messages: readonly ChatMessage[]): void {
		const identities = new Map<string, StoppedMessageIdentity>();
		for (const message of messages.slice(-StoppedMessageIdentityCache.MAX_MESSAGES)) {
			if (message.role !== "user" && message.role !== "assistant") continue;
			identities.set(message.id, {
				entryId: typeof message.meta?.entryId === "string" ? message.meta.entryId : undefined,
				role: message.role,
				timestamp: message.timestamp,
				fingerprint: stoppedMessageFingerprint(message),
			});
		}
		this.sessions.delete(sessionPath);
		this.sessions.set(sessionPath, identities);
		while (this.sessions.size > StoppedMessageIdentityCache.MAX_SESSIONS) {
			const oldest = this.sessions.keys().next().value;
			if (oldest !== undefined) this.sessions.delete(oldest);
		}
	}

	/** 同一会话中读取摘要；文件读者还须校验活动分支，不能据缓存直接改盘。 */
	get(sessionPath: string, messageId: string): StoppedMessageIdentity | undefined {
		return this.sessions.get(sessionPath)?.get(messageId);
	}

	/** 应用退出时与 runtime 缓存一起释放。 */
	clear(): void {
		this.sessions.clear();
	}
}
