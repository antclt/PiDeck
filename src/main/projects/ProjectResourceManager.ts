import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	createProjectFileReadBoundary,
	resolveProjectFileReadPath,
	resolveProjectFileWritePath,
	type ProjectFileReadBoundary,
} from "../files/projectFileAccess";
import { trashPath } from "../fs/trash";
import type {
	CreateProjectSkillInput,
	PiExtensionSummary,
	PiPromptTemplateSummary,
	PiSkillLocation,
	PiSkillSummary,
	Project,
	ProjectInheritedResourceToggleInput,
	ProjectResourceDirectoryKind,
	ProjectResourceListResult,
	ProjectResourceOverrides,
} from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import {
	emptyProjectResourceOverrides,
	projectResourceOverridesFromRecord,
	setProjectInheritedResourceEnabled,
} from "./projectResourceOverrides";

const SKILL_FILE = "SKILL.md";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate project settings before any resource mutation so malformed JSON is never overwritten. */
async function readProjectSettingsForWrite(
	settingsFile: string,
	invalidJsonMessage: string,
): Promise<Record<string, unknown>> {
	if (!existsSync(settingsFile)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(settingsFile, "utf8"));
	} catch {
		throw new Error(invalidJsonMessage);
	}
	if (!isRecord(parsed)) throw new Error(invalidJsonMessage);
	return parsed;
}

type ProjectProvider = (projectId: string) => Project | undefined;
type ProjectPathResolver = (project: Project) => string;
type ProjectResourceCopy = (
	key: MainProcessTranslationKey,
	params?: Record<string, string | number>,
) => string;

/**
 * 管理单个项目目录内的 pi 资源。
 * 仅扫描/删除项目目录下的 .pi/.agents 资源，避免把全局 skill/extension 混入项目级弹框。
 */
export class ProjectResourceManager {
	constructor(
		private readonly getProject: ProjectProvider,
		private readonly translate: ProjectResourceCopy = () => "Project resource operation failed.",
		private readonly resolveProjectPath: ProjectPathResolver = (project) => project.path,
	) {}

	/** Windows fs 边界使用主机路径；store 里的 WSL Linux 路径在此转换。 */
	private projectRoot(project: Project): string {
		return this.resolveProjectPath(project);
	}

	/** Resolve a renderer-supplied stable id through the registered project catalog. */
	getProjectRoot(projectId: string): string {
		return this.projectRoot(this.requireProject(projectId));
	}

	async list(projectId: string): Promise<ProjectResourceListResult> {
		const project = this.getProject(projectId);
		if (!project) throw new Error(this.translate("project.notFound"));
		// chat 项目没有 .pi/.agents 资源目录，浏览性质从来不适用：list 是纯只读，
		// 返回空列表而非抛错（抛错会让前端技能面板连同全局技能一起整体失败）。
		// 写入操作（createSkill/delete/toggle/rename）仍由 requireProject 拒绝。
		if (project.kind === "chat") {
			return {
				skills: [],
				extensions: [],
				skillLocations: [],
				overrides: emptyProjectResourceOverrides(),
			};
		}
		const settings = await this.readProjectSettings(project);
		const [skills, extensions] = await Promise.all([
			this.listSkills(project, settings),
			this.listExtensions(project, settings),
		]);
		return {
			skills,
			extensions,
			skillLocations: this.skillLocations(project),
			overrides: projectResourceOverridesFromRecord(settings),
		};
	}

	/** Ensure a user-selected project resource directory exists inside the registered root. */
	async ensureResourceDirectory(
		projectId: string,
		kind: ProjectResourceDirectoryKind,
	): Promise<string> {
		const project = this.requireProject(projectId);
		const location = kind === "prompts"
			? join(this.projectRoot(project), ".pi", "prompts")
			: this.skillLocations(project).find((candidate) => candidate.id === kind)?.path;
		if (!location) throw new Error(this.translate("mainProjectResource.pathOutsideProject"));
		const safeDirectory = await this.resolveProjectWritePath(project, location);
		await mkdir(safeDirectory, { recursive: true });
		return this.resolveExistingProjectPath(project, safeDirectory);
	}

