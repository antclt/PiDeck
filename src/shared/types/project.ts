export type Project = {
	id: string;
	name: string;
	path: string;
	lastOpenedAt: number;
	pinned?: boolean;
	sortOrder?: number;
	kind?: "chat";
	/** 是否启用 git worktree 工作区模式，开启后侧栏显示分支子项 */
	worktreeEnabled?: boolean;
	/** 如果是 worktree 子项目，指向父项目的 id */
	worktreeParentId?: string;
	/** 项目所属环境：windows 或 wsl。缺省视为 windows（兼容旧数据）。 */
	environment?: "windows" | "wsl";
	/**
	 * 项目目录在磁盘上不存在（被删除/移动/未挂载）。列表保留记录并标记，
	 * 由用户决定手动移除或恢复目录——不自动删除：网络盘/WSL/移动盘短暂
	 * 不可达时自动移除会误删项目关联（2026-08 用户反馈「目录删了项目列表
	 * 还有残留」）。
	 */
	missing?: boolean;
};

export const SUPPORTED_EXTERNAL_EDITORS = [
	{ id: "vscode", name: "Visual Studio Code" },
	{ id: "cursor", name: "Cursor" },
	{ id: "zed", name: "Zed" },
	{ id: "idea", name: "IntelliJ IDEA" },
	{ id: "webstorm", name: "WebStorm" },
	{ id: "phpstorm", name: "PhpStorm" },
	{ id: "pycharm", name: "PyCharm" },
] as const;

export type ExternalEditorId = typeof SUPPORTED_EXTERNAL_EDITORS[number]["id"];

export type ExternalEditorDetectedFrom = "path" | "common-path" | "manual";

export type ExternalEditorSetting = {
	enabled: boolean;
	command: string;
	detectedFrom?: ExternalEditorDetectedFrom;
	updatedAt?: number;
};

export type ExternalEditorSettings = Record<ExternalEditorId, ExternalEditorSetting>;

export function createDefaultExternalEditorSettings(): ExternalEditorSettings {
	return Object.fromEntries(
		SUPPORTED_EXTERNAL_EDITORS.map((editor) => [
			editor.id,
			{ enabled: false, command: "" },
		]),
	) as ExternalEditorSettings;
}

export type ExternalEditor = {
	id: ExternalEditorId;
	name: string;
	command: string;
	args?: string[];
	detectedFrom: ExternalEditorDetectedFrom;
};
