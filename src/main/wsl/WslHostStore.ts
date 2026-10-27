import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeDurableJsonFile } from "../persistence/durableJsonStore";
import type { WslHostAddInput, WslHostListItem, WslHostProfile, WslHostUpdateInput } from "../../shared/types/wslHost";

/**
 * WSL 连接档案存储（第 9 步）。
 *
 * 与 `RemoteHostStore` 刻意分开：SSH 的 pin/route/TOFU 语义对 WSL 不成立，混入会让两套信任模型
 * 互相污染。这里只需要「能编辑的本地环境清单 + 引用保护」：
 * - 写入沿用 durable replace（temp + fsync + backup + rename）；
 * - 每次读取都从磁盘重新解码，任何一条畸形记录都判整份无效（fail closed，不静默丢档案）；
 * - 移除前扫描项目/会话引用；仍有引用时拒绝，绝不修改 WSL 内数据；
 * - id 退役后记录在 retired 列表，永不复用。
 */

export const WSL_HOST_CODES = {
	storeInvalid: "WSL_HOST_STORE_INVALID",
	storeBusy: "WSL_HOST_STORE_BUSY",
	notFound: "WSL_HOST_NOT_FOUND",
	invalid: "WSL_HOST_INVALID",
	labelTaken: "WSL_HOST_LABEL_TAKEN",
	referenced: "WSL_HOST_REFERENCED",
	referenceScanIncomplete: "WSL_HOST_REFERENCE_SCAN_INCOMPLETE",
} as const;

const MAX_LABEL = 128;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DISTRO = /^[A-Za-z0-9._-]{1,64}$/u;
const USER = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/u;
const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type Snapshot = { schemaVersion: 1; revision: number; profiles: WslHostProfile[]; retiredHostIds: string[] };

export type WslHostReferences = { referencedHostIds(): Promise<ReadonlySet<string>> };

function invalid(): never {
	throw new Error(WSL_HOST_CODES.invalid);
}

/** 输入边界：主进程与 IPC 共用一套判据，渲染层只是提前提示。 */
export function readWslHostAddInput(value: unknown): WslHostAddInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
	const record = value as Record<string, unknown>;
	const label = typeof record.label === "string" ? record.label.trim() : "";
	const distro = typeof record.distro === "string" ? record.distro.trim() : "";
	const user = typeof record.user === "string" ? record.user.trim() : "";
	if (label.length === 0 || label.length > MAX_LABEL || CONTROL_CHARS.test(label)) invalid();
	if (!DISTRO.test(distro) || !USER.test(user)) invalid();
	return { label, distro, user };
}

export function readWslHostUpdateInput(value: unknown): WslHostUpdateInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
	const record = value as Record<string, unknown>;
	const patch: WslHostUpdateInput = {};
	if (record.label !== undefined) {
		if (typeof record.label !== "string") invalid();
		const label = record.label.trim();
		if (label.length === 0 || label.length > MAX_LABEL || CONTROL_CHARS.test(label)) invalid();
		patch.label = label;
	}
	if (record.distro !== undefined) {
		if (typeof record.distro !== "string" || !DISTRO.test(record.distro.trim())) invalid();
		patch.distro = record.distro.trim();
	}
	if (record.user !== undefined) {
		if (typeof record.user !== "string" || !USER.test(record.user.trim())) invalid();
		patch.user = record.user.trim();
	}
	if (Object.keys(patch).length === 0) invalid();
	return patch;
}

function isProfile(value: unknown): value is WslHostProfile {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		HOST_ID.test(record.id) &&
		typeof record.label === "string" &&
		record.label.length > 0 &&
		record.label.length <= MAX_LABEL &&
		!CONTROL_CHARS.test(record.label) &&
		typeof record.distro === "string" &&
		DISTRO.test(record.distro) &&
		typeof record.user === "string" &&
		USER.test(record.user) &&
		typeof record.createdAt === "string" &&
		ISO.test(record.createdAt) &&
		typeof record.updatedAt === "string" &&
		ISO.test(record.updatedAt)
	);
}

function decodeSnapshot(value: unknown): Snapshot {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(WSL_HOST_CODES.storeInvalid);
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1 || typeof record.revision !== "number" || !Number.isSafeInteger(record.revision) || record.revision < 0) throw new Error(WSL_HOST_CODES.storeInvalid);
	if (!Array.isArray(record.profiles) || !Array.isArray(record.retiredHostIds)) throw new Error(WSL_HOST_CODES.storeInvalid);
	const profiles = record.profiles.filter(isProfile);
	if (profiles.length !== record.profiles.length) throw new Error(WSL_HOST_CODES.storeInvalid);
	const retiredHostIds = record.retiredHostIds.filter((id): id is string => typeof id === "string" && HOST_ID.test(id));
	if (retiredHostIds.length !== record.retiredHostIds.length) throw new Error(WSL_HOST_CODES.storeInvalid);
	const ids = new Set(profiles.map((profile) => profile.id));
	if (ids.size !== profiles.length || retiredHostIds.some((id) => ids.has(id))) throw new Error(WSL_HOST_CODES.storeInvalid);
	return { schemaVersion: 1, revision: record.revision, profiles, retiredHostIds };
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

type JsonRead = { kind: "missing" } | { kind: "invalid" } | { kind: "valid"; value: unknown };

