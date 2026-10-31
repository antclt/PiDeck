import type { FileContentSearchResult, FileSearchResult } from "../../../../shared/types";
import { t } from "../../i18n";
import { shouldShowFileNameOnlyHint } from "../../utils/fileSearchCapability";
import { FileContentSection } from "./FileSearchResults";

/**
 * 远端项目面板的内容搜索分区（从 RemoteProjectPanel 抽出，面板必须守住 440 行单文件红线）。
 *
 * 行为与 props 语义不变：
 * - supported=true：渲染与本地文件抽屉共用的 FileContentSection（命中行、截断提示、扫描中状态）；
 * - supported=false（旧 helper 或缺省能力）：不渲染内容分区，只在查询非空时显示「仅文件名」提示。
 *   是否发 IPC 由调用方（useRemoteContentSearch 的 shouldRunRemoteContentSearch）决定，这里不触发搜索。
 */
export function RemoteContentSearchSection(props: {
	supported: boolean;
	/** 当前查询词（用于能力提示的空查询判断；内容结果本身由 results 携带）。 */
	query: string;
	results: FileContentSearchResult | null;
	isSearching: boolean;
	/** 命中项的 path 是项目相对路径，调用方负责走远端编辑器入口。 */
	onOpenHit: (path: string) => void;
	onHitContextMenu: (node: FileSearchResult, x: number, y: number) => void;
}) {
	if (props.supported) {
		return <FileContentSection query={props.query.trim()} result={props.results} isSearching={props.isSearching} onViewFile={(path) => props.onOpenHit(path)} onFileContextMenu={props.onHitContextMenu} />;
	}
	if (!shouldShowFileNameOnlyHint({ contentSearchSupported: false, query: props.query })) return null;
	return (
		<p data-testid="file-search-name-only-hint" className="px-2 py-1 text-label text-muted-foreground">
			{t("drawer.fileSearchNameOnlyHint")}
		</p>
	);
}
