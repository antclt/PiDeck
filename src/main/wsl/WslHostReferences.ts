import { readFile } from "node:fs/promises";
import { WSL_HOST_CODES, type WslHostReferences } from "./WslHostStore";

/**
 * WSL 档案移除前的引用扫描（项目 + 会话目录）。
 *
 * 与 SSH 的引用扫描同一目的，但字段不同：WSL 引用将写在 `wslHostId`（项目/会话自身或 locator 上）。
 * 读不懂、字段畸形都判 `WSL_HOST_REFERENCE_SCAN_INCOMPLETE`：无法证明「没人引用」时不允许移除。
 */
const HOST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

/** 一个记录可以把自己或 locator 上的 wslHostId 提供给扫描；出现非 UUID 的该字段即判扫描不完整。 */
function collect(record: Record<string, unknown>, into: Set<string>): void {
	const values: unknown[] = [record.wslHostId];
	if (isRecord(record.locator)) values.push(record.locator.wslHostId);
	for (const value of values) {
		if (value === undefined) continue;
		if (typeof value !== "string" || !HOST_ID.test(value)) throw new Error(WSL_HOST_CODES.referenceScanIncomplete);
		into.add(value);
	}
}

async function readRecords(path: string, key: "projects" | "sessions"): Promise<unknown[]> {
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (isMissingFile(error)) return [];
		throw new Error(WSL_HOST_CODES.referenceScanIncomplete);
	}
	if (!isRecord(raw) || !Array.isArray(raw[key])) throw new Error(WSL_HOST_CODES.referenceScanIncomplete);
	return raw[key];
}

export function createWslHostReferenceRegistry(paths: { projectsFile: string; sessionCatalogFile: string }): WslHostReferences {
	return {
		async referencedHostIds(): Promise<ReadonlySet<string>> {
			const ids = new Set<string>();
			for (const [path, key] of [
				[paths.projectsFile, "projects"],
				[paths.sessionCatalogFile, "sessions"],
			] as const) {
				for (const entry of await readRecords(path, key)) {
					if (!isRecord(entry)) throw new Error(WSL_HOST_CODES.referenceScanIncomplete);
					collect(entry, ids);
				}
			}
			return ids;
		},
	};
}
