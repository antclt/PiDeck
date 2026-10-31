/**
 * 读远端目录页时的**短暂未就绪**重试。
 *
 * 切换项目会让 helper 换 root/重建会话；紧接着发出的首读可能落在 manager 的瞬态
 * （`SSH_HOST_NOT_READY` / `SSH_CONNECTION_FAILED`）。这不是主机真的离线：同一个
 * 项目稍后重读就能成功。把一次瞬态直接画成“需要连接”会让文件树永久停在错误态，
 * 所以这里只对这两个码做有界退避，其它失败立即返回，不掩盖真实断连。
 */

export const REMOTE_DIRECTORY_RETRY_CODES: ReadonlySet<string> = new Set(["SSH_HOST_NOT_READY", "SSH_HOST_CONNECTION_FAILED"]);

export async function readRemoteDirectoryPageWithRetry<T extends { ok: boolean; code?: string }>(read: () => Promise<T>, options: { attempts?: number; sleep: (attempt: number) => Promise<void> }): Promise<T> {
	const attempts = Math.max(1, options.attempts ?? 6);
	let last: T | undefined;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		last = await read();
		if (last.ok || !REMOTE_DIRECTORY_RETRY_CODES.has(last.code ?? "")) return last;
		if (attempt < attempts) await options.sleep(attempt);
	}
	return last as T;
}
