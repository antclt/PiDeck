import type { ConfigFileDiagnostic } from "../../../shared/types";
import { Button } from "../components/ui-shadcn/button";
import { t } from "../i18n";
import { openDocsInSystemBrowser } from "./ConfigShared";

/**
 * 配置加载诊断卡片（从 ConfigModal 拆出）：JSON 损坏时仍要让用户看到出错的文件名/行列/片段，
 * 并能跳到官方文档或源文件页自行修复——否则坏配置只会表现为「配置是空的」，一保存就写没了。
 */
export function ConfigDiagnosticCard(props: { diagnostic: ConfigFileDiagnostic; onOpenDocs: () => void; onOpenRaw: () => void }) {
	const { diagnostic } = props;
	return (
		<div className="config-diagnostic-card">
			<div>
				<strong>{t("config.diagnosticLoadFailed", { fileName: diagnostic.fileName })}</strong>
				<span>
					{diagnostic.line && diagnostic.column
						? t("config.diagnosticLocation", {
								line: diagnostic.line,
								column: diagnostic.column,
								message: diagnostic.message,
							})
						: diagnostic.message}
				</span>
				<small>
					{t("config.diagnosticHelp")}{" "}
					<a href={diagnostic.docsUrl} onClick={openDocsInSystemBrowser(diagnostic.docsUrl)}>
						{t("config.openOfficialDocs")}
					</a>
				</small>
			</div>
			{diagnostic.snippet && <pre>{diagnostic.snippet}</pre>}
			<div className="config-diagnostic-actions">
				<Button size="sm" variant="default" onClick={props.onOpenRaw}>
					{t("config.openRawFile")}
				</Button>
				<Button size="sm" variant="outline" onClick={props.onOpenDocs}>
					{t("config.openOfficialDocs")}
				</Button>
			</div>
		</div>
	);
}
