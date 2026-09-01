import { useCallback, useState } from "react";
import type {
	FeedbackProjectContext,
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

export function useFeedbackReport(
	initialContext?: Partial<HealthReportContext> & { projectId?: string },
) {
	const [report, setReport] = useState<HealthReport | null>(null);
	const [state, setState] = useState<HealthCheckState>("idle");
	const [error, setError] = useState("");
	const [format, setFormat] = useState<HealthReportFormat>("markdown");
	const [context, setContext] = useState<HealthReportContext>({
		description: initialContext?.description ?? "",
		steps: initialContext?.steps ?? "",
		projectName: initialContext?.projectName ?? "",
	});
	// 项目上下文（AGENTS.md + 技能列表）：随体检一起拉取，失败降级为 null（提示词不带工程规范）
	const [projectContext, setProjectContext] = useState<FeedbackProjectContext | null>(null);

	/** 触发一次环境体检；同时拉取项目上下文供 AI 提示词携带工程规范。 */
	const runCheck = useCallback(async () => {
		setState("running");
		setError("");
		try {
			const [next, ctx] = await Promise.all([
				desktopApi.system.healthCheck(),
				initialContext?.projectId
					? desktopApi.app
							.getFeedbackProjectContext(initialContext.projectId)
							.catch(() => null)
					: Promise.resolve(null),
			]);
			setReport(next);
			if (ctx) setProjectContext(ctx);
			setState("done");
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
			setState("error");
		}
	}, [initialContext?.projectId]);

	/** 按当前格式生成可复制文本。 */
	const text = report ? formatReport(report, context, format) : "";

	/** AI 分析提示词：固定 prompt 形态（不随 format 状态漂移），附带项目上下文。 */
	const promptText = report
		? formatReport(report, context, "prompt", projectContext ?? undefined)
		: "";

	/** 复制当前报告到剪贴板（走主进程，大文本可靠）。 */
	const copyText = useCallback(async (): Promise<boolean> => {
		if (!text) return false;
		return desktopApi.clipboard.writeText(text);
	}, [text]);

	/** 复制 AI 分析提示词（带项目上下文）。 */
	const copyPrompt = useCallback(async (): Promise<boolean> => {
		if (!promptText) return false;
		return desktopApi.clipboard.writeText(promptText);
	}, [promptText]);

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
		promptText,
		copyText,
		copyPrompt,
		exportMarkdown,
		exportBundle,
	};
}
