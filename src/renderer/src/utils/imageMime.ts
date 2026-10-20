/**
 * 文件扩展名 → 图片 MIME 的唯一映射（远端项目预览与差异查看器共用）。
 *
 * 为什么单独成模块：同一张映射以前只活在 `FileDiffViewer` 里，远端文件预览如果各写一份，
 * 「差异里能看图、文件面板里打不开」这种不一致会反复出现。
 */

const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	ico: "image/x-icon",
	avif: "image/avif",
};

/**
 * SVG 单独处理：它是 **UTF-8 文本**，必须留在可编辑通道里（本地编辑器就是这么做的）。
 * 把它当图片分流会让远端 `.svg` 失去源码视图——那是净能力损失，不是优化。
 */
const SVG_MIME = "image/svg+xml";

/** 小写扩展名（不含点）；没有扩展名返回空串。 */
function extensionOf(path: string): string {
	const name = path.split(/[\\/]/).at(-1) ?? "";
	const index = name.lastIndexOf(".");
	return index <= 0 ? "" : name.slice(index + 1).toLowerCase();
}

/**
 * 路径是**二进制图片**时返回 MIME，否则 undefined（调用方据此决定走文本还是图片通道）。
 * SVG 不在此列：它按文本编辑（见 `SVG_MIME` 的注释）。
 */
export function imageMimeForPath(path: string): string | undefined {
	return IMAGE_MIME_BY_EXT[extensionOf(path)];
}

/**
 * 差异/预览里当作 Blob 类型用：SVG 也给正确的 `image/svg+xml`（此时走的是 data-URL 预览，
 * 不是编辑器分流），其余未知类型统一 `application/octet-stream`（Chromium 按内容解码）。
 */
export function imageMimeOrBinary(path: string): string {
	if (extensionOf(path) === "svg") return SVG_MIME;
	return imageMimeForPath(path) ?? "application/octet-stream";
}
