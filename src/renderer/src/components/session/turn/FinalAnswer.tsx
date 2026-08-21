import { Download, Copy, Check, ChevronDown } from "lucide-react";
import { memo, type RefObject, useState } from "react";
import type { ChatMessage, ImageContent } from "../../../../../shared/types";
import type { ImageGenMeta } from "../../../../../shared/types/imagegen";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../ui-shadcn/dropdown-menu";
import { Textarea } from "../../ui-shadcn/textarea";
import { ImageGeneration } from "../../agents/image-generation";
import { AssistantText } from "../SurfaceComponents";
import { writeClipboardImage } from "../../../utils/clipboard";
import { showNotice } from "../../../utils/notice";

/** 收窄 meta.imageGen（消息数据来自历史会话/缓存，需运行时校验而非盲转）。 */
function isImageGenMeta(value: unknown): value is ImageGenMeta {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		(v.status === "generating" || v.status === "complete" || v.status === "error") &&
		typeof v.prompt === "string"
	);
}

/**
 * 生图消息渲染：随 meta.imageGen.status 在「生成中点阵动画 → 图片清晰过渡 → 失败态」间切换。
 * 复用 beUI ImageGeneration（canvas 点阵 + motion 过渡），完成态图片支持点击放大预览。
 */
function ImageGenMessage(props: {
	meta: ImageGenMeta;
	images?: ImageContent[];
	onPreviewImage: (image: ImageContent) => void;
}) {
	const [copied, setCopied] = useState(false);
	const status = props.meta.status;
	const statusText =
		status === "generating"
			? t("imagegen.status.generating")
			: status === "complete"
				? t("imagegen.status.complete")
				: t("imagegen.status.error");
	const image = props.images?.[0];
	// 部分生图 provider 返回 application/octet-stream，但 data 仍是 PNG/JPEG base64；
	// 不能因此让复制入口把有效图片误判为非图片，展示/复制统一使用图片 MIME 兜底。
	const imageMimeType = image?.mimeType.startsWith("image/") ? image.mimeType : "image/png";
	const imageDataUrl = image ? `data:${imageMimeType};base64,${image.data}` : "";
	const sizeMatch = props.meta.size?.match(/^(\d+)x(\d+)$/i);
	const resolution = sizeMatch ? `${sizeMatch[1]} × ${sizeMatch[2]}` : props.meta.size;
	const aspectRatio = sizeMatch ? `${sizeMatch[1]} / ${sizeMatch[2]}` : undefined;
		const copyImage = async () => {
			try {
				// 不使用 fetch(data:...)：data URL 会被 CSP 当作网络连接拦截。
				// 统一走 writeClipboardImage，避免 Electron 失焦时 ClipboardItem 静默失败。
				if (!imageDataUrl) throw new Error("Generated image is empty");
				const written = await writeClipboardImage(imageDataUrl);
				if (!written) throw new Error("Unable to write generated image to clipboard");
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1600);
			} catch {
				showNotice(t("imagegen.copyFailed"), 2000, "error");
			}
		};
		const saveImage = () => {
			if (!imageDataUrl || !image) return;
			const link = document.createElement("a");
			link.href = imageDataUrl;
			// 扩展名跟 mime，避免 jpeg 结果被存成 .png
			const ext = image.mimeType === "image/jpeg" ? "jpg" : "png";
			link.download = `pideck-image-${Date.now()}.${ext}`;
			link.click();
		};
	return (
		<div className="py-1">
			<ImageGeneration
				status={status}
				prompt={props.meta.prompt}
				statusText={statusText}
				resolution={resolution}
				aspectRatio={aspectRatio}
				size="fluid"
				className="max-w-[300px]"
			>
				{status === "complete" && image ? (
					<img
						src={imageDataUrl}
						alt=""
						className="cursor-zoom-in"
						onClick={() => props.onPreviewImage(image)}
					/>
				) : undefined}
			</ImageGeneration>
			{status === "complete" && image ? (
				<div className="mt-1 flex items-center">
					{/* 主按钮和下拉菜单共用同一套图片动作，避免生图消息再显示普通文本复制栏。 */}
					<div className="flex items-center overflow-hidden rounded-sm border border-transparent hover:border-border">
						<Button variant="ghost" size="icon-sm" className="size-7 rounded-none text-muted-foreground hover:bg-muted hover:text-foreground" type="button" onClick={() => void copyImage()} title={t("imagegen.copy")} aria-label={t("imagegen.copy")}>
							{copied ? <Check size={14} /> : <Copy size={14} />}
						</Button>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="icon-sm" className="size-6 rounded-none border-l border-border/60 px-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" type="button" aria-label={t("copy.moreOptions")} title={t("copy.moreOptions")}>
									<ChevronDown size={12} />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start" className="copy-menu-popover min-w-[132px]">
								<DropdownMenuItem onSelect={() => void copyImage()}>{t("imagegen.copy")}</DropdownMenuItem>
								<DropdownMenuItem onSelect={saveImage}>{t("imagegen.save")}</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>
			) : null}
			{status === "error" && props.meta.errorDetail ? (
				<p className="mt-1.5 max-w-[36rem] whitespace-pre-wrap break-words text-xs leading-relaxed text-destructive">
					{props.meta.errorDetail}
				</p>
			) : null}
		</div>
	);
}

