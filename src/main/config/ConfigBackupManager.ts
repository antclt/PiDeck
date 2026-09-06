import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import type {
	ConfigBackupActionResult,
	ConfigBackupDetail,
	ConfigBackupListResult,
	ConfigBackupMeta,
	ConfigBackupReason,
} from "../../shared/types/backup";

/**
 * 配置备份管理器：把 pi 配置文件（~/.pi/agent/ 下 models.json / auth.json / settings.json / mcp.json）
 * 与 PiDeck 设置（userData/settings.json）打包成带时间戳的 JSON 备份。
 *
 * 设计要点：
 * - 依赖全部注入（getConfigDir / getUserDataDir / getAppVersion），模块不 import electron，
 *   单测用临时目录驱动（tests/configBackupManager.test.mjs）。
 * - 备份目录 userData/config-backups/，一份备份 = 一个 JSON 文件，保留最近 MAX_BACKUPS 份。
 * - 自动触发：首次使用（first-run）、版本升级（upgrade）、配置保存（on-save，防抖合并）。
 * - 恢复前自动为当前配置建 pre-restore 保护备份：恢复不可逆，必须先留退路。
 * - 「查看」内容脱敏：递归把 key / apiKey / token 等字段打码，token 不进渲染层。
 */
export type ConfigBackupManagerDeps = {
	/** 当前生效的 pi 配置目录（WSL 切换后跟随 configManager.getConfigDir()）。 */
	getConfigDir: () => string;
	/** PiDeck userData 目录（备份目录与 pideck settings.json 都挂在这里）。 */
	getUserDataDir: () => string;
	/** 当前 PiDeck 版本（升级检测用）。 */
	getAppVersion: () => string;
	/** 错误上报（调用方注入 logger，模块自身不输出）。 */
	onError?: (message: string, detail: unknown) => void;
	/** 保存触发的防抖窗口（毫秒）；默认 3000，测试可传短值。 */
	saveDebounceMs?: number;
};

/** 备份文件命名空间前缀：pi 文件与 pideck 文件分开，避免两个 settings.json 同名冲突。 */
export const BACKUP_FILE_KEYS = [
	"pi/models.json",
	"pi/auth.json",
	"pi/settings.json",
	"pi/mcp.json",
	"pideck/settings.json",
] as const;

const BACKUP_DIR_NAME = "config-backups";
const BACKUP_FILE_PREFIX = "backup-";
/** 自动备份保留上限：超出时删除最旧备份（用户可手动删除全部）。 */
export const MAX_BACKUPS = 20;
/** 保存触发的防抖窗口：设置页保存一次会连续写多个文件，合并为一次备份。 */
const SAVE_DEBOUNCE_MS = 3000;

/** 递归脱敏时命中的字段名（值必须为 string 且足够长才替换，避免误伤短标识符）。 */
const SECRET_KEY_NAMES = new Set([
	"key",
	"apiKey",
	"api_key",
	"token",
	"accessToken",
	"refreshToken",
	"secret",
	"password",
	"authorization",
]);

type BackupPackage = {
	version: 1;
	createdAt: string;
	appVersion: string;
	reason: ConfigBackupReason;
	configDir: string;
	/** key 带命名空间（pi/models.json / pideck/settings.json），value 为原始文件文本。 */
	files: Record<string, string>;
};

export class ConfigBackupManager {
	private readonly deps: ConfigBackupManagerDeps;
	/** 保存触发的防抖 timer；null 表示没有待执行的备份。 */
	private saveTimer: NodeJS.Timeout | null = null;
	/** 保存防抖窗口（构造注入，默认 SAVE_DEBOUNCE_MS）。 */
	private readonly saveDebounceMs: number;

	constructor(deps: ConfigBackupManagerDeps) {
		this.deps = deps;
		this.saveDebounceMs = deps.saveDebounceMs ?? SAVE_DEBOUNCE_MS;
	}

