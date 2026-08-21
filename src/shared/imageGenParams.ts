/**
 * 生图可选参数：兼容 OpenAI Images 与火山方舟 Seedream（/api/v3/images/generations）。
 *
 * - size：两边都认。OpenAI 用 WxH（如 1024x1024）；火山额外认 1K/2K/4K。
 * - watermark / output_format：火山方舟字段。OpenAI 官方会因未知字段 400，
 *   因此只在 Ark 风格端点上发送。output_format 是文件编码（png/jpeg），
 *   与运输层 response_format=b64_json（本服务写死）不是一回事。
 */

export const IMAGE_GEN_SIZE_PRESETS = [
	"1024x1024",
	"1024x1536",
	"1536x1024",
	"1024x1792",
	"1792x1024",
	"2048x2048",
	"1K",
	"2K",
	"4K",
] as const;

export type ImageGenSizePreset = (typeof IMAGE_GEN_SIZE_PRESETS)[number];

export const DEFAULT_IMAGE_GEN_SIZE: ImageGenSizePreset = "1024x1024";
/** 用户显式选择；不跟火山官方默认 true，避免没开开关却带水印。 */
export const DEFAULT_IMAGE_GEN_WATERMARK = false;

export const IMAGE_GEN_OUTPUT_FORMATS = ["png", "jpeg"] as const;
export type ImageGenOutputFormat = (typeof IMAGE_GEN_OUTPUT_FORMATS)[number];
/** 默认 png：与现有 b64 mime/复制保存路径一致；火山 5.0 官方默认常为 jpeg。 */
export const DEFAULT_IMAGE_GEN_OUTPUT_FORMAT: ImageGenOutputFormat = "png";

const PIXEL_SIZE_RE = /^\d{2,5}x\d{2,5}$/;
const VOLC_SCALE_RE = /^[1-4]K$/i;

/** 解析生图尺寸：预设、1K/2K/4K，或 宽x高（每边 10–99999）。非法返回 null。 */
export function parseImageGenSize(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 16) return null;
	if (VOLC_SCALE_RE.test(trimmed)) return trimmed.toUpperCase();
	if (PIXEL_SIZE_RE.test(trimmed)) return trimmed;
	return null;
}

export function parseImageGenWatermark(
	value: unknown,
	fallback = DEFAULT_IMAGE_GEN_WATERMARK,
): boolean {
	return typeof value === "boolean" ? value : fallback;
}

export function parseImageGenOutputFormat(
	value: unknown,
	fallback: ImageGenOutputFormat | null = DEFAULT_IMAGE_GEN_OUTPUT_FORMAT,
): ImageGenOutputFormat | null {
	if (typeof value !== "string") return fallback;
	const normalized = value.trim().toLowerCase();
	const jpg = normalized === "jpg" ? "jpeg" : normalized;
	if ((IMAGE_GEN_OUTPUT_FORMATS as readonly string[]).includes(jpg)) {
		return jpg as ImageGenOutputFormat;
	}
	return fallback;
}

export function imageGenOutputMimeType(format: ImageGenOutputFormat | null | undefined): string {
	return format === "jpeg" ? "image/jpeg" : "image/png";
}

/**
 * 火山方舟（及走 /api/v3 的兼容网关）才带 watermark / output_format。
 * OpenAI / 多数纯 OpenAI 中转不认识这些字段。
 */
export function imageGenEndpointSupportsArkFields(baseUrl: string): boolean {
	const url = baseUrl.trim();
	if (!url) return false;
	return /\/api\/v3(\/|$)/i.test(url) || /volces\.com|volcengine\.com|ark\.cn-/i.test(url);
}

/** 组装 OpenAI 兼容 /images/generations JSON body（不含鉴权）。 */
export function buildImageGenApiBody(input: {
	model: string;
	prompt: string;
	baseUrl: string;
	size?: string;
	watermark?: boolean;
	outputFormat?: string;
}): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: input.model.trim(),
		prompt: input.prompt,
		n: 1,
		// 运输层固定 b64_json：结果直接进时间线，不依赖 24h url 下载
		response_format: "b64_json",
	};
	const size = parseImageGenSize(input.size);
	if (size) body.size = size;
	const ark = imageGenEndpointSupportsArkFields(input.baseUrl);
	// 只在 Ark 兼容端点带火山字段，避免 OpenAI 官方因未知字段 400
	if (ark && typeof input.watermark === "boolean") {
		body.watermark = input.watermark;
	}
	const outputFormat = parseImageGenOutputFormat(input.outputFormat, null);
	if (ark && outputFormat) body.output_format = outputFormat;
	return body;
}
