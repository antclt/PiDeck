import {
	buildImageGenApiBody,
	buildImageGenEditsForm,
	imageGenOutputMimeType,
	parseImageGenOutputFormat,
} from "../../shared/imageGenParams";
import type {
	ImageGenApiStyle,
	ImageGenProviderExtraParams,
	ImageGenReferenceMode,
} from "../../shared/imageGenConfig";
import type { ImageGenRequest, ImageGenResult } from "../../shared/types/imagegen";

/** 独立生图配置给出的凭据（不再从 models.json 解析） */
export type ProviderCredentials = {
	baseUrl: string;
	apiKey: string;
	extraParams: ImageGenProviderExtraParams;
	/** 参考图输入方式；缺省 none */
	referenceMode?: ImageGenReferenceMode;
	/** 接口方言（字段名/响应结构）；缺省 openai */
	apiStyle?: ImageGenApiStyle;
};

/**
 * 生图服务：调用 OpenAI 兼容的 /images/generations 接口生成图片。
 *
 * 设计要点：
 * - 凭据来自独立 imagegen.json（ImageGenConfigStore），不读 pi models.json。
 * - 请求响应格式固定为 b64_json（结果直接进时间线，不依赖下载通道）；
 *   服务端仅支持 url 时回退下载并转 base64。
 * - extraParams 决定请求体是否带 size / output_format / watermark。
 * - 失败回结构化错误码（ImageGenErrorCode）+ detail：detail 带 HTTP 状态码和厂商错误正文
 *   （已脱敏、截断），文案由渲染层 i18n 映射。
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
			// 参考图门禁：供应商声明 none/未声明时直接拒绝，避免把图发给不认的接口白扣费
			const refs = request.referenceImages ?? [];
			const referenceMode = credentials.referenceMode ?? "none";
			if (refs.length > 0 && referenceMode === "none") {
				return { ok: false, error: "referenceUnsupported" };
			}
			let response: Response;
			if (refs.length > 0 && referenceMode === "edits") {
				// OpenAI gpt-image-1 风格：multipart 到 /images/edits；响应结构与 generations 一致
				response = await fetch(
					normalizeImagesEditsUrl(credentials.baseUrl),
					{
						method: "POST",
						headers: { Authorization: `Bearer ${credentials.apiKey.trim()}` },
						body: buildImageGenEditsForm({
							model: request.model,
							prompt: request.prompt,
							images: refs,
							extraParams,
							size: request.size,
						}),
						signal: AbortSignal.timeout(180_000),
					},
				);
			} else {
				// 方言与参考图形态：image-field 时参考图并入 JSON body，builder 按方言组装
				// （openai/方舟 → dataURI 数组；siliconflow → 首张单 dataURI string）
				const body = buildImageGenApiBody({
					model: request.model,
					prompt: request.prompt,
					extraParams,
					size: request.size,
					watermark: request.watermark,
					outputFormat: outputFormat ?? undefined,
					apiStyle: credentials.apiStyle ?? "openai",
					referenceImages:
						refs.length > 0 && referenceMode === "image-field" ? refs : undefined,
				});
				response = await fetch(
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
			}
			if (!response.ok) {
				const detail = await readHttpErrorDetail(response);
				this.deps.log("imagegen", "generate failed", { status: response.status, detail });
				return {
					ok: false,
					error: response.status === 401 || response.status === 403
						? "invalidKey"
						: response.status === 404 || response.status === 405
							? "badBaseUrl"
							: "http",
					detail,
				};
			}
			const payload = (await response.json()) as {
				data?: Array<{ b64_json?: string; url?: string }>;
				// SiliconFlow 方言：响应是 images[].url（无 data 数组、无 b64_json）
				images?: Array<{ url?: string }>;
			};
			// 通用兜底：OpenAI/方舟读 data[0]，硅基读 images[0]，不依赖方言判断
			const item: { b64_json?: string; url?: string } | undefined =
				payload.data?.[0] ?? payload.images?.[0];
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

/** 读取失败响应体上限：避免把超大 HTML 错误页塞进 IPC。 */
const IMAGE_GEN_ERROR_BODY_LIMIT = 4000;
/** 回传渲染层的 detail 上限（状态码 + 厂商文案）。 */
const IMAGE_GEN_ERROR_DETAIL_LIMIT = 800;

