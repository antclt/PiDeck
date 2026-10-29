/**
 * 飞书附件落盘的路径与体量工具（#427 追加一 / 追加二）。
 *
 * 单独成模块的理由：文件名是用户输入（飞书上传时的原始文件名），这里就是路径穿越的边界，
 * 必须有可单测的行为契约；桥接本身依赖 Electron/网络，没法整块单测。
 */

/** 单文件 UX 上限：超过直接回「太大不处理」，不进内存排队。 */
export const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;
/** 暂存附件上限（只发文件不发指令的聊天）：超限提示先发文字指令。 */
export const PENDING_ATTACHMENT_MAX_COUNT = 50;
export const PENDING_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;

/** 允许出现在落盘文件名里的字符：ASCII 字母数字、点、下划线、短横线、CJK 基本区。 */
function isSafeFileNameChar(ch: string): boolean {
	const code = ch.codePointAt(0) ?? 0;
	if (code >= 0x4e00 && code <= 0x9fff) return true;
	if (code >= 0x30 && code <= 0x39) return true;
	if (code >= 0x41 && code <= 0x5a) return true;
	if (code >= 0x61 && code <= 0x7a) return true;
	return ch === "." || ch === "_" || ch === "-";
}

/**
 * 把飞书给的文件名变成可安全拼进临时目录的文件名。
 * - 路径分隔符、控制字符、冒号等一律替换（直接拼接能跳出临时目录）；
 * - 去掉前导点（避免隐藏文件/伪扩展名）；
 * - 只留尾部 120 个字符：扩展名与可辨认部分在尾部，超长名整段保留会顶爆路径长度。
 */
export function safeAttachmentFileName(name: string): string {
	const replaced = Array.from(name)
		.map((ch) => (isSafeFileNameChar(ch) ? ch : "_"))
		.join("");
	let base = replaced;
	while (base.startsWith(".")) base = base.slice(1);
	if (!base) return "attachment";
	return base.slice(-120);
}

/** 给 Agent 看的人类可读大小（整数不带小数：200MB 而不是 200.0MB）。 */
export function formatAttachmentSize(bytes: number): string {
	if (bytes < 1024) return String(bytes) + "B";
	if (bytes < 1024 * 1024) {
		const kb = bytes / 1024;
		return (Number.isInteger(kb) ? String(kb) : kb.toFixed(1)) + "KB";
	}
	const mb = bytes / 1024 / 1024;
	return (Number.isInteger(mb) ? String(mb) : mb.toFixed(1)) + "MB";
}
