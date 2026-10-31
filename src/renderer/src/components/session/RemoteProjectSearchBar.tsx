import { Search, X } from "lucide-react";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";

/** 远端目录搜索行：与本地文件树的搜索入口同义，输入/提交/关闭只做受控展示。 */
export function RemoteProjectSearchBar(props: { query: string; busy: boolean; onQueryChange: (value: string) => void; onSubmit: () => void; onClose: () => void }) {
	return (
		<form
			className="flex shrink-0 items-center gap-1 px-2 py-1"
			onSubmit={(event) => {
				event.preventDefault();
				if (props.query.length > 0 && !props.busy) props.onSubmit();
			}}
		>
			<Input value={props.query} onChange={(event) => props.onQueryChange(event.target.value)} maxLength={128} disabled={props.busy} placeholder={t("project.remote.searchPlaceholder")} aria-label={t("project.remote.searchPlaceholder")} className="h-7 min-w-0 flex-1 text-label" />
			<Button type="submit" variant="ghost" size="icon-sm" aria-label={t("project.remote.searchAction")} title={t("project.remote.searchAction")} disabled={props.busy || props.query.length === 0}>
				<Search className="size-4" />
			</Button>
			<Button type="button" variant="ghost" size="icon-sm" title={t("project.remote.searchClear")} aria-label={t("project.remote.searchClear")} onClick={props.onClose}>
				<X className="size-4" />
			</Button>
		</form>
	);
}
