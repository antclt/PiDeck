import type { PiConfigTarget } from "../../../shared/piConfig";
import { t } from "../i18n";
import { downloadConfigJson, pickJsonFileText } from "./configTransfer";

/**
 * 配置导出/导入的目标门禁与文件动作（从 ConfigModal 抽出，保持 3205 行预算只降不升）。
 *
 * 非本机目标（WSL/ssh）下：导出会把 Windows 配置冒充「当前目标的配置」下载；导入会整体覆盖本机
 * 四个配置文件。两者都必须显式拒绝并提示，不能因为按钮还在就静默作用到错误的位置。
 */
export function useConfigTransfer(input: {
	target: PiConfigTarget;
	exportConfig: () => Promise<string>;
	importConfig: (text: string) => Promise<{ valid: boolean; error?: string }>;
	notify: (message: string) => void;
	onError: (message: string) => void;
	onImported: () => void;
	clearConfigDirty: () => void;
	reloadAfterImport: () => Promise<void>;
}) {
	const rejectNonLocal = (): boolean => {
		if (input.target.kind === "local") return false;
		input.notify(t("config.target.exportLocalOnly"));
		return true;
	};
	const handleExport = async (): Promise<void> => {
		if (rejectNonLocal()) return;
		try {
			const json = await input.exportConfig();
			downloadConfigJson(json, `pideck-config-${new Date().toISOString().slice(0, 10)}.json`);
			input.notify(t("config.exported"));
		} catch (error) {
			input.onError(error instanceof Error ? error.message : String(error));
		}
	};
	const handleImport = async (): Promise<void> => {
		if (rejectNonLocal()) return;
		try {
			const text = await pickJsonFileText();
			if (text === null) return;
			const result = await input.importConfig(text);
			if (!result.valid) {
				input.onError(result.error ?? t("config.importFailed"));
				return;
			}
			input.onImported();
			// 导入会整体替换四个配置文件：清掉所有配置脏标记，避免残留黄点/关闭误弹确认。
			input.clearConfigDirty();
			await input.reloadAfterImport();
			input.notify(t("config.imported"));
		} catch (error) {
			input.onError(error instanceof Error ? error.message : String(error));
		}
	};
	return { handleExport, handleImport };
}
