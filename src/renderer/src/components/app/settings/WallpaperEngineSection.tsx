import { useEffect, useState } from "react";
import type { AppSettings } from "../../../../../shared/types";
import type { WallpaperEngineItem } from "../../../../../shared/wallpaperEngine";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { Button } from "../../ui-shadcn/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";

const NONE = "__none__";

/**
 * Wallpaper Engine 视频壁纸设置（第一期只列 type=video）。
 * 渲染层只拿到解析后的元数据（id/title/file/preview），视频本体由 pideck-we:// 协议播放。
 */
export function WallpaperEngineSection({ draft, updateDraft }: { draft: AppSettings; updateDraft: (patch: Partial<AppSettings>) => void }) {
	const dir = draft.weWorkshopDir ?? "";
	const [items, setItems] = useState<WallpaperEngineItem[]>([]);
	const [error, setError] = useState<string>("");

	useEffect(() => {
		let cancelled = false;
		if (!dir) {
			setItems([]);
			setError("");
			return;
		}
		void desktopApi.dialog.listWallpaperEngine(dir).then((result) => {
			if (cancelled) return;
			setItems(result.items);
			setError(result.error === "unreadable" ? t("settings.wallpaperEngineUnreadable") : result.items.length === 0 ? t("settings.wallpaperEngineEmpty") : "");
		});
		return () => {
			cancelled = true;
		};
	}, [dir]);

	return (
		<div className="flex w-full flex-col gap-2">
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={dir}>
					{dir || "—"}
				</span>
				<Button
					variant="outline"
					size="sm"
					onClick={async () => {
						const picked = await desktopApi.dialog.pickWallpaperEngineDir();
						if (picked) updateDraft({ weWorkshopDir: picked, weWallpaperId: "" });
					}}
				>
					{t("settings.wallpaperEngineChooseDir")}
				</Button>
			</div>
			{dir ? (
				<Select value={draft.weWallpaperId || NONE} onValueChange={(value) => updateDraft({ weWallpaperId: value === NONE ? "" : value })}>
					<SelectTrigger size="sm" aria-label={t("settings.wallpaperEngine")}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={NONE}>{t("settings.wallpaperEngineOff")}</SelectItem>
						{items.map((item) => (
							<SelectItem key={item.id} value={item.id}>
								{item.title}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			) : null}
			{error ? <span className="text-xs text-muted-foreground">{error}</span> : null}
		</div>
	);
}
