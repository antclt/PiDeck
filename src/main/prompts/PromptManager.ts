import { shell } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
	createProjectFileReadBoundary,
	resolveProjectFileReadPath,
	resolveProjectFileWritePath,
	type ProjectFileReadBoundary,
} from "../files/projectFileAccess";
import { homedir } from "node:os";
import { trashPath } from "../fs/trash";
import type {
	AppSettings,
	CreatePiPromptTemplateInput,
	PiPromptTemplateListResult,
	PiPromptTemplateSummary,
} from "../../shared/types";
import { parseWslUncPath, toWindowsHostPath, type WslEnvironment } from "../wsl/WslPaths";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";

type PromptCopy = (
	key: MainProcessTranslationKey,
	params?: Record<string, string | number>,
) => string;

function makeBuiltinContent(name: string, body: string): string {
	return `---\ndescription: ${name}\n---\n\n${body}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDisabledPromptNames(settings: Record<string, unknown>): string[] {
	const value = settings.disabledPrompts;
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

/** 推荐模板：用户刚接触 prompt templates 时可快速上手的实用模板。
 * 标记 userCreated: false，在 UI 中显示为只读条目。 */
const BUILTIN_TEMPLATES: PiPromptTemplateSummary[] = [
	{
		name: "review",
		path: "builtin://review",
		description: "Review staged git changes for bugs, security issues, and logic errors",
		content: makeBuiltinContent(
			"Review staged git changes",
			"Review the staged changes (\\`git diff --cached\\`). Focus on:\n- Bugs and logic errors\n- Security issues\n- Error handling gaps\n- Edge cases and boundary conditions",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "test",
		path: "builtin://test",
		description: "Write tests for a function or component covering edge cases",
		content: makeBuiltinContent(
			"Write tests for a function or component",
			"Write comprehensive tests. Cover:\n- Happy path\n- Edge cases and boundary conditions\n- Error handling\n- Type correctness",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "fix",
		path: "builtin://fix",
		description: "Debug and fix issues with root cause analysis",
		content: makeBuiltinContent(
			"Debug and fix issues with root cause analysis",
			"Debug and fix the following issue. Before making any changes:\n1. Analyze the root cause\n2. List affected files\n3. Propose the fix\n4. After confirming, apply the fix",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "refactor",
		path: "builtin://refactor",
		description: "Refactor code for better readability and maintainability",
		content: makeBuiltinContent(
			"Refactor code",
			"Refactor. Follow these principles:\n- Keep the same external behavior\n- Improve readability and naming\n- Reduce duplication\n- Add type annotations where they improve clarity\n- Maintain backward compatibility",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "doc",
		path: "builtin://doc",
		description: "Add or improve documentation and comments",
		content: makeBuiltinContent(
			"Add or improve documentation",
			"Add or improve documentation. Include:\n- A brief overview of what it does\n- Parameters and return values\n- Usage examples where helpful\n- Edge cases and assumptions",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "explain",
		path: "builtin://explain",
		description: "Explain code or architecture in simple terms",
		content: makeBuiltinContent(
			"Explain code or architecture",
			"Explain in simple terms. Cover:\n- What it does at a high level\n- Key design decisions\n- How it fits into the broader architecture\n- Potential improvements or concerns",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "pi-system",
		path: "builtin://pi-system",
		description: "View pi's default system prompt (identity, tools, guidelines)",
		content: makeBuiltinContent(
			"Pi system prompt",
			"这是 pi 的默认系统提示词——核心身份描述、可用工具列表、行为准则和文档路径，定义了 AI agent 的行为基础。\n\n---\n\nYou are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.\n\nAvailable tools:\n- read: Read file contents\n- bash: Execute bash commands (ls, grep, find, etc.)\n- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call\n- write: Create or overwrite files\n- ask_question: Ask the user a question (or a batch of questions) and wait for responses\n- todo: Manage a todo list (add / toggle / clear)\n- web_search: Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles\n- fetch_content: Use to extract readable content from URL(s), YouTube, GitHub repos, or local videos\n- mcp: MCP gateway - connect to MCP servers and call their tools\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n\nGuidelines:\n- Use bash for file operations like ls, rg, find\n- Use read to examine files instead of cat or sed.\n- Use edit for precise changes\n- Keep edits[].oldText as small as possible while still being unique\n- Be concise in your responses\n- Show file paths clearly when working with files\n\nCurrent date: YYYY-MM-DD\nCurrent working directory: /path/to/project",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "commit",
		path: "builtin://commit",
		description: "Generate a conventional commit message from staged changes",
		content: makeBuiltinContent(
			"Generate a conventional commit message",
			"Generate a conventional commit message from the staged changes (\\`git diff --cached\\`).\nFormat: \\`type(scope): description\\`\n\nTypes: feat, fix, refactor, docs, style, test, chore, perf, ci, build, revert",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "commit-own",
		path: "builtin://commit-own",
		description: "Commit only the files you modified yourself (skip unrelated changes)",
		content: makeBuiltinContent(
			"Commit only the files you modified yourself",
			"Commit only the files and code that I modified myself. Do not stage or commit unrelated changes (e.g. files changed by others, pre-existing edits, generated files, lockfiles you did not touch).\n\nSteps:\n1. Run `git status --short` and `git diff` to inspect all changes.\n2. Identify which changes belong to my own work.\n3. Stage only those specific paths (`git add <file>...`), never a blanket `git add -A`.\n4. Review the staged diff (`git diff --cached`) and confirm it matches my changes.\n5. Write a conventional commit message and commit.\n\nFormat: `type(scope): description`\nTypes: feat, fix, refactor, docs, style, test, chore, perf, ci, build, revert",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "commit-split",
		path: "builtin://commit-split",
		description: "Commit all changes split into multiple commits grouped by feature",
		content: makeBuiltinContent(
			"Commit all changes split by feature",
			"Commit all current changes, splitting them into multiple commits grouped by feature or concern. Each commit must be self-contained and serve a single purpose.\n\nSteps:\n1. Run `git status --short` and `git diff` to list every change.\n2. Group the changed files into logical, independent units (one feature / fix / refactor / chore per group).\n3. Commit each group separately, so no commit mixes unrelated changes.\n4. Order commits sensibly: foundational or refactor work first, then features and fixes, then docs and chore last.\n5. For each group: `git add` only its files, review `git diff --cached`, then commit with a conventional message.\n\nFormat: `type(scope): description`\nTypes: feat, fix, refactor, docs, style, test, chore, perf, ci, build, revert",
		),
		userCreated: false,
		scope: "global",
	},
	{
		name: "skill-discipline",
		path: "builtin://skill-discipline",
		description: "Skills execution discipline: rules for when and how to trigger agent skills",
		content: `---
description: Skills execution discipline: rules for when and how to trigger agent skills
---

# ========================================================================
# Skill Execution Discipline
# ========================================================================

This section defines when and how skills from available_skills should be triggered.
It helps suppress the tendency to "think first, then call a skill", ensuring skills
are invoked promptly when appropriate.

## Core Principle

Available skills are registered in this system. You should and must call them
when appropriate. If unsure whether a skill is needed, follow the rule:
**"Call before thinking"**—the cost of calling a skill is far lower than the risk of missing one.
**Skills are not a substitute for thinking; they are the starting point for thinking.**

## Execution Rules

1. **Trigger and Execute**: When user input matches any description or TRIGGERS
   keyword/scenario in a skill, call it immediately. Do NOT:
   - "Let me reason first, then decide"
   - "This is simple enough, I'll handle it"
   - "I'll give a preliminary answer first"

2. **No Bypassing**: If you catch yourself "answering yourself" instead of
   "calling a skill then answering", pause and re-evaluate.

3. **Priority Order** (conflict resolution):
   P0 — Meta skills (always first)
   P1 — Process discipline (testing, debugging, verification)
   P2 — Problem solving (plans, diagnosis, conflict resolution)
   P3 — Functional tools (browser, file organizer, vault)
   P4 — Design/review (codebase design, domain modeling, code review)
   P5 — Other skills by relevance

4. **Fallback**: When multiple skills might match and you're unsure which to pick,
   call the meta skill or output the candidate list for the user to choose.

## Thinking Inhibition

> Do NOT perform prolonged independent reasoning before calling a skill.
> The right flow: user input → check TRIGGERS → call skill → follow skill instructions

## Recursion Guard
> Each skill is called at most once per conversation turn unless context changes significantly.
> Avoid A calls B, B references A in an infinite loop.`,
		userCreated: false,
		scope: "global",
	},
];

/**
 * 管理 pi 全局 Prompt Templates 目录 (~/.pi/agent/prompts/)。
 * 
 * Prompt Templates 是 markdown 文件，用户可在 pi 中输入 /<name> 快速展开。
 * frontmatter 支持 description、argument-hint 等元数据。
 */
export class PromptManager {
	private promptsDir: string;
	private wslEnvironment: WslEnvironment | null = null;
	/** PiDeck 设置的读取/写入（禁用列表持久化）；未配置时开关不生效（旧行为）。 */
	private settingsProvider: (() => AppSettings) | null = null;
	private settingsPatcher: ((patch: Partial<AppSettings>) => Promise<AppSettings>) | null = null;

	constructor(
		home?: string,
		private readonly translate: PromptCopy = () => "Prompt operation failed.",
	) {
		this.promptsDir = join(home ?? homedir(), ".pi", "agent", "prompts");
	}

	/** 注入 PiDeck 设置读写：启用后 toggle 同步持久化禁用列表（模板白名单模式的依据）。 */
	configureSettings(
		getSettings: () => AppSettings,
		patchSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>,
	) {
		this.settingsProvider = getSettings;
		this.settingsPatcher = patchSettings;
	}

	/** 模板名是否在 PiDeck settings 禁用列表（小写比较；未配置 settings 时视为未禁用）。 */
	private isDisabledInSettings(name: string): boolean {
		if (!this.settingsProvider) return false;
		const key = name.toLowerCase();
		return (this.settingsProvider().disabledPrompts ?? []).some(
			(disabledName) => disabledName.toLowerCase() === key,
		);
	}

	/**
	 * 开关模板：写 PiDeck settings 禁用列表（模板白名单模式 --no-prompt-templates/
	 * --prompt-template 的依据）。内置推荐模板（builtin://，无磁盘文件）不可禁用。
	 */
	async toggle(filePath: string, enabled: boolean): Promise<PiPromptTemplateSummary> {
		const comparablePath = filePath.startsWith("builtin://")
			? filePath
			: await this.resolveExistingGlobalPath(filePath);
		const { templates } = await this.list();
		const template = templates.find((item) => item.path === comparablePath);
		if (!template) throw new Error(this.translate("mainPrompt.fileNotFound"));
		if (template.path.startsWith("builtin://")) {
			throw new Error(this.translate("mainPrompt.builtinCannotDisable"));
		}
		if (this.settingsProvider && this.settingsPatcher) {
			const current = this.settingsProvider().disabledPrompts ?? [];
			const nameKey = template.name.toLowerCase();
			const nextList = current.filter((name) => name.toLowerCase() !== nameKey);
			if (!enabled) nextList.push(template.name);
			await this.settingsPatcher({ disabledPrompts: nextList });
		}
		return { ...template, enabled };
	}

	/** Reads project-local prompt disables; global PiDeck settings must not affect equal project names. */
	private async readProjectDisabledPromptNames(
		projectRoot: string,
		boundary: ProjectFileReadBoundary,
	): Promise<string[]> {
		const settingsFile = join(projectRoot, ".pi", "settings.json");
		if (!existsSync(settingsFile)) return [];
		try {
			const safeSettingsFile = await resolveProjectFileReadPath(boundary, settingsFile);
			const parsed: unknown = JSON.parse(await readFile(safeSettingsFile, "utf8"));
			return isRecord(parsed) ? readDisabledPromptNames(parsed) : [];
		} catch {
			return [];
		}
	}

	/** Toggles one project-owned template by updating that project's whitelist input. */
	async toggleInProject(
		projectPath: string,
		promptName: string,
		enabled: boolean,
	): Promise<PiPromptTemplateSummary> {
		const projectRoot = resolve(this.hostPath(projectPath));
		const boundary = await this.createProjectBoundary(projectRoot);
		const name = this.validProjectPromptName(promptName);
		const target = await this.resolveExistingProjectPath(
			boundary,
			join(projectRoot, ".pi", "prompts", `${name}.md`),
		);
		const settingsFile = await this.resolveProjectWritePath(
			boundary,
			join(projectRoot, ".pi", "settings.json"),
		);
		let settings: Record<string, unknown> = {};
		if (existsSync(settingsFile)) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(await readFile(settingsFile, "utf8"));
			} catch {
				throw new Error(this.translate("mainConfig.invalidJson"));
			}
			if (!isRecord(parsed)) throw new Error(this.translate("mainConfig.invalidJson"));
			settings = parsed;
		}
		const current = readDisabledPromptNames(settings);
		const nameKey = name.toLowerCase();
		const next = current.filter((entry) => entry.toLowerCase() !== nameKey);
		if (!enabled) next.push(name);
		settings.disabledPrompts = next;
		await mkdir(dirname(settingsFile), { recursive: true });
		await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
		const raw = await readFile(target, "utf8");
		const frontmatter = this.parseFrontmatter(raw);
		return {
			name,
			path: target,
			description: (frontmatter.description ?? "").replace(/^["']|["']$/g, "").trim(),
			content: raw,
			userCreated: true,
			scope: "project",
			enabled,
		};
	}

	/** 将 prompt 目录切换到统一解析出的 WSL HOME；null 恢复 Windows home。 */
	configureWsl(environment: WslEnvironment | null) {
		this.wslEnvironment = environment;
		this.promptsDir = join(environment?.windowsHome ?? homedir(), ".pi", "agent", "prompts");
	}

	private async globalBoundary(): Promise<ProjectFileReadBoundary> {
		await mkdir(this.promptsDir, { recursive: true });
		try {
			return await createProjectFileReadBoundary(this.promptsDir);
		} catch {
			throw new Error(this.translate("mainPrompt.globalEditOnly"));
		}
	}

	private async resolveExistingGlobalPath(filePath: string): Promise<string> {
		try {
			return await resolveProjectFileReadPath(await this.globalBoundary(), this.hostPath(filePath));
		} catch {
			throw new Error(this.translate("mainPrompt.globalEditOnly"));
		}
	}

	private async resolveGlobalWritePath(filePath: string): Promise<string> {
		try {
			return await resolveProjectFileWritePath(await this.globalBoundary(), this.hostPath(filePath));
		} catch {
			throw new Error(this.translate("mainPrompt.globalEditOnly"));
		}
	}

	/** 项目路径来自 renderer 的存储格式，Windows fs 边界统一使用当前 WSL 的主机路径。 */
	private hostPath(path: string): string {
		if (
			!this.wslEnvironment ||
			process.platform !== "win32" ||
			(!path.startsWith("/") && !parseWslUncPath(path))
		) {
			return path;
		}
		try {
			return toWindowsHostPath(path, this.wslEnvironment);
		} catch {
			return path;
		}
	}

	private async createProjectBoundary(projectRoot: string): Promise<ProjectFileReadBoundary> {
		try {
			return await createProjectFileReadBoundary(projectRoot);
		} catch {
			throw new Error(this.translate("mainPrompt.globalEditOnly"));
		}
	}

	private async resolveExistingProjectPath(
		boundary: ProjectFileReadBoundary,
		targetPath: string,
	): Promise<string> {
		try {
			return await resolveProjectFileReadPath(boundary, targetPath);
		} catch {
			throw new Error(this.translate("mainPrompt.globalEditOnly"));
		}
	}

	private async resolveProjectWritePath(
		boundary: ProjectFileReadBoundary,
		targetPath: string,
	): Promise<string> {
		try {
			return await resolveProjectFileWritePath(boundary, targetPath);
		} catch {
			throw new Error(this.translate("mainPrompt.globalEditOnly"));
		}
	}

	private validProjectPromptName(value: string): string {
		const raw = value.trim().replace(/\.md$/i, "");
		const normalized = this.normalizeName(raw);
		if (!normalized || normalized !== raw.toLowerCase()) {
			throw new Error(this.translate("mainPrompt.nameRequired"));
		}
		return normalized;
	}

	getDir(): string {
		return this.promptsDir;
	}

	async list(): Promise<PiPromptTemplateListResult> {
		const boundary = await this.globalBoundary();
		const entries = await readdir(this.promptsDir).catch(() => []);
		const templates: PiPromptTemplateSummary[] = [];

		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			if (entry.endsWith(".d.md")) continue;
			let fullPath: string;
			try {
				fullPath = await resolveProjectFileReadPath(boundary, join(this.promptsDir, entry));
			} catch {
				continue;
			}
			const raw = await readFile(fullPath, "utf8").catch(() => "");
			if (!raw) continue;

			const name = basename(entry, ".md");
			const frontmatter = this.parseFrontmatter(raw);
			const description = frontmatter.description ?? raw.split(/\r?\n/).find((line) => line.trim()) ?? "";

			templates.push({
				name,
				path: fullPath,
				description: description.replace(/^["']|["']$/g, "").trim(),
				content: raw,
				userCreated: true,
				scope: "global",
				// 禁用状态 = PiDeck settings 禁用列表（模板白名单模式的依据）
				enabled: !this.isDisabledInSettings(name),
			});
		}

		// 合并内置推荐模板（同名不覆盖用户已有模板）
		const userNames = new Set(templates.map((t) => t.name));
		for (const builtin of BUILTIN_TEMPLATES) {
			if (!userNames.has(builtin.name)) {
				templates.push({ ...builtin, enabled: true });
			}
		}

		// 按 name 排序
		templates.sort((a, b) => a.name.localeCompare(b.name));

		return { templates, globalDir: this.promptsDir };
	}

	async create(input: CreatePiPromptTemplateInput): Promise<PiPromptTemplateSummary> {
		const name = this.normalizeName(input.name);
		if (!name) throw new Error(this.translate("mainPrompt.nameRequiredDetailed"));
		const description = input.description.trim();
		if (!description) throw new Error(this.translate("mainPrompt.descriptionRequired"));

		const filePath = await this.resolveGlobalWritePath(join(this.promptsDir, `${name}.md`));
		if (existsSync(filePath)) throw new Error(this.translate("mainPrompt.alreadyExists", { name }));

		// 内容仅含 frontmatter 中的 description，正文由用户后续在编辑器中编写，不与 skill 重复展示描述
		const content = `---\ndescription: ${description.replace(/\n/g, " ")}\n---\n`;
		await writeFile(filePath, content, "utf8");

		return {
			name,
			path: filePath,
			description,
			content,
			userCreated: true,
		};
	}

	async delete(filePath: string): Promise<void> {
		const candidate = await this.resolveGlobalWritePath(filePath);
		if (!existsSync(candidate)) throw new Error(this.translate("mainPrompt.fileNotFound"));
		const safeFilePath = await this.resolveExistingGlobalPath(candidate);
		// 提示词模板是用户内容：删除走系统回收站（可恢复）；回收站不可用时抛错，拒绝硬删。
		await trashPath(safeFilePath, { source: "prompts:delete" });
	}

	/** 扫描项目 .pi/prompts/ 目录下的模板 */
	async listByProject(projectPath: string): Promise<PiPromptTemplateListResult> {
		const projectRoot = resolve(this.hostPath(projectPath));
		const boundary = await this.createProjectBoundary(projectRoot);
		const lexicalPromptsDir = join(projectRoot, ".pi", "prompts");
		let projectPromptsDir = lexicalPromptsDir;
		if (existsSync(lexicalPromptsDir)) {
			try {
				projectPromptsDir = await resolveProjectFileReadPath(boundary, lexicalPromptsDir);
			} catch {
				return { templates: [], globalDir: lexicalPromptsDir };
			}
		}
		const entries = await readdir(projectPromptsDir, { withFileTypes: true }).catch(() => []);
		const templates: PiPromptTemplateSummary[] = [];
		const disabledNames = new Set(
			(await this.readProjectDisabledPromptNames(projectRoot, boundary)).map((name) => name.toLowerCase()),
		);
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.endsWith(".d.md")) continue;
			let fullPath: string;
			try {
				fullPath = await resolveProjectFileReadPath(boundary, join(lexicalPromptsDir, entry.name));
			} catch {
				continue;
			}
			const raw = await readFile(fullPath, "utf8").catch(() => "");
			if (!raw) continue;
			const name = basename(entry.name, ".md");
			const frontmatter = this.parseFrontmatter(raw);
			const description = frontmatter.description ?? raw.split(/\r?\n/).find((line) => line.trim()) ?? "";

			templates.push({
				name,
				path: fullPath,
				description: description.replace(/^["']|["']$/g, "").trim(),
				content: raw,
				userCreated: true,
				scope: "project",
				enabled: !disabledNames.has(name.toLowerCase()),
			});
		}
		templates.sort((a, b) => a.name.localeCompare(b.name));
		return { templates, globalDir: lexicalPromptsDir };
	}

	/** 在项目 .pi/prompts/ 下创建模板 */
	async createInProject(
		projectPath: string,
		input: CreatePiPromptTemplateInput,
	): Promise<PiPromptTemplateSummary> {
		const projectRoot = resolve(this.hostPath(projectPath));
		const boundary = await this.createProjectBoundary(projectRoot);
		const projectPromptsDir = join(projectRoot, ".pi", "prompts");
		const name = this.normalizeName(input.name);
		if (!name) throw new Error(this.translate("mainPrompt.nameRequiredDetailed"));
		const description = input.description.trim();
		if (!description) throw new Error(this.translate("mainPrompt.descriptionRequired"));
		const filePath = await this.resolveProjectWritePath(
			boundary,
			join(projectPromptsDir, `${name}.md`),
		);
		if (existsSync(filePath)) throw new Error(this.translate("mainPrompt.alreadyExists", { name }));
		await mkdir(dirname(filePath), { recursive: true });
		// 内容仅含 frontmatter 中的 description，正文由用户后续编辑
		const content = `---\ndescription: ${description.replace(/\n/g, " ")}\n---\n`;
		await writeFile(filePath, content, "utf8");
		return {
			name,
			path: filePath,
			description,
			content,
			userCreated: true,
			scope: "project",
		};
	}

	/** 从项目 .pi/prompts/ 删除模板 */
	async deleteFromProject(projectPath: string, promptName: string): Promise<void> {
		const projectRoot = resolve(this.hostPath(projectPath));
		const boundary = await this.createProjectBoundary(projectRoot);
		const name = this.validProjectPromptName(promptName);
		const filePath = await this.resolveExistingProjectPath(
			boundary,
			join(projectRoot, ".pi", "prompts", `${name}.md`),
		);
		// 项目内模板同样走回收站，避免误删后无法恢复。
		await trashPath(filePath, { source: "prompts:delete-project" });
	}

	async openFolder(): Promise<void> {
		await mkdir(this.promptsDir, { recursive: true });
		await shell.openPath(this.promptsDir);
	}

	/**
	 * 读取模板原始内容（供编辑器使用）
	 */
	async readContent(filePath: string): Promise<string> {
		return readFile(await this.resolveExistingGlobalPath(filePath), "utf8");
	}

	/**
	 * 保存模板内容
	 */
	async writeContent(filePath: string, content: string): Promise<void> {
		await writeFile(await this.resolveGlobalWritePath(filePath), content, "utf8");
	}

	private parseFrontmatter(raw: string): Record<string, string> {
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		const result: Record<string, string> = {};
		if (!match) return result;
		for (const line of match[1].split(/\r?\n/)) {
			const index = line.indexOf(":");
			if (index === -1) continue;
			const key = line.slice(0, index).trim();
			let value = line.slice(index + 1).trim();
			value = value.replace(/^['\"]|['\"]$/g, "");
			if (key) result[key] = value;
		}
		return result;
	}

	/** 重命名全局模板：将 <oldName>.md 重命名为 <newName>.md */
	async rename(oldName: string, newName: string): Promise<PiPromptTemplateSummary> {
		const normalizedOld = this.normalizeName(oldName);
		const normalizedNew = this.normalizeName(newName);
		if (!normalizedOld || !normalizedNew) throw new Error(this.translate("mainPrompt.nameRequired"));
		if (normalizedOld === normalizedNew) throw new Error(this.translate("mainPrompt.sameName"));

		const oldCandidate = await this.resolveGlobalWritePath(join(this.promptsDir, `${normalizedOld}.md`));
		const newPath = await this.resolveGlobalWritePath(join(this.promptsDir, `${normalizedNew}.md`));
		if (!existsSync(oldCandidate)) throw new Error(this.translate("mainPrompt.notFound", { name: oldName }));
		const oldPath = await this.resolveExistingGlobalPath(oldCandidate);
		if (existsSync(newPath)) throw new Error(this.translate("mainPrompt.alreadyExists", { name: normalizedNew }));

		await rename(oldPath, newPath);
		// 读取新文件内容返回摘要
		const raw = await readFile(newPath, "utf8");
		const frontmatter = this.parseFrontmatter(raw);
		const description = frontmatter.description ?? "";
		return {
			name: normalizedNew,
			path: newPath,
			description: description.replace(/^["']|["']$/g, "").trim(),
			content: raw,
			userCreated: true,
			scope: "global",
		};
	}

	/** 重命名项目级模板 */
	async renameInProject(projectPath: string, oldName: string, newName: string): Promise<PiPromptTemplateSummary> {
		const projectRoot = resolve(this.hostPath(projectPath));
		const boundary = await this.createProjectBoundary(projectRoot);
		const normalizedOld = this.validProjectPromptName(oldName);
		const normalizedNew = this.normalizeName(newName);
		if (!normalizedOld || !normalizedNew) throw new Error(this.translate("mainPrompt.nameRequired"));
		if (normalizedOld === normalizedNew) throw new Error(this.translate("mainPrompt.sameName"));

		const oldPath = await this.resolveExistingProjectPath(
			boundary,
			join(projectRoot, ".pi", "prompts", `${normalizedOld}.md`),
		);
		const newPath = await this.resolveProjectWritePath(
			boundary,
			join(projectRoot, ".pi", "prompts", `${normalizedNew}.md`),
		);
		if (existsSync(newPath)) throw new Error(this.translate("mainPrompt.alreadyExists", { name: normalizedNew }));

		await rename(oldPath, newPath);
		const raw = await readFile(newPath, "utf8");
		const frontmatter = this.parseFrontmatter(raw);
		const description = frontmatter.description ?? "";
		return {
			name: normalizedNew,
			path: newPath,
			description: description.replace(/^["']|["']$/g, "").trim(),
			content: raw,
			userCreated: true,
			scope: "project",
		};
	}

	/** 规范化模板名称：保留 Unicode 字母（含中文等非拉丁文字）、数字和连字符，其余替换为连字符 */
	private normalizeName(value: string): string {
		return value
			.trim()
			// 替换非（Unicode 字母/数字/连字符）的字符为连字符
			.replace(/[^\p{L}\p{N}-]/gu, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.toLowerCase();
	}
}