	// ── 目录与元数据 ─────────────────────────────────────

	/** 备份目录：userData/config-backups/（跟随应用数据目录，清理/迁移跟着走）。 */
	backupDir(): string {
		return join(this.deps.getUserDataDir(), BACKUP_DIR_NAME);
	}

	/**
	 * 列出全部备份（仅元数据）。损坏/非本应用文件跳过，保证一个坏文件不拖垮整个列表。
	 * 按创建时间倒序（最新在前）。
	 */
	list(): ConfigBackupListResult {
		try {
			const dir = this.backupDir();
			if (!existsSync(dir)) return { ok: true, backups: [] };
			const metas: ConfigBackupMeta[] = [];
			for (const name of readdirSync(dir)) {
				if (!name.startsWith(BACKUP_FILE_PREFIX) || !name.endsWith(".json")) continue;
				const meta = this.readMeta(join(dir, name));
				if (meta) metas.push(meta);
			}
			metas.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
			return { ok: true, backups: metas };
		} catch (error) {
			this.report("list", error);
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** 读取备份详情，文件内容做脱敏（key 打码），token 不进渲染层。 */
	read(id: string): ConfigBackupDetail | null {
		const filePath = this.resolveBackupPath(id);
		if (!filePath) return null;
		try {
			const pkg = JSON.parse(readFileSync(filePath, "utf8")) as BackupPackage;
			const files = Object.entries(pkg.files ?? {}).map(([name, raw]) => {
				const { text, redacted } = redactSecrets(raw, name);
				return { name, raw: text, redacted };
			});
			return {
				id,
				createdAt: pkg.createdAt,
				appVersion: pkg.appVersion,
				reason: pkg.reason,
				size: statSync(filePath).size,
				configDir: pkg.configDir,
				files,
			};
		} catch (error) {
			this.report(`read(${id})`, error);
			return null;
		}
	}

	/**
	 * 创建备份：收集当前生效目录的 pi 配置 + pideck 设置，打包为单文件 JSON。
	 * 创建后执行保留策略（超出 MAX_BACKUPS 删除最旧）。
	 */
	create(reason: ConfigBackupReason): ConfigBackupActionResult {
		try {
			const files = this.collectFiles();
			if (Object.keys(files).length === 0) {
				return { ok: false, error: "no config files to backup" };
			}
			const createdAt = new Date().toISOString();
			// ISO 时间含冒号/点号，Windows 文件名非法，统一压缩为纯数字串。
			// 同毫秒连续创建（如保留策略循环）会碰撞，加序号后缀去重。
			const dir = this.backupDir();
			mkdirSync(dir, { recursive: true });
			const stamp = createdAt.replace(/[^0-9]/g, "");
			let id = `${BACKUP_FILE_PREFIX}${stamp}.json`;
			let seq = 1;
			while (existsSync(join(dir, id))) {
				id = `${BACKUP_FILE_PREFIX}${stamp}-${seq}.json`;
				seq++;
			}
			const pkg: BackupPackage = {
				version: 1,
				createdAt,
				appVersion: this.deps.getAppVersion(),
				reason,
				configDir: this.deps.getConfigDir(),
				files,
			};
			writeFileSync(join(dir, id), JSON.stringify(pkg, null, 2), "utf8");
			this.prune();
			return { ok: true, id };
		} catch (error) {
			this.report(`create(${reason})`, error);
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * 恢复备份：先为当前配置建 pre-restore 保护备份（恢复不可逆，必须先留退路），
	 * 再把包内文件写回对应位置（pi 文件 → 当前配置目录；pideck 设置 → userData）。
	 * @param files 要恢复的文件 key 白名单（如 ["pi/models.json"]）；缺省 = 恢复全部。
	 * 传了但全部不在白名单 → 拒绝恢复（宁可报错也不静默恢复全部）。
	 */
	restore(id: string, files?: string[]): ConfigBackupActionResult {
		const filePath = this.resolveBackupPath(id);
		if (!filePath) return { ok: false, error: "invalid backup id" };
		try {
			const pkg = JSON.parse(readFileSync(filePath, "utf8")) as BackupPackage;
			const guard = this.create("pre-restore");
			// 保护备份建不出来就不恢复：宁可拒绝也不冒「恢复后无退路」的风险。
			if (!guard.ok) return { ok: false, error: `pre-restore backup failed: ${guard.error}` };
			// 恢复目标白名单：files 缺省 = 全部；显式传入时必须命中白名单 key，
			// 非法项直接拒绝（渲染层入参不可信，静默忽略会掩盖错误）。
			const allowed = new Set<string>(BACKUP_FILE_KEYS);
			let targetKeys: readonly string[];
			if (files !== undefined) {
				targetKeys = files.filter((key) => allowed.has(key));
				if (targetKeys.length === 0) {
					return { ok: false, error: "no valid files to restore" };
				}
			} else {
				targetKeys = BACKUP_FILE_KEYS;
			}
			const configDir = this.deps.getConfigDir();
			const userDataDir = this.deps.getUserDataDir();
			for (const key of targetKeys) {
				const raw = pkg.files?.[key];
				// 备份包里没有该 key（备份时文件不存在）→ 跳过，不写空内容。
				if (typeof raw !== "string") continue;
				if (key.startsWith("pi/")) {
					// pi 文件写回当前生效配置目录（WSL 切换后跟随）。
					writeFileSync(join(configDir, key.slice(3)), raw, "utf8");
				} else if (key === "pideck/settings.json") {
					writeFileSync(join(userDataDir, "settings.json"), raw, "utf8");
				}
			}
			return { ok: true, id };
		} catch (error) {
			this.report(`restore(${id})`, error);
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** 删除单个备份。 */
	delete(id: string): ConfigBackupActionResult {
		const filePath = this.resolveBackupPath(id);
		if (!filePath) return { ok: false, error: "invalid backup id" };
		try {
			unlinkSync(filePath);
			return { ok: true };
		} catch (error) {
			this.report(`delete(${id})`, error);
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/** 清空全部备份。 */
	deleteAll(): ConfigBackupActionResult {
		try {
			const dir = this.backupDir();
			if (existsSync(dir)) {
				for (const name of readdirSync(dir)) {
					if (name.startsWith(BACKUP_FILE_PREFIX) && name.endsWith(".json")) {
						unlinkSync(join(dir, name));
					}
				}
			}
			return { ok: true };
		} catch (error) {
			this.report("deleteAll", error);
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * 启动时自动备份检查：
	 * - 无任何备份 → 首次使用，建 first-run 备份；
	 * - 最新备份的版本 ≠ 当前版本 → 已升级，建 upgrade 备份。
	 * 只做一次（结果由备份目录状态决定），失败不阻断启动。
	 */
	ensureInitialBackups(): ConfigBackupActionResult {
		const listed = this.list();
		if (!listed.ok) return listed;
		if (listed.backups.length === 0) {
			return this.create("first-run");
		}
		const latest = listed.backups[0];
		if (latest.appVersion !== this.deps.getAppVersion()) {
			return this.create("upgrade");
		}
		return { ok: true };
	}

	/**
	 * 配置保存后触发：防抖合并（设置页保存一次会连写多个字段/文件），
	 * 防抖窗口内多次保存只产生一份 on-save 备份。fire-and-forget，错误只上报。
	 */
	notifyConfigSaved(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			const result = this.create("on-save");
			if (!result.ok) this.report("notifyConfigSaved", result.error);
		}, this.saveDebounceMs);
		// 主进程长跑：timer 不 prevent 进程退出（应用退出前无需清，进程即止）。
		this.saveTimer.unref?.();
	}

	// ── 内部实现 ─────────────────────────────────────────

	/**
	 * 收集当前备份对象：pi 配置文件（存在才收）+ pideck 设置。
	 * 读原始文本（原样备份，不经过 ConfigManager 的 normalize/校验）。
	 */
	private collectFiles(): Record<string, string> {
		const files: Record<string, string> = {};
		const configDir = this.deps.getConfigDir();
		for (const key of BACKUP_FILE_KEYS) {
			if (key.startsWith("pi/")) {
				const filePath = join(configDir, key.slice(3));
				if (existsSync(filePath)) files[key] = readFileSync(filePath, "utf8");
			} else {
				const filePath = join(this.deps.getUserDataDir(), "settings.json");
				if (existsSync(filePath)) files[key] = readFileSync(filePath, "utf8");
			}
		}
		return files;
	}

	/** 读取单个备份文件的元数据；损坏/结构不对返回 null（列表跳过）。 */
	private readMeta(filePath: string): ConfigBackupMeta | null {
		try {
			const pkg = JSON.parse(readFileSync(filePath, "utf8")) as BackupPackage;
			if (!pkg.createdAt || !pkg.files) return null;
			return {
				id: basename(filePath),
				createdAt: pkg.createdAt,
				appVersion: pkg.appVersion ?? "",
				reason: pkg.reason ?? "manual",
				size: statSync(filePath).size,
				files: Object.keys(pkg.files),
				configDir: pkg.configDir ?? "",
			};
		} catch {
			return null;
		}
	}

	/**
	 * 保留策略：按创建时间保留最近 MAX_BACKUPS 份，删除最旧。
	 * 删除失败不阻断（保留比删除安全），只上报。
	 */
	private prune(): void {
		const listed = this.list();
		if (!listed.ok) return;
		// 只保留最近 MAX_BACKUPS 份，删除更旧的；删除失败不阻断（保留比删除安全）。
		for (const meta of listed.backups.slice(MAX_BACKUPS)) {
			try {
				unlinkSync(join(this.backupDir(), meta.id));
			} catch (error) {
				this.report(`prune(${meta.id})`, error);
			}
		}
	}

	/**
	 * id 安全解析：只接受本应用命名的备份文件（backup-*.json），
	 * 拒绝路径分隔符/上级目录（防路径穿越），并解析为目录内绝对路径。
	 */
	private resolveBackupPath(id: string): string | null {
		if (typeof id !== "string" || !id.startsWith(BACKUP_FILE_PREFIX) || !id.endsWith(".json")) {
			return null;
		}
		if (id.includes("/") || id.includes("\\") || id.includes("..")) return null;
		const filePath = join(this.backupDir(), id);
		return existsSync(filePath) ? filePath : null;
	}

	private report(action: string, error: unknown): void {
		this.deps.onError?.(`[ConfigBackupManager] ${action} failed`, error);
	}
}

/**
 * 递归脱敏：把对象里命中的敏感字段（key/apiKey/token/...）值替换为 `***`。
 * 值必须是 string 且长度 ≥ 8 才替换（避免误伤 "key": "models" 这类短标识符）。
 * 返回 { text, redacted }：text 为脱敏后的 JSON 文本（保留缩进），redacted 标记是否替换过。
 */
export function redactSecrets(raw: string, fileName: string): { text: string; redacted: boolean } {
	// 非 JSON 文件（理论不会出现）原样返回，不做字符串替换（避免误伤正文）。
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { text: raw, redacted: false };
	}
	let redacted = false;
	const walk = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(walk);
		if (value && typeof value === "object") {
			const out: Record<string, unknown> = {};
			for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
				if (SECRET_KEY_NAMES.has(key) && typeof child === "string" && child.length >= 8) {
					out[key] = "***";
					redacted = true;
				} else {
					out[key] = walk(child);
				}
			}
			return out;
		}
		return value;
	};
	const result = walk(parsed);
	// 忽略 fileName：脱敏策略按字段名通用，不按文件名区分（将来新增配置也覆盖）。
	void fileName;
	return { text: JSON.stringify(result, null, 2), redacted };
}