	async createSkill(input: CreateProjectSkillInput): Promise<PiSkillSummary> {
		const project = this.requireProject(input.projectId);
		const locations = this.skillLocations(project);
		const location = locations.find((candidate) => candidate.id === input.locationId);
		if (!location) throw new Error(this.translate("mainProjectResource.pathOutsideProject"));
		const normalizedName = this.normalizeSkillName(input.name);
		if (!normalizedName) throw new Error(this.translate("mainProjectResource.skillNameCharacters"));
		// 保留用户原始输入作为显示名；标准化名仅用于目录/文件路径，SKILL.md 内存原始名
		// 这样 readSkill/refresh 后 UI 展示的是用户输入的原始名称，不会被 normalizeSkillName 截断。
		const displayName = input.name.trim();
		const description = input.description.trim();
		if (!description) throw new Error(this.translate("mainSkill.descriptionRequired"));

		const skillDir = await this.resolveProjectWritePath(project, join(location.path, normalizedName));
		if (existsSync(skillDir)) throw new Error(this.translate("mainProjectResource.skillAlreadyExists", { name: normalizedName }));
		await mkdir(skillDir, { recursive: true });
		const skillPath = join(skillDir, SKILL_FILE);
		await writeFile(
			skillPath,
			`---\nname: ${displayName}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n# ${displayName}\n\n## Usage\n\nReplace this section with your skill instructions.\nSee https://agentskills.io/specification for the SKILL.md format.\n`,
			"utf8",
		);
		// 直接构造返回结果，避免 re-read 解析偏差
		const warnings = this.validateSkill(normalizedName, description);
		return {
			id: `${location.id}:${skillPath}`,
			name: displayName,
			description,
			path: skillPath,
			dir: skillDir,
			sourceId: location.id,
			sourceLabel: location.label,
			type: "directory",
			enabled: true,
			valid: warnings.length === 0,
			warnings,
		};
	}

	async deleteSkill(projectId: string, skillPath: string): Promise<void> {
		const project = this.requireProject(projectId);
		const skill = await this.findSkill(project, skillPath);
		const target = await this.resolveExistingProjectPath(
			project,
			skill.type === "directory" ? skill.dir : skill.path,
		);
		// 目录型 skill 代表一个完整能力包；删除走系统回收站（可恢复），拒绝硬删。
		await trashPath(target, { source: "projects:delete-skill" });
	}

	async toggleSkill(projectId: string, skillPath: string, enabled: boolean): Promise<PiSkillSummary> {
		const project = this.requireProject(projectId);
		const skill = await this.findSkill(project, skillPath);
		const safeSkillPath = await this.resolveExistingProjectPath(project, skill.path);
		const settingsFile = await this.resolveProjectWritePath(
			project,
			join(this.projectRoot(project), ".pi", "settings.json"),
		);
		const settings = await readProjectSettingsForWrite(
			settingsFile,
			this.translate("mainConfig.invalidJson"),
		);
		const disabled = Array.isArray(settings.disabledSkills)
			? settings.disabledSkills.filter((name): name is string => typeof name === "string")
			: [];
		const nameKey = skill.name.toLowerCase();
		const nextDisabled = disabled.filter((name) => name.toLowerCase() !== nameKey);
		if (!enabled) nextDisabled.push(skill.name);

		const raw = await readFile(safeSkillPath, "utf8");
		const next = this.setFrontmatterBoolean(raw, "disable-model-invocation", !enabled);
		await writeFile(safeSkillPath, next, "utf8");
		settings.disabledSkills = nextDisabled;
		await mkdir(dirname(settingsFile), { recursive: true });
		await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
		// 重新读取文件，获取最新 frontmatter + 禁用列表状态
		return this.readSkill(
			safeSkillPath,
			this.skillLocations(project).find((l) => l.id === skill.sourceId) ?? this.skillLocations(project)[0],
			skill.type,
			new Set(nextDisabled.map((name) => name.toLowerCase())),
		);
	}

