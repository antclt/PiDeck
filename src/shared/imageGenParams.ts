import type { ImageGenProviderExtraParams } from "./imageGenConfig";
import { DEFAULT_IMAGE_GEN_EXTRA_PARAMS } from "./imageGenConfig";

/**
 * 生图可选参数：OpenAI Images 与火山方舟都走同一套 OpenAI 兼容 /images/generations。
 *
 * 是否发送某个字段由供应商 extraParams 决定（用户在生图配置里勾选），
 * 不再按 URL / API 类型猜测。官方字段名：size、output_format、watermark。
 * output_format 是文件编码（png/jpeg），与运输层 response_format=b64_json（本服务写死）不是一回事。
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

/** 底栏「不设置」：请求体不带 size，交给模型默认。不能用空字符串（Radix Select 禁止 empty value）。 */
export const IMAGE_GEN_SIZE_UNSET = "unset";
/** 默认不指定分辨率，避免把 1024x1024 强加给只认 2K/4K 的模型。 */
export const DEFAULT_IMAGE_GEN_SIZE = IMAGE_GEN_SIZE_UNSET;
/** 用户显式选择；不跟火山官方默认 true，避免没开开关却带水印。 */
export const DEFAULT_IMAGE_GEN_WATERMARK = false;

export const IMAGE_GEN_OUTPUT_FORMATS = ["png", "jpeg"] as const;
export type ImageGenOutputFormat = (typeof IMAGE_GEN_OUTPUT_FORMATS)[number];
/** 默认 png：与现有 b64 mime/复制保存路径一致；火山 5.0 官方默认常为 jpeg。 */
export const DEFAULT_IMAGE_GEN_OUTPUT_FORMAT: ImageGenOutputFormat = "png";

const PIXEL_SIZE_RE = /^\d{2,5}x\d{2,5}$/;
const VOLC_SCALE_RE = /^[1-4]K$/i;

/** 解析生图尺寸：unset / 空 = 不发送；预设、1K/2K/4K，或 宽x高。非法返回 null。 */
export function parseImageGenSize(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.toLowerCase() === IMAGE_GEN_SIZE_UNSET) return IMAGE_GEN_SIZE_UNSET;
	if (trimmed.length > 16) return null;
	if (VOLC_SCALE_RE.test(trimmed)) return trimmed.toUpperCase();
	if (PIXEL_SIZE_RE.test(trimmed)) return trimmed;
	return null;
}

/** 写入请求体的 size：unset 视为未指定。 */
export function resolveImageGenApiSize(value: unknown): string | undefined {
	const parsed = parseImageGenSize(value);
	if (!parsed || parsed === IMAGE_GEN_SIZE_UNSET) return undefined;
	return parsed;
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

function resolveExtraParams(
	extraParams?: Partial<ImageGenProviderExtraParams> | null,
): ImageGenProviderExtraParams {
	return {
		size: extraParams?.size === true,
		output_format: extraParams?.output_format === true,
		watermark: extraParams?.watermark === true,
	};
}

/** 组装 OpenAI 兼容 /images/generations JSON body（不含鉴权）。 */
export function buildImageGenApiBody(input: {
	model: string;
	prompt: string;
	extraParams?: Partial<ImageGenProviderExtraParams> | null;
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
	const extra = resolveExtraParams(input.extraParams ?? DEFAULT_IMAGE_GEN_EXTRA_PARAMS);
	// 只发用户勾选的官方字段，避免中转/OpenAI 因未知字段 400
	if (extra.size) {
		const size = resolveImageGenApiSize(input.size);
		if (size) body.size = size;
	}
	if (extra.watermark && typeof input.watermark === "boolean") {
		body.watermark = input.watermark;
	}
	if (extra.output_format) {
		const outputFormat = parseImageGenOutputFormat(input.outputFormat, null);
		if (outputFormat) body.output_format = outputFormat;
	}
	return body;
}