/**
 * 最终回答段：本轮最后一条 assistant 文本，常驻、永不折叠。
 * 承载原地编辑 UI（编辑入口在 run 操作栏，编辑表单内联在此）。
 */
export const FinalAnswer = memo(function FinalAnswer(props: {
	message: ChatMessage;
	images?: ImageContent[];
	isStreaming?: boolean;
	/** live→settled 交接淡入 */
	settle?: boolean;
	/** 编辑态 */
	editing: boolean;
	editText: string;
	editAreaRef: RefObject<HTMLDivElement | null>;
	onEditTextChange: (text: string) => void;
	onStartEdit: () => void;
	onCancelEdit: () => void;
	onSaveEdit: () => void;
	onPreviewImage: (image: ImageContent) => void;
	onOpenExternal: (url: string) => void;
	onOpenFile?: (path: string) => void;
}) {
	if (props.editing) {
		return (
			<div
				className="flex flex-col gap-2 rounded-md border border-border-subtle bg-[color:color-mix(in_srgb,var(--color-accent)_3%,var(--color-bg-panel))] pl-2"
				ref={props.editAreaRef}
			>
				<div className="flex items-center gap-1 text-xs font-medium text-[var(--color-accent)] before:content-['✎'] before:text-sm">
					{t("common.edit")}
				</div>
				<Textarea
					className="min-h-[100px] max-h-[400px] w-full resize-y rounded-sm border border-[var(--color-accent)] bg-bg-panel p-2 font-mono text-sm leading-relaxed text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[0_0_0_2px_var(--focus-ring)]"
					value={props.editText}
					onChange={(e) => props.onEditTextChange(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
							e.preventDefault();
							props.onSaveEdit();
						}
						if (e.key === "Escape") props.onCancelEdit();
					}}
					autoFocus
				/>
				<div className="flex justify-end gap-2">
					<Button
						variant="outline"
						size="sm"
						className="h-auto border-[var(--color-accent)] px-3 py-1 text-xs text-[var(--color-accent)] shadow-none hover:text-[var(--color-accent)]"
						onClick={props.onSaveEdit}
					>
						{t("common.save")}
					</Button>
					<Button
						variant="outline"
						size="sm"
						className="h-auto px-3 py-1 text-xs shadow-none"
						onClick={props.onCancelEdit}
					>
						{t("common.cancel")}
					</Button>
				</div>
			</div>
		);
	}
	// 生图消息：不渲染 markdown 正文，改渲染 beUI ImageGeneration（点阵动画→图片→失败态）。
	const imageGenMeta = isImageGenMeta(props.message.meta?.imageGen)
		? props.message.meta.imageGen
		: undefined;
	if (imageGenMeta) {
		return (
			<ImageGenMessage
				meta={imageGenMeta}
				images={props.images}
				onPreviewImage={props.onPreviewImage}
			/>
		);
	}
	return (
		<AssistantText
			text={props.message.text}
			images={props.images}
			onPreviewImage={props.onPreviewImage}
			onOpenExternal={props.onOpenExternal}
			onOpenFile={props.onOpenFile}
			isStreaming={props.isStreaming ?? false}
			settle={props.settle}
		/>
	);
});
