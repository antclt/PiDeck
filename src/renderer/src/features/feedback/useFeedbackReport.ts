import { useCallback, useState } from "react";
import type {
	HealthExportResult,
	HealthReport,
	HealthReportContext,
	HealthReportFormat,
} from "../../../../shared/types";
import { formatReport } from "./reportFormat";
import { desktopApi } from "../../desktopApi";

/**
 * 环境诊断工作台的状态管理 hook。
 *
 * 职责边界：只持有「体检结果 + 上下文 + 当前格式」并派生导出文本，不碰 UI。
 * 副作用（触发体检、复制、导出文件）走 desktopApi，调用方绑定按钮。
 *
 * 加载态：
 * - idle：从未触发过体检
 * - running：体检进行中
 * - done：体检完成
 * - error：体检失败
 */
export type HealthCheckState = "idle" | "running" | "done" | "error";

export function useFeedbackReport(initialContext?: Partial<HealthReportContext>) {
	const [report, setReport] = useState<HealthReport | null>(null);
	const [state, setState] = useState<HealthCheckState>("idle");
	const [error, setError] = useState("");
	const [format, setFormat] = useState<HealthReportFormat>("markdown");
	const [context, setContext] = useState<HealthReportContext>({
		description: initialContext?.description ?? "",
		steps: initialContext?.steps ?? "",
		projectName: initialContext?.projectName ?? "",
	});

	/** 触发一次环境体检。 */
	const runCheck = useCallback(async () => {
		setState("running");
		setError("");
		try {
			const next = await desktopApi.system.healthCheck();
			setReport(next);
			setState("done");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
			setState("error");
		}
	}, []);

	/** 按当前格式生成可复制文本。 */
	const text = report ? formatReport(report, context, format) : "";

	/** 复制当前报告到剪贴板（走主进程，大文本可靠）。 */
	const copyText = useCallback(async (): Promise<boolean> => {
		if (!text) return false;
		return desktopApi.clipboard.writeText(text);
	}, [text]);

	/** 导出当前报告为 .md 文件。 */
	const exportMarkdown = useCallback(async (): Promise<HealthExportResult> => {
		const md = report ? formatReport(report, context, "markdown") : "";
		return desktopApi.system.healthExportReport(md, report ? JSON.stringify(report, null, 2) : undefined);
	}, [context, report]);

	/** 导出完整日志包为 .zip。 */
	const exportBundle = useCallback(async (): Promise<HealthExportResult> => {
		const md = report ? formatReport(report, context, "markdown") : "";
		return desktopApi.system.healthExportBundle(md, report ? JSON.stringify(report, null, 2) : "{}");
	}, [context, report]);

	return {
		report,
		state,
		error,
		format,
		setFormat,
		context,
		setContext,
		runCheck,
		text,
		copyText,
		exportMarkdown,
		exportBundle,
	};
}
