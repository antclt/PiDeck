/**
 * ANSI 净化的唯一实现（2026-09 ANSI 泄漏事故的收口）。
 *
 * pi 的 `Theme.fg()`（以及第三方扩展顺手上的色）产的是**真 ANSI**，透传到界面
 * 就是一行 `[38;2;…m` 乱码。两层能力：`stripAnsiCsi` 只认 CSI 色序（界面正文的
 * 常规清洗，带快速路径），`stripAnsiText` 在此基础上补齐扩展帧里的 pi-tui 清行、
 * OSC 超链接、字符集切换，并做最后一趟裸 ESC 清除（界面上的 ESC 永远是渲染事故）。
 *
 * 纯函数、无 Node/Electron/React 依赖，main / renderer 共用并可单测。
 */

/** 单条 CSI 色序：`ESC [ 参数 字母`。 */
const CSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

/**
 * 只剥 CSI 色序。
 *
 * 快速路径（2027-02 性能审计）：绝大多数模型正文根本不含 ESC 字符，先做单字符
 * includes 扫描（memchr 级，远快于正则）命中即返回原引用——此前流式通道每个
 * delta 都对全量累积文本跑正则 replace（O(N²)/消息的扫描 + 分配），长回复时
 * 主进程持续承压。
 */
export function stripAnsiCsi(text: string): string {
	if (!text.includes("\u001b")) return text;
	return text.replace(CSI_RE, "");
}

const EXTRA_ESCAPE_RE = /\u001b(?:\[[0-9;?<=>!]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[()*+][0-9A-Za-z]|[P^_X][^\u001b]*(?:\u001b\\)?|[@-Z\\-_])/g;

/** 剥掉文本里的全部 ANSI 转义（含 OSC / 字符集切换 / 裸 ESC）。 */
export function stripAnsiText(text: string): string {
	return stripAnsiCsi(text)
		.replace(EXTRA_ESCAPE_RE, "")
		.replace(/\u001b/g, "");
}