/**
 * 从厂商非 2xx 响应里抽出可读 detail。
 * 业务规则：用户要看到拒绝原因（审核、尺寸、额度），不能只回 HTTP 状态码；
 * 同时不能把 API Key / 超长 HTML 原样丢进时间线。
 */
async function readHttpErrorDetail(response: {
	status: number;
	text: () => Promise<string>;
}): Promise<string> {
	let body = "";
	try {
		body = await response.text();
	} catch {
		body = "";
	}
	if (body.length > IMAGE_GEN_ERROR_BODY_LIMIT) {
		body = body.slice(0, IMAGE_GEN_ERROR_BODY_LIMIT);
	}
	const vendor = redactSecrets(extractVendorErrorText(body)).trim();
	if (!vendor) return String(response.status);
	const combined = `${response.status}: ${vendor}`;
	return combined.length > IMAGE_GEN_ERROR_DETAIL_LIMIT
		? `${combined.slice(0, IMAGE_GEN_ERROR_DETAIL_LIMIT)}…`
		: combined;
}

function extractVendorErrorText(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return collectVendorErrorPieces(parsed).join(" · ");
	} catch {
		// 非 JSON（HTML/纯文本）时压成单行，避免把整页错误 HTML 铺进气泡。
		return trimmed.replace(/\s+/g, " ");
	}
}

function collectVendorErrorPieces(value: unknown): string[] {
	if (typeof value === "string") {
		const text = value.trim();
		return text ? [text] : [];
	}
	if (typeof value !== "object" || value === null) return [];
	const pieces: string[] = [];
	const errorField = Reflect.get(value, "error");
	if (typeof errorField === "string") {
		pushIfText(pieces, errorField);
	} else if (typeof errorField === "object" && errorField !== null) {
		pushIfText(pieces, Reflect.get(errorField, "message"));
		pushIfText(pieces, Reflect.get(errorField, "msg"));
		pushIfText(pieces, Reflect.get(errorField, "code"));
		pushIfText(pieces, Reflect.get(errorField, "type"));
	}
	pushIfText(pieces, Reflect.get(value, "message"));
	pushIfText(pieces, Reflect.get(value, "msg"));
	pushIfText(pieces, Reflect.get(value, "code"));
	// Gemini 等会把补充原因放在 details[]
	const details = Reflect.get(value, "details");
	if (Array.isArray(details)) {
		for (const item of details) {
			if (typeof item === "string") {
				pushIfText(pieces, item);
				continue;
			}
			if (typeof item === "object" && item !== null) {
				pushIfText(pieces, Reflect.get(item, "message"));
				pushIfText(pieces, Reflect.get(item, "reason"));
			}
		}
	}
	return uniquePreserve(pieces);
}

function pushIfText(out: string[], value: unknown): void {
	if (typeof value === "string" && value.trim()) out.push(value.trim());
}

function uniquePreserve(items: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of items) {
		if (seen.has(item)) continue;
		seen.add(item);
		out.push(item);
	}
	return out;
}

/** 错误正文里偶发夹带 key，回传前打码，避免进时间线/日志。 */
function redactSecrets(text: string): string {
	return text
		.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
		.replace(/(api[_-]?key|authorization|bearer)\s*[:=]\s*["']?[^"'\s,]+/gi, "$1=***");
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

/** edits 端点：与 generations 同规则推导，仅路径换成 /images/edits；用户已配完整 generations 路径时替换尾段。 */
function normalizeImagesEditsUrl(baseUrl: string): string {
	return normalizeImagesUrl(baseUrl).replace(/\/images\/generations$/i, "/images/edits");
}
