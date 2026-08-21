import { clipboard, nativeImage } from "electron";
import { parseClipboardImageDataUrl } from "../../shared/clipboardImage";
import { fileUrlToPath, parseCfHdrop } from "./clipboardFilePaths";

/** 单张剪贴板图片 data URL 上限，避免异常大图撑爆同步/异步 IPC。 */
export const CLIPBOARD_IMAGE_MAX_CHARS = 25 * 1024 * 1024;

export type ClipboardImageWriteResult = {
	ok: boolean;
	reason?: string;
};

export function readClipboardText(): string {
	try {
		return clipboard.readText() || "";
	} catch {
		return "";
	}
}

export function readClipboardHtml(): string {
	try {
		return clipboard.readHTML() || "";
	} catch {
		return "";
	}
}

/** 读位图槽；无图返回空串。 */
export function readClipboardImageDataUrl(): string {
	try {
		const image = clipboard.readImage();
		return image.isEmpty() ? "" : image.toDataURL();
	} catch {
		return "";
	}
}

/**
 * 把 data URL 写入系统剪贴板位图槽。
 * 必须在主进程执行：Electron 38 起渲染进程/preload 访问 clipboard 已废弃，
 * Windows 上 writeImage 可能静默失败，因此写完再回读确认。
 */
export function writeClipboardImageDataUrl(dataUrl: unknown): ClipboardImageWriteResult {
	if (typeof dataUrl !== "string" || !dataUrl) {
		return { ok: false, reason: "empty-payload" };
	}
	if (dataUrl.length > CLIPBOARD_IMAGE_MAX_CHARS) {
		return { ok: false, reason: "payload-too-large" };
	}
	const parsed = parseClipboardImageDataUrl(dataUrl);
	if (!parsed) return { ok: false, reason: "invalid-data-url" };
	try {
		const image = nativeImage.createFromBuffer(Buffer.from(parsed.base64, "base64"));
		if (image.isEmpty()) return { ok: false, reason: "empty-native-image" };
		clipboard.writeImage(image);
		if (clipboard.readImage().isEmpty()) return { ok: false, reason: "write-not-readable" };
		return { ok: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, reason: `native-exception:${message}` };
	}
}

/**
 * 读取资源管理器「复制文件」的本地路径。
 * 浏览器 ClipboardEvent 通常拿不到 kind=file，粘贴文件引用依赖此 API。
 */
export function readClipboardFilePaths(): string[] {
	try {
		if (process.platform === "win32") {
			try {
				const drop = clipboard.readBuffer("CF_HDROP");
				if (drop && drop.length > 0) {
					const paths = parseCfHdrop(drop);
					if (paths.length > 0) return paths;
				}
			} catch {
				// 部分环境无 CF_HDROP，回退 FileNameW
			}
			if (clipboard.has("FileNameW")) {
				const raw = clipboard.readBuffer("FileNameW").toString("ucs2");
				const path = raw.replace(/\0/g, "").trim();
				if (path) return [path];
			}
			return [];
		}

		if (process.platform === "darwin") {
			const url = clipboard.read("public.file-url");
			if (url) {
				const path = fileUrlToPath(url);
				return path ? [path] : [];
			}
			return [];
		}

		if (clipboard.has("text/uri-list")) {
			const text = clipboard.read("text/uri-list");
			return text
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line.startsWith("file://") && !line.startsWith("#"))
				.map(fileUrlToPath)
				.filter(Boolean);
		}
		if (clipboard.has("x-special/gnome-copied-files")) {
			const text = clipboard.read("x-special/gnome-copied-files");
			return text
				.split(/\r?\n/)
				.slice(1)
				.map((line) => line.trim())
				.filter((line) => line.startsWith("file://"))
				.map(fileUrlToPath)
				.filter(Boolean);
		}
	} catch {
		// 剪贴板格式不可用时静默失败，回退为普通文本粘贴
	}
	return [];
}
