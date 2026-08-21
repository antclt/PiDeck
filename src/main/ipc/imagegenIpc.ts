/**
 * 生图 IPC 域：只做入参校验与装配，业务在 ImageGenService。
 * 通道：imagegen:generate（shared/ipc.ts 定义）。
 *
 * 复用 pi 已配置的模型供应商：按 provider 从 models.json（providers[].baseUrl/apiKey）
 * 与 auth.json（[provider].key）拼出 baseUrl/apiKey，不新增独立生图配置。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import {
	DEFAULT_IMAGE_GEN_OUTPUT_FORMAT,
	DEFAULT_IMAGE_GEN_WATERMARK,
	parseImageGenOutputFormat,
	parseImageGenSize,
	parseImageGenWatermark,
} from "../../shared/imageGenParams";
import type { ConfigManager } from "../config/ConfigManager";
import type { ImageGenService } from "../imagegen/ImageGenService";

export function registerImageGenIpc(deps: {
	imageGen: ImageGenService;
	configManager: ConfigManager;
	log: (message: string, ...args: unknown[]) => void;
	/** 可选：生图成功后把 user+assistant 消息落盘到指定会话（pi 会话文件）。 */
	persistImageGen?: (input: {
		sessionId: string;
		provider: string;
		model: string;
		prompt: string;
		image: { data: string; mimeType: string };
	}) => Promise<void>;
}) {
	const { imageGen, configManager, log, persistImageGen } = deps;

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
		} | null;
		const provider = typeof candidate?.provider === "string" ? candidate.provider.trim() : "";
		const model = typeof candidate?.model === "string" ? candidate.model.trim() : "";
		const prompt = typeof candidate?.prompt === "string" ? candidate.prompt.trim() : "";
		const sessionId = typeof candidate?.sessionId === "string" ? candidate.sessionId.trim() : "";
		const size = parseImageGenSize(candidate?.size) ?? undefined;
		const watermark = parseImageGenWatermark(candidate?.watermark, DEFAULT_IMAGE_GEN_WATERMARK);
		const outputFormat = parseImageGenOutputFormat(candidate?.outputFormat, DEFAULT_IMAGE_GEN_OUTPUT_FORMAT) ?? undefined;
		if (!provider || !model || !prompt || prompt.length > 4000) {
			return { ok: false, error: "http", detail: "invalid request" } as const;
		}
		const result = await imageGen.generate({ provider, model, prompt, size, watermark, outputFormat });
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

/**
 * 按供应商名从 models.json / auth.json 拼出凭据（baseUrl + apiKey）。
 * baseUrl 优先取 providers[].baseUrl，其次 providers[].api（部分中转站字段名）；
 * apiKey 优先取 providers[].apiKey，其次 auth.json[].key。两者缺一返回 null。
 */
export async function resolveProviderCredentials(
	configManager: ConfigManager,
	provider: string,
): Promise<{ baseUrl: string; apiKey: string } | null> {
	const models = await configManager.getModelsConfig();
	const auth = await configManager.getAuthConfig();
	const providerConfig = models.parsed.providers[provider];
	const baseUrl = (providerConfig?.baseUrl ?? providerConfig?.api ?? "").trim();
	const authKey = typeof auth.parsed[provider]?.key === "string" ? auth.parsed[provider].key : "";
	const apiKey = (providerConfig?.apiKey ?? authKey).trim();
	if (!baseUrl || !apiKey) return null;
	return { baseUrl, apiKey };
}