	async toggleExtension(projectId: string, extensionPath: string, enabled: boolean): Promise<void> {
		const project = this.requireProject(projectId);
		const safeRequestedPath = await this.resolveExistingProjectPath(project, extensionPath);
		const extension = (await this.listExtensions(project)).find((item) => item.path === safeRequestedPath);
		if (!extension?.path) throw new Error(this.translate("mainProjectResource.extensionNotFound"));
		await this.resolveExistingProjectPath(project, extension.path);
		const settingsFile = await this.resolveProjectWritePath(
			project,
			join(this.projectRoot(project), ".pi", "settings.json"),
		);
		const settings = await readProjectSettingsForWrite(
			settingsFile,
			this.translate("mainConfig.invalidJson"),
		);
		const disabled = Array.isArray(settings.disabledExtensions)
			? settings.disabledExtensions.filter((source): source is string => typeof source === "string")
			: [];
		if (enabled) {
			settings.disabledExtensions = disabled.filter((source) => source !== extension.source);
		} else if (!disabled.includes(extension.source)) {
			settings.disabledExtensions = [...disabled, extension.source];
		}
		await mkdir(dirname(settingsFile), { recursive: true });
		await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	}

	/** Writes an override for an inherited global resource without touching the global setting. */
	async toggleInheritedResource(
		input: ProjectInheritedResourceToggleInput,
	): Promise<ProjectResourceOverrides> {
		const project = this.requireProject(input.projectId);
		const rawKey = input.key.trim();
		const validSkillKey = /^(?:pi-global|agents-global):[^\u0000\r\n]+$/.test(rawKey);
		const validPlainKey = rawKey.length > 0 && !/[\u0000\r\n]/.test(rawKey);
		const valid = rawKey.length <= 1024 && (input.kind === "skill" ? validSkillKey : validPlainKey);
		if (!valid) throw new Error(this.translate("mainProjectResource.invalidInheritedKey"));
		const key = input.kind === "extension" ? rawKey : rawKey.toLowerCase();
		const settingsFile = await this.resolveProjectWritePath(
			project,
			join(this.projectRoot(project), ".pi", "settings.json"),
		);
		return setProjectInheritedResourceEnabled(
			settingsFile,
			input.kind,
			key,
			input.enabled,
			this.translate("mainConfig.invalidJson"),
		);
	}

	async deleteExtension(projectId: string, extensionPath: string): Promise<void> {
		const project = this.requireProject(projectId);
		const safeRequestedPath = await this.resolveExistingProjectPath(project, extensionPath);
		const extension = (await this.listExtensions(project)).find((item) => item.path === safeRequestedPath);
		if (!extension?.path) throw new Error(this.translate("mainProjectResource.extensionNotFound"));
		const safePath = await this.resolveExistingProjectPath(project, extension.path);
		// 扩展目录删除走系统回收站（可恢复），拒绝硬删。
		await trashPath(safePath, { source: "projects:delete-extension" });
	}

	private async listSkills(
		project: Project,
		settings?: Record<string, unknown>,
	): Promise<PiSkillSummary[]> {
		const effectiveSettings = settings ?? await this.readProjectSettings(project);
		const disabledKeys = this.projectDisabledSkillKeys(effectiveSettings);
		const groups = await Promise.all(
			this.skillLocations(project).map(async (location) => {
				if (!existsSync(location.path)) return [];
				try {
					const boundary = await this.projectBoundary(project);
					const safePath = await resolveProjectFileReadPath(boundary, location.path);
					return this.scanSkillLocation({ ...location, path: safePath }, disabledKeys, boundary);
				} catch {
					return [];
				}
			}),
		);
		return groups.flat().sort((a, b) => a.name.localeCompare(b.name));
	}

	private projectDisabledSkillKeys(settings: Record<string, unknown>): Set<string> {
		if (!Array.isArray(settings.disabledSkills)) return new Set();
		return new Set(
			settings.disabledSkills
				.filter((name): name is string => typeof name === "string")
				.map((name) => name.toLowerCase()),
		);
	}

	private async scanSkillLocation(
		location: PiSkillLocation,
		disabledKeys: Set<string>,
		boundary: ProjectFileReadBoundary,
	): Promise<PiSkillSummary[]> {
		const entries = await readdir(location.path, { withFileTypes: true }).catch(() => []);
		const skills: PiSkillSummary[] = [];
		for (const entry of entries) {
			const fullPath = join(location.path, entry.name);
			if (entry.isDirectory()) {
				await this.collectDirectorySkills(fullPath, location, skills, disabledKeys, boundary);
			} else if (location.rootMarkdownEnabled && entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
				try {
					const safeFile = await resolveProjectFileReadPath(boundary, fullPath);
					skills.push(await this.readSkill(safeFile, location, "markdown", disabledKeys));
				} catch {
					// A nested symlink cannot turn an in-project list operation into an external read.
				}
			}
		}
		return skills;
	}

