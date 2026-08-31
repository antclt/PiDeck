import type {
	HealthCheckItem,
	HealthReport,
	HealthReportContext,
	HealthReportFormat,
	HealthStatus,
} from "../../../../shared/types";

/**
 * 诊断报告的三种输出形态纯函数。
 *
 * 为什么独立成纯模块：markdown/card/prompt 是「把体检数据翻译成可分享文本」的纯转换，
 * 不依赖 React/i18n/IPC，可以脱离渲染层直接单测——「报告里是否漏了某个字段 / 卡片
 * 是否太长」这类回归用测试锁定，比靠视觉检查可靠。
 *
 * 隐私承诺：入参 HealthReport 本身已脱敏（主进程最后一环），本模块不额外读写任何
 * 文件或配置，只做文本拼装。
 */

const STATUS_ICON: Record<HealthStatus, string> = {
	ok: "✅",
	warn: "⚠️",
	error: "❌",
	skipped: "➖",
};

const STATUS_LABEL: Record<HealthStatus, string> = {
	ok: "OK",
	warn: "WARN",
	error: "ERROR",
	skipped: "SKIP",
};

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "n/a";
	if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
	return `${Math.round(bytes / 1024)} KB`;
}

function formatTime(ms: number): string {
	const date = new Date(ms);
	const pad = (v: number) => String(v).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 环境信息 → Markdown 清单。 */
function environmentLines(env: HealthReport["environment"]): string[] {
	const flags: string[] = [];
	if (env.flags.wslEnabled) flags.push("WSL on");
	if (env.flags.piProxyEnabled) flags.push(`pi proxy ${env.flags.piProxyConfigured ? "configured" : "unset"}`);
	if (env.flags.desktopProxyEnabled) flags.push("desktop proxy on");
	if (env.flags.chromiumSandbox) flags.push("chromium sandbox on");
	if (env.flags.developerDiagnostics) flags.push("dev diagnostics on");
	if (env.flags.webServiceEnabled) flags.push("web service on");
	if (env.flags.customPiPathConfigured) flags.push("custom pi path");
	const osLabel =
		env.platform === "win32"
			? `Windows ${env.osVersion}`
			: env.platform === "darwin"
				? `macOS ${env.osVersion}`
				: `${env.platform} ${env.osVersion}`;
	return [
		`- PiDeck ${env.appVersion} (${env.installMode})`,
		`- OS: ${osLabel} (${env.arch})`,
		`- Electron ${env.electronVersion} / Chrome ${env.chromeVersion} / Node ${env.nodeVersion}`,
		`- Locale: ${env.locale} · TZ: ${env.timezone}`,
		`- Data dir: ${env.userDataDir || "(masked)"}`,
		`- Mem: app ${formatBytes(env.appRssBytes)} RSS · system ${formatBytes(env.systemFreeMemoryBytes)} free / ${formatBytes(env.systemTotalMemoryBytes)}`,
		`- Disk (data dir): ${formatBytes(env.dataDirFreeBytes)} free`,
		`- pi: ${env.pi?.installed ? env.pi.version || "installed" : "NOT installed"}`,
		`- Flags: ${flags.length ? flags.join(", ") : "none"}`,
	];
}

/** 检查项 → Markdown 清单。 */
function checkLines(checks: HealthCheckItem[]): string[] {
	return checks.map((check) => {
		const status = `${STATUS_ICON[check.status]} ${STATUS_LABEL[check.status]}`;
		return `- ${status} · ${check.id}${check.detail ? ` — ${check.detail}` : ""}`;
	});
}

/** 最近报错 → Markdown 清单（条数上限避免失控）。 */
function recentErrorLines(summary: HealthReport["logSummary"], limit = 20): string[] {
	return summary.recent.slice(0, limit).map((line) => {
		const scope = line.scope ? ` [${line.scope}]` : "";
		return `- ${formatTime(line.time)} ${line.level.toUpperCase()}${scope}: ${line.message}`;
	});
}

/**
 * 生成 Markdown 完整报告：适合贴 GitHub Issue / 邮件 / 群文件。
 * 标签用英文，保证分享到英文环境也能读。
 */
export function formatMarkdown(report: HealthReport, context: HealthReportContext): string {
	const lines: string[] = [];
	lines.push(`# PiDeck Diagnostic Report`);
	lines.push("");
	lines.push(`Generated: ${formatTime(report.generatedAt)}`);
	lines.push("");
	lines.push(`## Description`);
	lines.push(context.description.trim() || "_（empty）_");
	if (context.steps.trim()) {
		lines.push("");
		lines.push(`### Repro steps`);
		lines.push(context.steps.trim());
	}
	lines.push("");
	lines.push(`## Health checks`);
	if (report.checks.length === 0) {
		lines.push("_no checks available_");
	} else {
		lines.push(...checkLines(report.checks));
	}
	lines.push("");
	lines.push(`## Environment`);
	lines.push(...environmentLines(report.environment));
	lines.push("");
	lines.push(`## Recent logs (${report.logSummary.recent.length} shown)`);
	lines.push(
		`Total ${report.logSummary.total} · errors ${report.logSummary.error} · warns ${report.logSummary.warn} (last 7 days)`,
	);
	if (report.logSummary.recent.length === 0) {
		lines.push("_no recent errors/warnings_");
	} else {
		lines.push(...recentErrorLines(report.logSummary));
	}
	return lines.join("\n");
}

/**
 * 生成精简群消息卡片：一两屏能看完，适合直接发到用户群让支持者扫一眼。
 */
export function formatCard(report: HealthReport, context: HealthReportContext): string {
	const lines: string[] = [];
	lines.push(`📋 PiDeck 诊断 | ${report.environment.appVersion}`);
	lines.push("");
	const problem = context.description.trim().split("\n")[0].slice(0, 80);
	lines.push(`**问题**：${problem || "（未填写）"}`);
	lines.push("");
	if (report.checks.length > 0) {
		const first = report.checks.slice(0, 4);
		lines.push("**体检**：");
		lines.push(...checkLines(first));
		if (report.checks.length > 4) lines.push(`… 共 ${report.checks.length} 项`);
	}
	lines.push("");
	lines.push(`**环境**：${environmentLines(report.environment)[0]}`);
	const free = formatBytes(report.environment.dataDirFreeBytes);
	lines.push(`**磁盘余量**：${free} · **内存**：${formatBytes(report.environment.appRssBytes)} RSS`);
	if (report.logSummary.error > 0 || report.logSummary.warn > 0) {
		lines.push(
			`**近7天日志**：${report.logSummary.error} errors / ${report.logSummary.warn} warns`,
		);
	}
	lines.push("");
	lines.push(`_由 PiDeck 生成 · ${formatTime(report.generatedAt)}_`);
	return lines.join("\n");
}

/**
 * 生成可复制给任意 AI 的分析提示词：角色设定 + 体检结果 + 报错摘要，
 * 用户粘贴给 ChatGPT/DeepSeek/群友即可让 AI 帮忙定位。
 */
export function formatAiPrompt(report: HealthReport, context: HealthReportContext): string {
	const lines: string[] = [];
	lines.push(
		`你是一名专业的桌面软件技术支持工程师。请根据下面的 PiDeck 诊断报告，判断可能的问题根因，并给出**分步骤、可执行**的排查和修复建议。`,
	);
	lines.push(
		`如果信息不足，请明确说明你还缺哪些信息，而不是猜测。涉及修改配置文件时，提醒先备份，且不要泄露或要求提供任何密钥/Token。`,
	);
	lines.push("");
	lines.push(`## 用户描述`);
	lines.push(context.description.trim() || "（用户未填写）");
	if (context.steps.trim()) {
		lines.push("");
		lines.push(`### 复现步骤`);
		lines.push(context.steps.trim());
	}
	lines.push("");
	lines.push(`## 体检结果`);
	lines.push(report.checks.length ? checkLines(report.checks).join("\n") : "（无检查项）");
	lines.push("");
	lines.push(`## 环境`);
	lines.push(environmentLines(report.environment).join("\n"));
	lines.push("");
	lines.push(`## 最近报错日志`);
	if (report.logSummary.recent.length === 0) {
		lines.push("（近 7 天无 error/warn）");
	} else {
		lines.push(...recentErrorLines(report.logSummary, 30));
	}
	lines.push("");
	lines.push("请输出：1) 最可能的根因（按可能性排序）；2) 每条的验证方法；3) 修复步骤；4) 修复后如何验证。");
	return lines.join("\n");
}

/** 按格式生成对应文本。 */
export function formatReport(
	report: HealthReport,
	context: HealthReportContext,
	format: HealthReportFormat,
): string {
	if (format === "card") return formatCard(report, context);
	if (format === "prompt") return formatAiPrompt(report, context);
	return formatMarkdown(report, context);
}

/** 汇总体检概览：给标题区显示「3 异常 / 健康度 82」。 */
export function summarizeChecks(checks: HealthCheckItem[]): {
	ok: number;
	warn: number;
	error: number;
	skipped: number;
	score: number;
} {
	const tally = { ok: 0, warn: 0, error: 0, skipped: 0, score: 100 };
	for (const check of checks) tally[check.status] += 1;
	const evaluated = tally.ok + tally.warn + tally.error;
	if (evaluated > 0) {
		tally.score = Math.max(0, Math.round(((tally.ok + tally.warn * 0.5) / evaluated) * 100));
	}
	return tally;
}
