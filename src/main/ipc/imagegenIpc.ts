/**
 * 生图 IPC 域：只做入参校验与装配。
 * 通道：imagegen:generate / imagegen:get-config / imagegen:save-config。
 *
 * 凭据来自独立 ImageGenConfigStore（userData/imagegen.json），不读 pi models.json。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import {
	DEFAULT_IMAGE_GEN_OUTPUT_FORMAT,
	DEFAULT_IMAGE_GEN_WATERMARK,
	parseImageGenOutputFormat,
	parseImageGenReferenceImages,
	parseImageGenSize,
	parseImageGenWatermark,
} from "../../shared/imageGenParams";
import type { ImageGenService } from "../imagegen/ImageGenService";
import type { ImageGenConfigStore } from "../imagegen/ImageGenConfigStore";

export function registerImageGenIpc(deps: {
	imageGen: ImageGenService;
	imageGenConfig: ImageGenConfigStore;
	log: (message: string, ...args: unknown[]) => void;
	/** 可选：生图成功后把 user+assistant 消息落盘到指定会话（pi 会话文件）。 */
	persistImageGen?: (input: {
		sessionId: string;
		provider: string;
		model: string;
		prompt: string;
		image: { data: string; mimeType: string };
		size?: string;
	}) => Promise<void>;
}) {
	const { imageGen, imageGenConfig, log, persistImageGen } = deps;

	ipcMain.handle(ipcChannels.imagegenGetConfig, async () => imageGenConfig.getConfig());

	ipcMain.handle(ipcChannels.imagegenSaveConfig, async (_event, input: unknown) => {
		const result = await imageGenConfig.saveConfig(input);
		log("imagegen", "config save", {
			ok: result.ok,
			providers: result.ok ? result.config.providers.length : undefined,
		});
		return result;
	});

	ipcMain.handle(ipcChannels.imagegenGenerate, async (_event, input: unknown) => {
		// 渲染层数据不可信：必填字段必须是有限长度非空字符串；size/watermark 非法则丢弃回默认。
		const candidate = input as {
			provider?: unknown;
			model?: unknown;
			prompt?: unknown;
			sessionId?: unknown;
			size?: unknown;
			watermark?: unknown;
			outputFormat?: unknown;
			referenceImages?: unknown;
		} | null;
		const provider = typeof candidate?.provider === "string" ? candidate.provider.trim() : "";
		const model = typeof candidate?.model === "string" ? candidate.model.trim() : "";
		const prompt = typeof candidate?.prompt === "string" ? candidate.prompt.trim() : "";
		const sessionId = typeof candidate?.sessionId === "string" ? candidate.sessionId.trim() : "";
		const size = parseImageGenSize(candidate?.size) ?? undefined;
		const watermark = parseImageGenWatermark(candidate?.watermark, DEFAULT_IMAGE_GEN_WATERMARK);
		const outputFormat = parseImageGenOutputFormat(candidate?.outputFormat, DEFAULT_IMAGE_GEN_OUTPUT_FORMAT) ?? undefined;
		// 参考图：整体校验（数量/mime/base64 体积），非法直接拒绝，不让脏数据进网络层
		const referenceImages = parseImageGenReferenceImages(candidate?.referenceImages) ?? undefined;
		if (!model || !prompt || prompt.length > 4000) {
			return { ok: false, error: "http", detail: "invalid request" } as const;
		}
		const result = await imageGen.generate({ provider, model, prompt, size, watermark, outputFormat, referenceImages });
		if (!result.ok) {
			log("imagegen", "generate rejected", { error: result.error, provider });
			return result;
		}
		// 落盘失败只记日志，不阻断生图成功返回（图片已在响应里，历史记录是尽力而为）。
		if (persistImageGen && sessionId) {
			try {
				await persistImageGen({
					sessionId,
					provider,
					model,
					prompt,
					image: result.image,
					size,
				});
			} catch (error) {
				log("imagegen", "persist to session failed", {
					sessionId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return result;
	});
}
