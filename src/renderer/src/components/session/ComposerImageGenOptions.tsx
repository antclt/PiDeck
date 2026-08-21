import {
	DEFAULT_IMAGE_GEN_OUTPUT_FORMAT,
	DEFAULT_IMAGE_GEN_SIZE,
	IMAGE_GEN_OUTPUT_FORMATS,
	IMAGE_GEN_SIZE_PRESETS,
	parseImageGenOutputFormat,
	parseImageGenSize,
	type ImageGenOutputFormat,
	type ImageGenSizePreset,
} from "../../../../shared/imageGenParams";
import { t } from "../../i18n";
import { Switch } from "../ui-shadcn/switch";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui-shadcn/select";

/**
 * 生图模式底栏参数：尺寸、输出格式、水印。后两项只在火山端点真正发出。
 * 记忆写在 AppSettings，不占用独立设置页。
 */
export function ComposerImageGenOptions(props: {
	size: string;
	outputFormat: string;
	watermark: boolean;
	disabled?: boolean;
	onSizeChange: (size: string) => void;
	onOutputFormatChange: (format: string) => void;
	onWatermarkChange: (watermark: boolean) => void;
}) {
	const sizeValue = parseImageGenSize(props.size) ?? DEFAULT_IMAGE_GEN_SIZE;
	const isPreset = (IMAGE_GEN_SIZE_PRESETS as readonly string[]).includes(sizeValue);
	const outputFormat = parseImageGenOutputFormat(props.outputFormat) ?? DEFAULT_IMAGE_GEN_OUTPUT_FORMAT;
	return (
		<div className="inline-flex h-7 min-w-0 items-center gap-0.5">
			<Select
				value={sizeValue}
				disabled={props.disabled}
				onValueChange={props.onSizeChange}
			>
				<SelectTrigger
					size="sm"
					className="composer-bar-btn h-7 max-w-[9.5rem] gap-1 rounded-md border-transparent px-1.5 text-control font-medium text-foreground hover:bg-muted/60"
					title={t("imagegen.sizeHint")}
					aria-label={t("imagegen.size")}
				>
					<SelectValue placeholder={t("imagegen.size")} />
				</SelectTrigger>
				<SelectContent align="start">
					{!isPreset ? (
						<SelectItem value={sizeValue}>{sizeValue}</SelectItem>
					) : null}
					{IMAGE_GEN_SIZE_PRESETS.map((preset: ImageGenSizePreset) => (
						<SelectItem key={preset} value={preset}>
							{preset}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Select
				value={outputFormat}
				disabled={props.disabled}
				onValueChange={props.onOutputFormatChange}
			>
				<SelectTrigger
					size="sm"
					className="composer-bar-btn h-7 max-w-[5.5rem] gap-1 rounded-md border-transparent px-1.5 text-control font-medium uppercase text-foreground hover:bg-muted/60"
					title={t("imagegen.outputFormatHint")}
					aria-label={t("imagegen.outputFormat")}
				>
					<SelectValue placeholder={t("imagegen.outputFormat")} />
				</SelectTrigger>
				<SelectContent align="start">
					{IMAGE_GEN_OUTPUT_FORMATS.map((format: ImageGenOutputFormat) => (
						<SelectItem key={format} value={format} className="uppercase">
							{format}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<label
				className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-control text-foreground hover:bg-muted/60 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
				title={t("imagegen.watermarkHint")}
			>
				<Switch
					size="sm"
					checked={props.watermark}
					disabled={props.disabled}
					onCheckedChange={props.onWatermarkChange}
					aria-label={t("imagegen.watermark")}
				/>
				<span className="whitespace-nowrap">{t("imagegen.watermark")}</span>
			</label>
		</div>
	);
}
