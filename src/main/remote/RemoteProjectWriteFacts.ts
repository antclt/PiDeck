/**
 * 远端文件面写的**事实失效判据**（P0-2 follow-up）。
 *
 * 为什么单独一个模块：文本保存与文件管理两个 IPC 域的写出口都要用同一条判据，而它的正确性直接
 * 关系「面板会不会停在写前」——一处定义、两处引用，不复制。
 *
 * 三类结局：
 * - **成功**：按已知结果路径失效（调用方负责）。
 * - **可能已落地**（结果未知 / 传输中断）：命令可能已经执行，目录与 Git 事实必须与成功的写一样失效；
 *   但写**绝不重放**，只把稳定码交回渲染层。路径按该命令已知的 source/target/relative 传，
 *   不猜远端实际状态。
 * - **明确失败**（入参非法、版本冲突、远端拒绝）：远端没变，不失效。
 *
 * 为什么把连接层的码也算进「可能已落地」：`session.runCommand` 在 helper 换代后直接抛
 * SSH_HOST_NOT_READY，与「会话还没建立」共用同一个码；这里宁可多标脏一次（只换来一次重读），
 * 也不让面板停在旧事实。
 */
import { codeOf, opOutcomeOf } from "../../shared/op";

/** 传输中断：命令可能已经发出（或正在发出），回执不可确认。 */
const INTERRUPTED_WRITE_CODES: ReadonlySet<string> = new Set(["SSH_HOST_DISCONNECTED", "SSH_HOST_NOT_READY", "REMOTE_CONNECTION_LOST", "REQUEST_TIMEOUT"]);

/** 一次写失败的结局是否「可能已落地」：闭集里的 unknown 码，或传输中断。 */
export function isUncertainWrite(error: unknown): boolean {
	const code = codeOf(error, "REMOTE_FILE_COMMAND_FAILED");
	return opOutcomeOf(code) === "unknown" || INTERRUPTED_WRITE_CODES.has(code);
}