async function readJson(path: string): Promise<JsonRead> {
	try {
		return { kind: "valid", value: JSON.parse(await readFile(path, "utf8")) };
	} catch (error) {
		return isMissingFile(error) ? { kind: "missing" } : { kind: "invalid" };
	}
}

/**
 * 主文件损坏时允许用上一次写入前的备份恢复；两者都不能读时 fail closed。
 * 备份只用于崩溃/半写恢复，不参与「哪份更新」的比较——WSL 档案没有多写者。
 */
async function readSnapshot(file: string, backup: string): Promise<Snapshot> {
	const primary = await readJson(file);
	if (primary.kind === "valid") {
		try {
			return decodeSnapshot(primary.value);
		} catch {
			// fall through to backup
		}
	}
	const restored = await readJson(backup);
	if (restored.kind === "valid") return decodeSnapshot(restored.value);
	// 两份都缺失才是「全新安装」；任何一份存在但读不懂都必须拒绝，不能用空清单覆盖。
	if (primary.kind === "missing" && restored.kind === "missing") return { schemaVersion: 1, revision: 0, profiles: [], retiredHostIds: [] };
	throw new Error(WSL_HOST_CODES.storeInvalid);
}

const writeLocks = new Map<string, Promise<unknown>>();

/** Serialize writers per file inside this process: read-modify-write must not interleave. */
function withFileLock<T>(key: string, task: () => Promise<T>): Promise<T> {
	const previous = writeLocks.get(key) ?? Promise.resolve();
	const next = previous.then(task, task);
	writeLocks.set(
		key,
		next.then(
			() => undefined,
			() => undefined,
		),
	);
	return next;
}

function readHostId(value: unknown): string {
	if (typeof value !== "string" || !HOST_ID.test(value)) throw new Error(WSL_HOST_CODES.notFound);
	return value;
}

function toItem(profile: WslHostProfile): WslHostListItem {
	return { id: profile.id, label: profile.label, distro: profile.distro, user: profile.user };
}

export type WslHostStore = Awaited<ReturnType<typeof createWslHostStore>>;

export async function createWslHostStore(userDataDir: string, options: { references?: WslHostReferences } = {}) {
	const file = join(userDataDir, "wsl-hosts.json");
	const backup = `${file}.bak`;

	const mutate = <T>(change: (snapshot: Snapshot) => Promise<{ next: Snapshot; result: T }> | { next: Snapshot; result: T }): Promise<T> =>
		withFileLock(file, async () => {
			const current = await readSnapshot(file, backup);
			const { next, result } = await change(current);
			const encoded: Snapshot = { schemaVersion: 1, revision: current.revision + 1, profiles: next.profiles, retiredHostIds: next.retiredHostIds };
			await writeDurableJsonFile(file, `${JSON.stringify(encoded, null, 2)}\n`, { backupPath: backup });
			return result;
		});

	return {
		async list(): Promise<WslHostListItem[]> {
			return (await readSnapshot(file, backup)).profiles.map(toItem);
		},
		async add(value: unknown): Promise<WslHostListItem> {
			const input = readWslHostAddInput(value);
			return mutate((snapshot) => {
				if (snapshot.profiles.some((profile) => profile.label === input.label)) throw new Error(WSL_HOST_CODES.labelTaken);
				const now = new Date().toISOString();
				const profile: WslHostProfile = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
				return { next: { ...snapshot, profiles: [...snapshot.profiles, profile] }, result: toItem(profile) };
			});
		},
		async update(idValue: unknown, patchValue: unknown): Promise<WslHostListItem> {
			const id = readHostId(idValue);
			const patch = readWslHostUpdateInput(patchValue);
			return mutate((snapshot) => {
				const index = snapshot.profiles.findIndex((profile) => profile.id === id);
				if (index < 0) throw new Error(WSL_HOST_CODES.notFound);
				if (patch.label !== undefined && snapshot.profiles.some((profile) => profile.id !== id && profile.label === patch.label)) throw new Error(WSL_HOST_CODES.labelTaken);
				const updated: WslHostProfile = { ...snapshot.profiles[index], ...patch, updatedAt: new Date().toISOString() };
				const profiles = snapshot.profiles.map((profile, position) => (position === index ? updated : profile));
				return { next: { ...snapshot, profiles }, result: toItem(updated) };
			});
		},
		async remove(idValue: unknown): Promise<string> {
			const id = readHostId(idValue);
			const references = options.references;
			// 没有引用扫描就无法证明安全移除：fail closed，不提供「强制删除」。
			if (references === undefined) throw new Error(WSL_HOST_CODES.referenceScanIncomplete);
			return mutate(async (snapshot) => {
				if (!snapshot.profiles.some((profile) => profile.id === id)) throw new Error(WSL_HOST_CODES.notFound);
				const referenced = await references.referencedHostIds();
				if (referenced.has(id)) throw new Error(WSL_HOST_CODES.referenced);
				return {
					next: { ...snapshot, profiles: snapshot.profiles.filter((profile) => profile.id !== id), retiredHostIds: [...snapshot.retiredHostIds.filter((retired) => retired !== id), id] },
					result: id,
				};
			});
		},
		async dispose(): Promise<void> {
			// 没有长驻句柄：写锁按文件路径回收，pin/broker 都不存在。
		},
	};
}
