/**
 * useSessionSubagents — pi-subagents 子代理列表数据 hook。
 *
 * 三源合并（主进程 IPC 的 record 记录 + 桥接扩展实时 widget 快照 + 工具调用推导兜底），
 * 输出统一数组供 SessionWidgetsCard 渲染。
 *
 * @module useSessionSubagents
 */

import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import type { PiSubagentEntry } from "../../../shared/types";
import { desktopApi } from "../desktopApi";
import {
	sessionRuntimeUiBySessionIdAtomFamily,
} from "../atoms";

/* ------------------------------------------------------------------ */
/* 纯函数合并逻辑（可单测）                                              */
/* ------------------------------------------------------------------ */

/** 桥接 widget 快照首行 JSON 的形状（扩展字段无额外类型安全）。 */
interface BridgeSnapshot {
	v?: number;
	kind?: string;
	pluginActive?: boolean;
	agents?: Array<{
		id: string;
		type: string;
		description: string;
		status: string;
		toolUses?: number;
		tokens?: number;
		startedAt?: number;
		completedAt?: number;
		result?: string;
		error?: string;
	}>;
}

const VALID_STATUSES = new Set([
	"queued", "running", "completed", "steered", "aborted", "stopped", "error",
]);

function parseBridgeSnapshot(lines: readonly string[] | undefined): {
	pluginActive: boolean | undefined;
	entries: PiSubagentEntry[];
} {
	// 无桥接快照（历史会话无 runtime、或扩展从未推送）≠ 插件不在位：
	// 返回 undefined 三态，让 UI 走中性空态而不是误导性的「未检测到插件」。
	if (!lines || lines.length === 0) return { pluginActive: undefined, entries: [] };
	try {
		const snap: BridgeSnapshot = JSON.parse(lines[0]);
		const pluginActive = snap.pluginActive === true;
		const entries: PiSubagentEntry[] = (snap.agents ?? [])
			.map((a) => {
				const status = VALID_STATUSES.has(a.status ?? "") ? a.status : "queued";
				return {
					id: a.id ?? "",
					type: a.type ?? "",
					description: a.description ?? "",
					status: status as PiSubagentEntry["status"],
					toolUses: typeof a.toolUses === "number" ? a.toolUses : undefined,
					tokens: typeof a.tokens === "number" ? a.tokens : undefined,
					startedAt: typeof a.startedAt === "number" ? a.startedAt : undefined,
					completedAt: typeof a.completedAt === "number" ? a.completedAt : undefined,
					result: typeof a.result === "string" ? a.result : undefined,
					error: typeof a.error === "string" ? a.error : undefined,
					source: "bridge" as const,
				};
			})
			.filter((e) => e.id);
		return { pluginActive, entries };
	} catch {
		return { pluginActive: undefined, entries: [] };
	}
}

export function mergeSubagentEntries(
	records: PiSubagentEntry[],
	bridgeLines: readonly string[] | undefined,
): { merged: PiSubagentEntry[]; pluginActive: boolean | undefined } {
	const bridge = parseBridgeSnapshot(bridgeLines);
	const byId = new Map<string, PiSubagentEntry>();

	// 底座：record（权威终态）
	for (const r of records) {
		byId.set(r.id, r);
	}

	// 覆盖：bridge 快照运行中覆写（更新 toolUses / tokens / running status）
	for (const b of bridge.entries) {
		const existing = byId.get(b.id);
		if (existing) {
			// 仅当 record 不是终态时覆写 status；record 终态（completed/error/...）保持不变
			if (existing.status !== "running" && existing.status !== "queued") {
				continue; // record 已是终态，桥接快照不应倒覆
			}
			// 桥接快照字段缺失时降级为 0，不能用 0 倒覆 record 的真实计数
			byId.set(b.id, {
				...existing,
				status: b.status,
				toolUses: (b.toolUses ?? 0) > 0 ? b.toolUses : existing.toolUses,
				tokens: (b.tokens ?? 0) > 0 ? b.tokens : existing.tokens,
			});
		} else {
			// record 中没有 = 纯桥接条目（如刚创建、尚未来得及落盘）
			byId.set(b.id, b);
		}
	}

	// 排序：运行中置顶 → completed / error / stopped 等终态倒序 → 其余按 startedAt 降序
	const merged = Array.from(byId.values()).sort((a, b) => {
		const aActive = a.status === "running" || a.status === "queued";
		const bActive = b.status === "running" || b.status === "queued";
		if (aActive && !bActive) return -1;
		if (!aActive && bActive) return 1;
		return (b.startedAt ?? 0) - (a.startedAt ?? 0);
	});

	return { merged, pluginActive: bridge.pluginActive };
}

/* ------------------------------------------------------------------ */
/* Hook                                                               */
/* ------------------------------------------------------------------ */

export function useSessionSubagents(
	sessionId: string,
): {
	entries: PiSubagentEntry[];
	pluginActive: boolean | undefined;
	loading: boolean;
} {
	const [loading, setLoading] = useState(false);
	const [records, setRecords] = useState<PiSubagentEntry[]>([]);

	// 桥接实时数据：widgets["pi-deck-subagents"] 的首行 JSON。
	// atom family 按 Record 索引取值，无 runtime UI 记录的会话（如起始页未启动会话）
	// 运行时为 undefined，必须可选链防护，否则整卡渲染崩溃。
	const widgets = useAtomValue(
		sessionRuntimeUiBySessionIdAtomFamily(sessionId),
	)?.widgets;
	const bridgeLines = widgets?.["pi-deck-subagents"] as
		| readonly string[]
		| undefined;

	// 主进程 IPC：拉取 record（初次 / 会话切换时）
	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		desktopApi.sessions
			.listSessionSubagents(sessionId)
			.then((entries) => {
				if (!cancelled) {
					setRecords(entries);
					setLoading(false);
				}
			})
			.catch(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	// 合并
	const { merged, pluginActive } = useMemo(
		() => mergeSubagentEntries(records, bridgeLines),
		[records, bridgeLines],
	);

	return { entries: merged, pluginActive, loading };
}