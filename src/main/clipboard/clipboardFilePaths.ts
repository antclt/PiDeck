/**
 * 解析资源管理器「复制文件」剪贴板格式，得到本地路径列表。
 * 必须在主进程调用 Electron clipboard（Electron 38 已废弃渲染进程/preload 直连 clipboard）。
 */

/** 解析 Windows CF_HDROP：DROPFILES 头 20 字节后是以双空结尾的路径列表。 */
export function parseCfHdrop(buffer: Buffer): string[] {
	if (buffer.length < 20) return [];
	const pFiles = buffer.readUInt32LE(0);
	const fWide = buffer.readUInt32LE(16) !== 0;
	if (pFiles <= 0 || pFiles >= buffer.length) return [];

	const paths: string[] = [];
	let offset = pFiles;
	if (fWide) {
		// UTF-16LE：条目以 \0\0 分隔，列表以 \0\0\0\0 结束
		while (offset + 2 <= buffer.length) {
			let end = offset;
			while (end + 1 < buffer.length && !(buffer[end] === 0 && buffer[end + 1] === 0)) {
				end += 2;
			}
			if (end === offset) break;
			paths.push(buffer.toString("utf16le", offset, end));
			offset = end + 2;
		}
	} else {
		while (offset < buffer.length) {
			let end = offset;
			while (end < buffer.length && buffer[end] !== 0) end++;
			if (end === offset) break;
			paths.push(buffer.toString("utf8", offset, end));
			offset = end + 1;
		}
	}
	return paths.map((p) => p.trim()).filter(Boolean);
}

/** 将 file:// URI 转为本地路径（兼容 Windows 盘符与 URL 编码）。 */
export function fileUrlToPath(uri: string): string {
	const trimmed = uri.trim();
	if (!trimmed) return "";
	let path = trimmed.replace(/^file:\/\//i, "");
	// Windows: /C:/Users/... → C:/Users/...
	if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
	try {
		path = decodeURIComponent(path);
	} catch {
		// 保留原始字符串
	}
	return path;
}
