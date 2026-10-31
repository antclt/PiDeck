import type { Op } from "../../../shared/op";
import type { GitCompareRefsValue, GitHistoryPage, GitRef, GitResourceGroups, GitResourceGroupType, GitRepositoryListing, GitDiscardResource } from "../../../shared/types/git";
import type { Project, ProjectFileTarget } from "../../../shared/types";
import type { ProjectDirectoryPage, ProjectPathState } from "../../../shared/types/projectFiles";
import type { FileContentSearchResult, FileSearchResult } from "../../../shared/types/session";
import type { PiDesktopApi } from "../../../preload";

/**
 * 工作区面板的服务缝（Phase A 草案）。
 *
 * 目标：文件/ Git 面板只依赖本文件里的接口，不再直接依赖 window.piDesktop 的具体通道；
 * 本地与远端各有一个 provider，UI 只按项目位置选择 provider，同一套组件消费同一份契约。
 *
 * Phase A 只定义契约 + 两个 provider（远端 Git 写与部分能力显式 unsupported），不改任何现有 UI；
 * 迁移步骤与 parity 矩阵见 docs/project-panel-service-seam-adr.md。
 */

/** provider 需要的最小 API 面：本地文件/Git + 远端文件管理。 */
export type ProjectServicesApi = {
	files: PiDesktopApi["files"];
	git: PiDesktopApi["git"];
	remoteHosts: PiDesktopApi["remoteHosts"];
};

export const PROJECT_SERVICE_CODES = {
	unsupported: "PROJECT_SERVICE_UNSUPPORTED",
	versionRequired: "PROJECT_SERVICE_VERSION_REQUIRED",
	remoteFailed: "PROJECT_SERVICE_REMOTE_FAILED",
} as const;

export type ProjectServiceErrorCode = (typeof PROJECT_SERVICE_CODES)[keyof typeof PROJECT_SERVICE_CODES];

/** 服务层的失败：稳定码 + 二阶语义（unknown 只可能来自远端写），并允许带一句内部说明（不直接展示）。 */
export class ProjectServiceError extends Error {
	readonly code: string;
	readonly outcome: "rejected" | "unknown";
	readonly detail?: string;

	constructor(code: string, outcome: "rejected" | "unknown" = "rejected", detail?: string) {
		super(code);
		this.name = "ProjectServiceError";
		this.code = code;
		this.outcome = outcome;
		this.detail = detail;
	}
}

export type ProjectFileText = { content: string; version?: string };

/**
 * 文件面板需要的操作。读面（目录页/文件名搜索/内容搜索）已经是位置无关的公共契约；
 * 写面（读正文、保存、新建、改名、删除、系统打开）才需要 provider 适配。
 */
export type ProjectFileService = {
	/** 公共目录页：本地与远端的唯一的目录读入口。 */
	listDirectory(target: ProjectFileTarget, options?: { force?: boolean }): Promise<ProjectDirectoryPage>;
	/** 文件名搜索（公共契约，位置无关）。 */
	searchFiles(projectId: string, query: string): Promise<FileSearchResult[]>;
	/** 内容搜索（公共契约；far-end 旧 helper 时远端返回 null = 仅文件名回退）。 */
	searchContent(projectId: string, query: string): Promise<FileContentSearchResult | null>;
	readText(target: ProjectFileTarget, options?: { maxBytes?: number }): Promise<ProjectFileText>;
	writeText(target: ProjectFileTarget, content: string, expectedVersion?: string): Promise<{ version?: string }>;
	stat(target: ProjectFileTarget): Promise<ProjectPathState>;
	createEntry(parent: ProjectFileTarget, name: string, type: "file" | "directory"): Promise<void>;
	renameEntry(target: ProjectFileTarget, newName: string, expectedVersion?: string): Promise<void>;
	deleteEntry(target: ProjectFileTarget, expectedVersion?: string): Promise<void>;
	openInEditor(target: ProjectFileTarget): Promise<void>;
	showInFolder(target: ProjectFileTarget): Promise<void>;
};

/** Git 读面：T7 起这些通道本身已经位置无关（main 按项目位置路由），provider 只做透传。 */
export type ProjectGitService = {
	status(projectId: string, repoPath?: ProjectFileTarget): Promise<GitResourceGroups>;
	refresh(projectId: string, repoPath?: ProjectFileTarget): Promise<GitResourceGroups>;
	history(projectId: string, options?: { maxCount?: number; skip?: number }, repoPath?: ProjectFileTarget): Promise<GitHistoryPage>;
	repos(projectId: string): Promise<GitRepositoryListing>;
	refs(projectId: string, repoPath?: ProjectFileTarget): Promise<GitRef[]>;
	compare(projectId: string, base: string, head: string, repoPath?: ProjectFileTarget): Promise<GitCompareRefsValue>;
	/** 写面：本机直接委派；远端需要 main 所有的令牌经纪（Phase C），当前 provider 抛 unsupported。 */
	stage(projectId: string, targets: ProjectFileTarget[], repoPath?: ProjectFileTarget): Promise<void>;
	unstage(projectId: string, targets: ProjectFileTarget[], repoPath?: ProjectFileTarget): Promise<void>;
	commit(projectId: string, message: string, repoPath?: ProjectFileTarget): Promise<void>;
	discard(projectId: string, resources: GitDiscardResource[], repoPath?: ProjectFileTarget): Promise<void>;
};

export type ProjectFileCapabilities = {
	write: boolean;
	trash: boolean;
	/** "negotiated"：由 helper hello/rootStatus 能力决定（旧 helper 回退仅文件名）。 */
	contentSearch: boolean | "negotiated";
	/** 系统文件管理器打开（远端没有本机路径，天然不支持）。 */
	systemOpen: boolean;
	watch: "full" | "degraded" | "none";
};

export type ProjectGitCapabilities = {
	read: boolean;
	/** 远端写需要令牌经纪；Phase C 前由面板自有实现承担，服务缝不假装支持。 */
	write: boolean;
	worktree: boolean;
	compare: boolean;
	sync: boolean;
};

export type ProjectServiceCapabilities = {
	files: ProjectFileCapabilities;
	git: ProjectGitCapabilities;
};

export type ProjectServices = {
	files: ProjectFileService;
	git: ProjectGitService;
	capabilities: ProjectServiceCapabilities;
	/** 显式标注 provider 位置，供诊断与测试断言；不是业务分支条件。 */
	kind: "local" | "remote";
};

export function unwrapOp<T>(op: Op<T>, fallbackCode: string): T {
	if (op && op.ok === true) return op.value;
	const failure = op as { code?: string; outcome?: "rejected" | "unknown" } | null;
	throw new ProjectServiceError(failure?.code ?? fallbackCode, failure?.outcome ?? "rejected");
}

export const REMOTE_UNSUPPORTED_DETAIL = {
	fileSystemOpen: "remote workspace has no local path",
	gitWrite: "phase-c: remote git writes need the main-owned token broker",
	gitWorktree: "phase-c: worktree is local-only",
	gitSync: "phase-c: remote sync stays in the panel until the token broker lands",
} as const;

export type { Project, ProjectFileTarget, GitResourceGroupType };
