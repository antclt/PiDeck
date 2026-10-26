/**
 * isTextFile — 根据文件扩展名判断是否支持内联编辑/预览。
 *
 * 图片扩展名**不再在这里维护第二份**：从 `imageMime.ts` 派生，否则新加一种图片格式时
 * 会出现「远端能预览、本地打不开」这种半修好的状态（`.avif` 就是这么漏的）。
 */

import { BINARY_IMAGE_EXTENSIONS } from "./imageMime";

const BINARY_EXTENSIONS = new Set([
	"mp3",
	"wav",
	"ogg",
	"flac",
	"m4a",
	"mp4",
	"avi",
	"mkv",
	"mov",
	"webm",
	"zip",
	"tar",
	"gz",
	"bz2",
	"7z",
	"rar",
	"exe",
	"dll",
	"so",
	"dylib",
	"wasm",
	"pdf",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
	"ttf",
	"otf",
	"woff",
	"woff2",
	"eot",
	"o",
	"a",
	"lib",
	"obj",
	"class",
	"pyc",
	"pyo",
	"db",
	"sqlite",
	"sqlite3",
]);

/** 扩展名（不含点，小写）；没有扩展名返回空串。 */
function extensionOf(path: string): string {
	if (!path) return "";
	const name = path.split(/[\/]/).pop() ?? "";
	const index = name.lastIndexOf(".");
	return index <= 0 ? "" : name.slice(index + 1).toLowerCase();
}

/**
 * 根据扩展名判断文件是否二进制（不可在编辑器中编辑）。
 *
 * 图片一律算二进制（它们由 `<img>` 预览，不进文本编辑器），扩展名集合来自 `imageMime.ts`；
 * 其余音视频/压缩包/文档/字体等仍由本文件的集合决定。
 */
export function isBinaryExtension(path: string): boolean {
	const ext = extensionOf(path);
	if (ext === "") return false;
	return BINARY_IMAGE_EXTENSIONS.has(ext) || BINARY_EXTENSIONS.has(ext);
}

/** 判断是否为可内联预览的图片文件（Chromium img 原生解码，无需转码；SVG 是文本，不在此列） */
export function isImageFile(path: string): boolean {
	return BINARY_IMAGE_EXTENSIONS.has(extensionOf(path));
}

/** 判断是否为 PDF 文件（Chromium 内置 PDF viewer 渲染） */
export function isPdfFile(path: string): boolean {
	return extensionOf(path) === "pdf";
}

/** 根据扩展名判断文件是否可在内置编辑器中编辑（非二进制）。 */
export function isTextFile(path: string): boolean {
	return !isBinaryExtension(path);
}
