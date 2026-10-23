/**
 * Wallpaper Engine 视频壁纸（第一期）：主进程与渲染层共用的纯数据契约。
 *
 * 只读取用户本机工坊目录（steamapps/workshop/content/431960/<id>/project.json），
 * 只保留 title/type/file/preview 四个字段，且只接受 type === "video"。
 * scene（scene.pkg 私有格式）、application（外部 exe）、web（第三方 HTML/JS）一律不收。
 * 视频字节只经 pideck-we:// 协议流式交给 <video>，不进 IPC；渲染层只拿工坊 ID。
 */

/** 协议名：渲染层 <video src="pideck-we://video/<id>"> */
export const WALLPAPER_ENGINE_PROTOCOL = "pideck-we";

/** 工坊条目 ID 白名单：Steam 工坊 ID 为纯数字。协议与 IPC 都按此校验，杜绝路径拼接。 */
export const WALLPAPER_ENGINE_ID_RE = /^\d{1,20}$/;

/** 第一期只放行的视频扩展名 → MIME */
const VIDEO_MIME_BY_EXT: Record<string, string> = {
	mp4: "video/mp4",
	webm: "video/webm",
	m4v: "video/mp4",
};

/** 列表项：project.json 解析后渲染层可见的全部信息（不含任何绝对路径）。 */
export interface WallpaperEngineItem {
	id: string;
	title: string;
	type: "video";
	/** 相对条目目录的视频文件名 */
	file: string;
	/** 相对条目目录的预览图文件名（可能为空） */
	preview: string;
}

/** list 通道结果：目录未设置/不可读时 items 为空并带 error 码。 */
export interface WallpaperEngineListResult {
	dir: string;
	items: WallpaperEngineItem[];
	error?: "no-dir" | "unreadable";
}

/** 条目内相对路径：禁止绝对路径、反斜杠逃逸、.. 段与空段。 */
export function isSafeRelativeFile(file: string): boolean {
	if (!file || file.length > 255) return false;
	if (/^[\\/]/.test(file) || /^[a-zA-Z]:/.test(file) || file.includes("\0")) return false;
	return file.split(/[\\/]/).every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

export function wallpaperEngineVideoMime(file: string): string | null {
	const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
	return VIDEO_MIME_BY_EXT[ext] ?? null;
}

/**
 * 解析 project.json 文本 → 视频条目；非 video、字段缺失、路径不安全、扩展名不在白名单均返回 null。
 * 只挑四个字段，其余（general.properties、workshopid 等）全部丢弃。
 */
export function parseWallpaperEngineProject(id: string, raw: string): WallpaperEngineItem | null {
	if (!WALLPAPER_ENGINE_ID_RE.test(id)) return null;
	let data: unknown;
	try {
		data = JSON.parse(stripWallpaperEngineJsonNoise(raw));
	} catch {
		return null;
	}
	if (!data || typeof data !== "object") return null;
	const obj = data as Record<string, unknown>;
	const type = typeof obj.type === "string" ? obj.type.toLowerCase() : "";
	if (type !== "video") return null;
	const file = typeof obj.file === "string" ? obj.file : "";
	if (!isSafeRelativeFile(file) || !wallpaperEngineVideoMime(file)) return null;
	const previewRaw = typeof obj.preview === "string" ? obj.preview : "";
	const preview = isSafeRelativeFile(previewRaw) ? previewRaw : "";
	const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim().slice(0, 200) : id;
	return { id, title, type: "video", file, preview };
}

/** 渲染层用的视频 URL；ID 不合法时返回空串（调用方据此不渲染） */
export function wallpaperEngineVideoUrl(id: string): string {
	return WALLPAPER_ENGINE_ID_RE.test(id) ? `${WALLPAPER_ENGINE_PROTOCOL}://video/${id}` : "";
}

/** 预览图 URL（同协议 preview 主机） */
export function wallpaperEnginePreviewUrl(id: string): string {
	return WALLPAPER_ENGINE_ID_RE.test(id) ? `${WALLPAPER_ENGINE_PROTOCOL}://preview/${id}` : "";
}

/** 解析单区间 Range（与 pideck-video 行为一致：bytes=s-e / s- / -n，多区间回退整文件）。 */
export function parseByteRange(header: string | null, size: number): { start: number; end: number } | null {
	if (!header || size <= 0) return null;
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!m) return null;
	const [, s, e] = m;
	if (s === "" && e === "") return null;
	if (s === "") {
		const n = Number(e);
		if (!Number.isFinite(n) || n <= 0) return null;
		return { start: Math.max(0, size - n), end: size - 1 };
	}
	const start = Number(s);
	const end = e === "" ? size - 1 : Number(e);
	if (!Number.isFinite(start) || start >= size || !Number.isFinite(end) || end < start) return null;
	return { start, end: Math.min(end, size - 1) };
}

/**
 * 部分工坊条目的 project.json 头部带 UTF-8 BOM、尾部带 NUL 填充（编辑器/打包工具留下的），
 * 直接 JSON.parse 会抛错导致条目被静默丢弃。只剥头部 BOM 与尾部 NUL/空白，不碰中间内容。
 */
export function stripWallpaperEngineJsonNoise(raw: string): string {
	return raw.replace(/^\uFEFF/, "").replace(/[\0\s]+$/, "");
}
