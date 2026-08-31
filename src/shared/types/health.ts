import type { PiInstallStatus } from "./app";

/**
 * 环境诊断（Environment Doctor）共享类型。
 *
 * 与既有「开发诊断 / DiagnosticsMonitor」的区别：
 * - DiagnosticsMonitor 是**性能剖析**（内存采样、事件循环延迟、关键路径耗时），给开发者追查卡顿；
 * - EnvironmentDoctor 是**环境体检**（pi 是否在、WSL/代理配置、磁盘与内存余量、配置是否损坏、
 *   最近报错），给普通用户一键生成可分享的排障报告。
 *
 * 隐私红线：本文件所有字段在进入渲染层之前必须已经过 `redactSecrets` / `maskUserPath` 处理，
 * 任何新字段都不得携带原始 home 路径、token、apiKey、邮箱、手机号或用户文件内容。
 */

/** 单个检查项的结论。skipped = 当前平台/配置下不适用，不参与健康度评分。 */
export type HealthStatus = "ok" | "warn" | "error" | "skipped";

export type HealthCheckItem = {
	/**
	 * 稳定 id。渲染层用 `health.check.<id>` 取标题、`health.check.<id>.hint` 取修复建议，
	 * 因此新增检查项只需加 i18n key，不需要改渲染层代码。
	 */
	id: string;
	status: HealthStatus;
	/** 已脱敏的运行时结论（版本号、余量、路径摘要等）；无补充信息时为空串。 */
	detail: string;
};

/** 一条脱敏后的日志行。只包含定位问题所需的元信息，不含 detail 字段（可能含路径/内容）。 */
export type HealthLogLine = {
	time: number;
	level: "warn" | "error";
	scope: string;
	message: string;
};

export type HealthLogSummary = {
	/** 统计窗口（最近 7 天）内的日志总条数 */
	total: number;
	error: number;
	warn: number;
	/** 最近若干条 warn/error，按时间倒序，已脱敏并截断条数 */
	recent: HealthLogLine[];
};

/** 非敏感的运行开关快照 —— 帮助用户/支持者判断问题是否与某项配置相关。 */
export type HealthFlags = {
	wslEnabled: boolean;
	wslDistro: string;
	/** pi 子进程是否走代理 */
	piProxyEnabled: boolean;
	/** 桌面端自身是否走代理（只给布尔值，不含代理地址，避免泄露内网主机端口） */
	desktopProxyEnabled: boolean;
	/** pi 代理是否配置了地址（布尔值，不含地址本身） */
	piProxyConfigured: boolean;
	chromiumSandbox: boolean;
	developerDiagnostics: boolean;
	webServiceEnabled: boolean;
	/** 是否手动指定过 pi 命令路径（布尔值，不含路径） */
	customPiPathConfigured: boolean;
};

export type HealthEnvironment = {
	appVersion: string;
	platform: NodeJS.Platform;
	arch: string;
	/** 操作系统版本（os.release() + 发行版信息，Windows 上带 build 号） */
	osVersion: string;
	/** 应用当前界面语言，排查 i18n/编码问题时有用 */
	locale: string;
	timezone: string;
	electronVersion: string;
	chromeVersion: string;
	nodeVersion: string;
	/** installed=安装版 / portable=便携版 / dev=开发态 */
	installMode: "installed" | "portable" | "dev";
	/** 已脱敏的数据目录（home 部分替换为 ~） */
	userDataDir: string;
	/** 已脱敏的日志目录 */
	logsDir: string;
	appRssBytes: number;
	appHeapUsedBytes: number;
	systemTotalMemoryBytes: number;
	systemFreeMemoryBytes: number;
	/** 数据目录所在磁盘的剩余空间（字节）；读取失败为 0 */
	dataDirFreeBytes: number;
	flags: HealthFlags;
	pi: PiInstallStatus;
};

export type HealthLogFile = {
	name: string;
	sizeBytes: number;
	/** 文件最后修改时间，毫秒时间戳 */
	modifiedAt: number;
};

/** 一次完整体检的结果。渲染层据此渲染检查项列表并生成 Markdown / 卡片 / AI 提示词。 */
export type HealthReport = {
	generatedAt: number;
	environment: HealthEnvironment;
	checks: HealthCheckItem[];
	logSummary: HealthLogSummary;
	/** 日志目录里的文件清单（按名称倒序），供「导出日志包」按钮展示体积 */
	logFiles: HealthLogFile[];
};

/**
 * 诊断报告的三种输出形态。
 * - markdown：完整报告，适合贴 GitHub Issue / 邮件；
 * - card：精简版群消息卡片，适合直接发到用户群；
 * - prompt：带角色设定与排障要求的 AI 提示词，用户复制后贴给任意 AI 即可分析。
 */
export type HealthReportFormat = "markdown" | "card" | "prompt";

/** 用户补充的问题描述，与体检结果一起渲染进报告。 */
export type HealthReportContext = {
	/** 问题现象（用户填写） */
	description: string;
	/** 复现步骤（用户填写，可为空） */
	steps: string;
	/** 当前项目名；不附带项目路径，避免泄露目录结构 */
	projectName: string;
};

/** 导出结果。canceled=true 表示用户在保存对话框里取消了，不是失败。 */
export type HealthExportResult = {
	ok: boolean;
	canceled: boolean;
	/** 成功时为写入的绝对路径；失败时为错误原因（已脱敏） */
	path?: string;
	error?: string;
};
