/**
 * WebComposer — Web 端消息输入区（与桌面 ComposerArea 的 composer-box 同风格）。
 *
 * 复用桌面 .composer / .composer-box 样式类 + shadcn Button：
 * - textarea 由 .composer textarea 统一样式（透明底、内边距、随内容撑高）
 * - Enter 发送、Shift/Ctrl+Enter 换行
 * - 图片附件：文件选择 + 粘贴，发送前经 webImageCompress 压缩（P2）
 * - 提示词库：内嵌 WebPromptPicker，选中后回填 draft（P2）
 * - prefill：重发（prepare-resend）/提示词插入时由父级填充文本，nonce 变化触发
 * - 无会话时禁用；流式期间提交按钮转为停止
 */
import { useEffect, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { Button } from "@/components/ui-shadcn/button";
import { t } from "@/i18n";
import { compressImageToDataUrl, imagesFromPasteEvent } from "./webImageCompress";
import { WebPromptPicker } from "./WebPromptPicker";

/** 单会话图片上限（压缩后每张约 100–300KB，4 张足够多数场景且 body 可控）。 */
const MAX_ATTACHED_IMAGES = 4;

export function WebComposer(props: {
	disabled: boolean;
	streaming: boolean;
	/** 提交时携带的图片（data URL，已压缩）；父级在 onSend 后清空自己的附件态。 */
	onSend: (text: string, images: string[]) => void;
	onStop: () => void;
	/** 父级驱动的预填充（重发 / 提示词插入）；nonce 变化才生效，避免重复触发。 */
	prefill?: { text: string; nonce: number };
}) {
	const [draft, setDraft] = useState("");
	const [images, setImages] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [attachError, setAttachError] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const lastPrefillNonce = useRef<number>(-1);

	useEffect(() => {
		const prefill = props.prefill;
		if (!prefill || prefill.nonce === lastPrefillNonce.current) return;
		lastPrefillNonce.current = prefill.nonce;
		setDraft(prefill.text);
		textareaRef.current?.focus();
	}, [props.prefill]);

	const addFiles = async (files: File[]) => {
		const picks = files.filter((file) => file.type.startsWith("image/")).slice(0, MAX_ATTACHED_IMAGES);
		if (picks.length === 0) return;
		setBusy(true);
		setAttachError(false);
		try {
			const encoded = await Promise.all(picks.map((file) => compressImageToDataUrl(file)));
			setImages((prev) => [...prev, ...encoded].slice(0, MAX_ATTACHED_IMAGES));
		} catch {
			setAttachError(true);
		} finally {
			setBusy(false);
		}
	};

	const submit = () => {
		const text = draft.trim();
		if ((!text && images.length === 0) || props.disabled || props.streaming || busy) return;
		props.onSend(text, images);
		setDraft("");
		setImages([]);
	};

	return (
		<form
			className="composer w-full min-w-0 flex-col gap-2 bg-background px-3 pb-3"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<div className="composer-box relative flex min-h-[7rem] min-w-0 flex-col overflow-visible rounded-xl border border-border bg-card text-card-foreground shadow-sm transition-[border-color,box-shadow,background-color]">
				{images.length > 0 ? (
					<div className="flex flex-wrap gap-2 px-3 pt-3">
						{images.map((src, index) => (
							<span key={`${index}-${src.slice(-24)}`} className="relative inline-block size-14 overflow-hidden rounded-md border border-border">
								<img src={src} alt={t("web.messageImage")} className="size-full object-cover" />
								<button type="button" aria-label={t("web.removeImage")} className="absolute top-0.5 right-0.5 rounded-full bg-background/80 p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground" onClick={() => setImages((prev) => prev.filter((_, position) => position !== index))}>
									<X className="size-3" aria-hidden="true" />
								</button>
							</span>
						))}
					</div>
				) : null}
				<textarea
					id="prompt"
					ref={textareaRef}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onPaste={(event) => {
						const pasted = imagesFromPasteEvent(event.nativeEvent as ClipboardEvent);
						if (pasted.length > 0) {
							event.preventDefault();
							void addFiles(pasted);
						}
					}}
					placeholder={t("web.promptPlaceholder")}
					disabled={props.disabled}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
							event.preventDefault();
							submit();
						}
					}}
					aria-label={t("web.promptPlaceholder")}
				/>
				{attachError ? <div className="px-3 text-micro text-danger">{t("web.imageAttachFailed")}</div> : null}
				<div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2.5">
					<span className="flex min-w-0 items-center gap-1.5">
						<input
							ref={fileInputRef}
							type="file"
							accept="image/*"
							multiple
							className="hidden"
							onChange={(event) => {
								const files = Array.from(event.target.files ?? []);
								void addFiles(files);
								event.target.value = "";
							}}
						/>
						<Button type="button" variant="ghost" size="sm" className="h-7 w-7 shrink-0 p-0 text-muted-foreground" disabled={props.disabled || busy || images.length >= MAX_ATTACHED_IMAGES} title={t("web.attachImage")} aria-label={t("web.attachImage")} onClick={() => fileInputRef.current?.click()}>
							<ImagePlus className="size-3.5" aria-hidden="true" />
						</Button>
						<WebPromptPicker disabled={props.disabled} onPick={(content) => setDraft((prev) => (prev ? `${prev}\n\n${content}` : content))} />
						<span className="composer-hint min-w-0 truncate text-caption text-muted-foreground">{t("web.composerHint")}</span>
					</span>
					{props.streaming ? (
						<Button type="button" variant="destructive" size="sm" className="h-8 shrink-0" onClick={props.onStop}>
							{t("app.stop")}
						</Button>
					) : (
						<Button type="submit" size="sm" className="h-8 shrink-0" disabled={props.disabled || busy || (!draft.trim() && images.length === 0)}>
							{t("app.send")}
						</Button>
					)}
				</div>
			</div>
		</form>
	);
}
