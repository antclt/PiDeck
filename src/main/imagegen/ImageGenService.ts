import {
	buildImageGenApiBody,
	imageGenOutputMimeType,
	parseImageGenOutputFormat,
} from "../../shared/imageGenParams";
import type { ImageGenProviderExtraParams } from "../../shared/imageGenConfig";
import type { ImageGenRequest, ImageGenResult } from "../../shared/types/imagegen";

/** 独立生图配置给出的凭据（不再从 models.json 解析） */
export type ProviderCredentials = {
	baseUrl: string;
	apiKey: string;
	extraParams: ImageGenProviderExtraParams;
};

/**
 * 生图服务：调用 OpenAI 兼容的 /images/generations 接口生成图片。
 *
 * 设计要点：
 * - 凭据来自独立 imagegen.json（ImageGenConfigStore），不读 pi models.json。
 * - 请求响应格式固定为 b64_json（结果直接进时间线，不依赖下载通道）；
 *   服务端仅支持 url 时回退下载并转 base64。
 * - extraParams 决定请求体是否带 size / output_format / watermark。
 * - 失败只回结构化错误码（ImageGenErrorCode），文案由渲染层 i18n 映射。
 */
export class ImageGenService {
	constructor(private deps: {
		/** 按生图供应商 id 查 baseUrl/apiKey/extraParams；查不到返回 null（notConfigured） */
		getProviderCredentials: (provider: string) => Promise<ProviderCredentials | null>;
		/** 主进程日志（不记录 apiKey） */
		log: (message: string, ...args: unknown[]) => void;
	}) {}

	/** 生图主入口：供应商凭据缺失直接返回 notConfigured，不发网络请求。 */
	async generate(request: ImageGenRequest): Promise<ImageGenResult> {
		const credentials = await this.deps.getProviderCredentials(request.provider);
		if (!credentials || !credentials.baseUrl.trim() || !credentials.apiKey.trim()) {
			return { ok: false, error: "notConfigured" };
		}
		try {
			const imagesUrl = normalizeImagesUrl(credentials.baseUrl);
			// extraParams 缺省全关：没勾选就不发可选字段，避免未知字段 400
			const extraParams = credentials.extraParams ?? {
				size: false,
				output_format: false,
				watermark: false,
			};
			const outputFormat = extraParams.output_format
				? parseImageGenOutputFormat(request.outputFormat, null)
				: null;
			const body = buildImageGenApiBody({
				model: request.model,
				prompt: request.prompt,
				extraParams,
				size: request.size,
				watermark: request.watermark,
				outputFormat: outputFormat ?? undefined,
			});
			const response = await fetch(
				imagesUrl,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${credentials.apiKey.trim()}`,
					},
					body: JSON.stringify(body),
					// 生图慢（常见 10-60s），用 AbortSignal.timeout 兜底避免挂死
					signal: AbortSignal.timeout(180_000),
				},
			);
			if (!response.ok) {
				this.deps.log("imagegen", "generate failed", { status: response.status });
				return {
					ok: false,
					error: response.status === 401 || response.status === 403
						? "invalidKey"
						: response.status === 404 || response.status === 405
							? "badBaseUrl"
							: "http",
					detail: String(response.status),
				};
			}
			const payload = (await response.json()) as {
				data?: Array<{ b64_json?: string; url?: string }>;
			};
			const item = payload.data?.[0];
			if (item?.b64_json) {
				// b64 无 content-type：只有勾选并发送了 output_format 才按 jpeg/png 标记
				const mimeType = extraParams.output_format
					? imageGenOutputMimeType(outputFormat)
					: "image/png";
				return {
					ok: true,
					image: { type: "image", data: item.b64_json, mimeType },
				};
			}
			if (item?.url) {
				// 服务端不支持 b64_json 时回退下载（url 一般与 baseUrl 同源，直接 fetch）
				const imageResponse = await fetch(item.url, { signal: AbortSignal.timeout(120_000) });
				if (!imageResponse.ok) {
					return { ok: false, error: "network", detail: `image download ${imageResponse.status}` };
				}
				const buffer = Buffer.from(await imageResponse.arrayBuffer());
				const mimeType = imageResponse.headers.get("content-type") ?? "image/png";
				return { ok: true, image: { type: "image", data: buffer.toString("base64"), mimeType } };
			}
			return { ok: false, error: "empty" };
		} catch (error) {
			// 网络不可达/代理失败/超时统一定位为 network（detail 供日志排查，不回传 token）
			const reason = error instanceof Error ? error.message : String(error);
			this.deps.log("imagegen", "generate network error", { reason });
			return { ok: false, error: "network" };
		}
	}
}

/**
 * 归一化生图端点：OpenAI 兼容服务的 images 接口标准路径为 /images/generations，
 * 前缀取决于供应商 baseUrl 的写法：
 * - 已带版本段（/v1、/v1beta、/api、/api/v3 等，规则与 baseUrlPath.hasApiVersionPath
 *   一致）→ 直接追加 /images/generations（火山方舟 /api/v3、Google /v1beta 等
 *   非 OpenAI 风格路径都落这里，不再强行补 /v1）；
 * - 裸根地址（OpenAI 默认风格）→ 补 /v1 再追加；
 * - 用户已配置完整 /images/generations 端点 → 原样使用。
 */
function normalizeImagesUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	if (/\/images\/generations$/i.test(trimmed)) return trimmed;
	if (/\/v\d+(alpha|beta)?$|\/api$/.test(trimmed)) {
		return `${trimmed}/images/generations`;
	}
	return `${trimmed}/v1/images/generations`;
}