	private async collectDirectorySkills(
		dir: string,
		location: PiSkillLocation,
		out: PiSkillSummary[],
		disabledKeys: Set<string>,
		boundary: ProjectFileReadBoundary,
	) {
		const skillPath = join(dir, SKILL_FILE);
		if (existsSync(skillPath)) {
			try {
				const safeSkillPath = await resolveProjectFileReadPath(boundary, skillPath);
				out.push(await this.readSkill(safeSkillPath, location, "directory", disabledKeys));
			} catch {
				// Treat an external SKILL.md symlink as absent without reading its target.
			}
			return;
		}
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (entry.isDirectory()) {
				await this.collectDirectorySkills(join(dir, entry.name), location, out, disabledKeys, boundary);
			}
		}
	}

	private async readSkill(
		skillPath: string,
		location: PiSkillLocation,
		type: PiSkillSummary["type"],
		disabledKeys: Set<string> = new Set(),
	): Promise<PiSkillSummary> {
		const raw = await readFile(skillPath, "utf8").catch(() => "");
		const frontmatter = this.parseFrontmatter(raw);
		const name = String(frontmatter.name ?? "").trim();
		const description = String(frontmatter.description ?? "").trim();
		const warnings = this.validateSkill(name, description);
		return {
			id: `${location.id}:${skillPath}`,
			name: name || dirname(skillPath).split(/[\\/]/).pop() || this.translate("mainSkill.unnamed"),
			description,
			path: skillPath,
			dir: dirname(skillPath),
			sourceId: location.id,
			sourceLabel: location.label,
			type,
			// 禁用 = 项目禁用列表 ∪ frontmatter 标记（老版语义，仅阻止自动调用，升级后由
			// 白名单解析器一并排除，显示与加载保持一致）
			enabled:
				frontmatter["disable-model-invocation"] !== "true" &&
				!disabledKeys.has(name.toLowerCase()),
			valid: warnings.length === 0,
			warnings,
		};
	}

	private async listExtensions(
		project: Project,
		settings?: Record<string, unknown>,
	): Promise<PiExtensionSummary[]> {
		const effectiveSettings = settings ?? await this.readProjectSettings(project);
		const lexicalExtensionsDir = join(this.projectRoot(project), ".pi", "extensions");
		let extensionsDir = lexicalExtensionsDir;
		if (existsSync(lexicalExtensionsDir)) {
			try {
				extensionsDir = await resolveProjectFileReadPath(
					await this.projectBoundary(project),
					lexicalExtensionsDir,
				);
			} catch {
				return [];
			}
		}
		const entries = await readdir(extensionsDir, { withFileTypes: true }).catch(() => []);
		const result: PiExtensionSummary[] = [];
		const disabledExts = new Set(
			Array.isArray(effectiveSettings.disabledExtensions)
				? effectiveSettings.disabledExtensions.filter(
					(source): source is string => typeof source === "string",
				)
				: [],
		);
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name.endsWith(".d.ts")) continue;
			const fullPath = join(extensionsDir, entry.name);
			if (entry.isFile() && entry.name.endsWith(".ts")) {
				const ext = this.toExtensionSummary(entry.name, fullPath);
				ext.enabled = !disabledExts.has(ext.source);
				result.push(ext);
				continue;
			}
			if (entry.isDirectory() && existsSync(join(fullPath, "index.ts"))) {
				const ext = this.toExtensionSummary(entry.name, fullPath);
				ext.enabled = !disabledExts.has(ext.source);
				result.push(ext);
			}
		}
		return result.sort((a, b) => a.source.localeCompare(b.source));
	}

	private toExtensionSummary(name: string, path: string): PiExtensionSummary {
		return {
			id: `project:${path}`,
			source: name,
			path,
			scope: "project",
		};
	}

	/** Project-owned skills from the two local skill locations (managed directories only). */
	async listProjectSkills(projectId: string): Promise<PiSkillSummary[]> {
		const project = this.requireProject(projectId);
		if (project.kind === "chat") return [];
		return this.listSkills(project);
	}

	/** Project-owned extension files under <root>/.pi/extensions (managed directories only). */
	async listProjectExtensions(projectId: string): Promise<PiExtensionSummary[]> {
		const project = this.requireProject(projectId);
		if (project.kind === "chat") return [];
		return this.listExtensions(project);
	}

	/** Prompt summaries living under <root>/.pi/prompts (managed directory only). */
	async listProjectPrompts(projectId: string): Promise<PiPromptTemplateSummary[]> {
		const project = this.requireProject(projectId);
		if (project.kind === "chat") return [];
		const boundary = await this.projectBoundary(project);
		const lexicalPromptsDir = join(this.projectRoot(project), ".pi", "prompts");
		let promptsDir = lexicalPromptsDir;
		if (existsSync(lexicalPromptsDir)) {
			try {
				promptsDir = await resolveProjectFileReadPath(boundary, lexicalPromptsDir);
			} catch {
				return [];
			}
		}
		const entries = await readdir(promptsDir, { withFileTypes: true }).catch(() => []);
		const settings = await this.readProjectSettings(project);
		const disabledNames = new Set(
			Array.isArray(settings.disabledPrompts)
				? settings.disabledPrompts.filter((name): name is string => typeof name === "string")
				: [],
		);
		const templates: PiPromptTemplateSummary[] = [];
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
			const name = entry.name.slice(0, -3);
			const frontmatter = this.parseFrontmatter(raw);
			const description = frontmatter.description ?? raw.split(/\r?\n/).find((line) => line.trim()) ?? "";
			templates.push({
				name,
				path: fullPath,
				description: description.replace(/^['"]|['"]$/g, "").trim(),
				content: raw,
				userCreated: true,
				scope: "project",
				enabled: !disabledNames.has(name.toLowerCase()),
			});
		}
		return templates.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * 只读的运行时资源描述（packages、settings 显式路径、祖先 .agents/skills）。
	 * 与 pi 0.85 resolver 共用同一发现实现，让管理页能看到 pi 实际会加载的资源。
	 */
	async discovery(projectId: string) {
		const project = this.requireProject(projectId);
		if (project.kind === "chat") {
			return {
				skills: [],
				prompts: [],
				extensions: [],
			};
		}
		const { discoverSkills, discoverPrompts, discoverExtensions } = await import("../resourceDiscovery");
		return {
			skills: discoverSkills({
				cwd: this.projectRoot(project),
				includeProjectResources: true,
			}),
			prompts: discoverPrompts({
				cwd: this.projectRoot(project),
				includeProjectResources: true,
			}),
			extensions: discoverExtensions({
				cwd: this.projectRoot(project),
				includeProjectResources: true,
			}),
		};
	}

	private skillLocations(project: Project): PiSkillLocation[] {
		return [
			{
				id: "project-pi",
				label: ".pi/skills",
				path: join(this.projectRoot(project), ".pi", "skills"),
				rootMarkdownEnabled: true,
			},
			{
				id: "project-agents",
				label: ".agents/skills",
				path: join(this.projectRoot(project), ".agents", "skills"),
				rootMarkdownEnabled: false,
			},
		];
	}

	private requireProject(projectId: string) {
		const project = this.getProject(projectId);
		if (!project) throw new Error(this.translate("project.notFound"));
		if (project.kind === "chat") throw new Error(this.translate("mainProjectResource.chatUnsupported"));
		return project;
	}

	/** 重命名项目级 Skill：重命名目录并更新 SKILL.md 中的 name 字段 */
	async renameSkill(projectId: string, skillPath: string, newName: string): Promise<PiSkillSummary> {
		const project = this.requireProject(projectId);
		const skill = await this.findSkill(project, skillPath);
		const normalizedNew = this.normalizeSkillName(newName);
		if (!normalizedNew) throw new Error(this.translate("mainSkill.nameRequired"));

		const displayName = newName.trim();
		const oldDir = await this.resolveExistingProjectPath(project, skill.dir);
		const safeSkillPath = await this.resolveExistingProjectPath(project, skill.path);
		const parentDir = dirname(oldDir);
		const newDir = await this.resolveProjectWritePath(project, join(parentDir, normalizedNew));

		if (oldDir === newDir) throw new Error(this.translate("mainSkill.sameName"));
		if (existsSync(newDir)) throw new Error(this.translate("mainProjectResource.skillAlreadyExists", { name: normalizedNew }));

		// 更新 SKILL.md 中的 name frontmatter
		const raw = await readFile(safeSkillPath, "utf8");
		const updated = this.setFrontmatterName(raw, displayName);
		await writeFile(safeSkillPath, updated, "utf8");

		await rename(oldDir, newDir);

		// 重命名后重新读取
		const newSkillPath = join(newDir, SKILL_FILE);
		return this.readSkill(newSkillPath, this.skillLocations(project).find((l) => newSkillPath.startsWith(l.path)) ?? this.skillLocations(project)[0], skill.type);
	}

	/** 更新 frontmatter 中的 name 字段 */
	private setFrontmatterName(raw: string, name: string): string {
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!match) return `---\nname: ${name}\n---\n\n${raw}`;
		const lines = match[1].split(/\r?\n/);
		const nextLines = lines.map((line) => {
			if (line.trim().startsWith("name:")) return `name: ${name}`;
			return line;
		});
		return raw.replace(match[0], `---\n${nextLines.join("\n")}\n---`);
	}

	private async findSkill(project: Project, skillPath: string) {
		const safeRequestedPath = await this.resolveExistingProjectPath(project, skillPath);
		const skill = (await this.listSkills(project)).find((item) => item.path === safeRequestedPath);
		if (!skill) throw new Error(this.translate("mainProjectResource.skillNotFound"));
		return skill;
	}

	private async readProjectSettings(project: Project): Promise<Record<string, unknown>> {
		const settingsFile = join(this.projectRoot(project), ".pi", "settings.json");
		if (!existsSync(settingsFile)) return {};
		try {
			const safeSettingsFile = await resolveProjectFileReadPath(
				await this.projectBoundary(project),
				settingsFile,
			);
			const parsed: unknown = JSON.parse(await readFile(safeSettingsFile, "utf8"));
			return isRecord(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}

	private async projectBoundary(project: Project): Promise<ProjectFileReadBoundary> {
		try {
			return await createProjectFileReadBoundary(this.projectRoot(project));
		} catch {
			throw new Error(this.translate("mainProjectResource.pathOutsideProject"));
		}
	}

	private async resolveExistingProjectPath(project: Project, targetPath: string): Promise<string> {
		try {
			return await resolveProjectFileReadPath(await this.projectBoundary(project), targetPath);
		} catch {
			throw new Error(this.translate("mainProjectResource.pathOutsideProject"));
		}
	}

	private async resolveProjectWritePath(project: Project, targetPath: string): Promise<string> {
		try {
			return await resolveProjectFileWritePath(await this.projectBoundary(project), targetPath);
		} catch {
			throw new Error(this.translate("mainProjectResource.pathOutsideProject"));
		}
	}

	private parseFrontmatter(raw: string) {
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		const result: Record<string, string> = {};
		if (!match) return result;
		for (const line of match[1].split(/\r?\n/)) {
			const index = line.indexOf(":");
			if (index === -1) continue;
			const key = line.slice(0, index).trim();
			let value = line.slice(index + 1).trim();
			value = value.replace(/^[\'"]|[\'"]$/g, "");
			if (key) result[key] = value;
		}
		return result;
	}

	private validateSkill(name: string, description: string) {
		const warnings: string[] = [];
		if (!name) warnings.push(this.translate("mainSkill.warningNameRequired"));
		if (name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
			warnings.push(this.translate("mainProjectResource.warningNameCharacters"));
		}
		if (name.length > 64) warnings.push(this.translate("mainSkill.warningNameTooLong"));
		if (!description) warnings.push(this.translate("mainSkill.warningDescriptionRequired"));
		if (description.length > 1024) warnings.push(this.translate("mainSkill.warningDescriptionTooLong"));
		return warnings;
	}

	private setFrontmatterBoolean(raw: string, key: string, value: boolean) {
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!match) return `---\n${key}: ${value}\n---\n\n${raw}`;
		const lines = match[1].split(/\r?\n/);
		let changed = false;
		const nextLines = lines.map((line) => {
			if (!line.trim().startsWith(`${key}:`)) return line;
			changed = true;
			return `${key}: ${value}`;
		});
		if (!changed) nextLines.push(`${key}: ${value}`);
		return raw.replace(match[0], `---\n${nextLines.join("\n")}\n---`);
	}

	private normalizeSkillName(value: string) {
		return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
	}
}
