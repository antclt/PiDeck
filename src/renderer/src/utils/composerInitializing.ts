/**
 * ACP 选中会话即后台预热：spawn + 握手（session/load 或 session/new）期间
 * runtime 为 starting，configOptions 尚未下发。输入框据此显示初始化指示并锁发送，
 * 但**不能**锁编辑器——预热不能抢走用户正在输入的焦点（见 composerPrewarmFocus 测试）。
 *
 * pi 有 standby 池、DSH 是常驻 host，两者的 starting 都是毫秒级且不阻塞发送；
 * 只有 ACP 需要这段等待态。
 */
export function isAcpComposerInitializing(isAcpBackend: boolean, runtimeStatus: string | undefined): boolean {
	return isAcpBackend && runtimeStatus === "starting";
}
