import { desktopApi } from "../desktopApi";

/**
 * 文件路径存在性判定 store：按需批量 stat 校验的进程内缓存。
 *
 * 设计约束（对应 VS Code filePathLinkifier 的共享 stat cache 思路）：
 * - 键是「绝对路径」；相对路径必须由调用方经 resolveFileLinkPath 解析后再请求，
 *   同一文件多处出现天然命中缓存。
 * - 三态语义：true/false = 已校验；undefined = 未知。校验失败/IPC 异常不写缓存
 *   ——未知时 UI 维持链接形态，宁可多显示一个死链也不能把有效文件误降级成纯文本。
 */

const CACHE_LIMIT = 1024;
const BATCH_MAX = 96;
const FLUSH_DELAY_MS = 250;

type Listener = () => void;

const verdictCache = new Map<string, boolean>();
const listeners = new Set<Listener>();
let pendingPaths: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function notifyListeners(): void {
	for (const listener of [...listeners]) listener();
}

function trimCache(): void {
	// Map 保持插入序：超限时逐出最早写入的键。长会话的路径量有限，
	// 粗粒度逐出足够；精确 LRU 需要每次 get 重排，收益不成比例。
	while (verdictCache.size > CACHE_LIMIT) {
		const oldest = verdictCache.keys().next().value;
		if (oldest === undefined) break;
		verdictCache.delete(oldest);
	}
}

/** 读取判定结果：true/false = 已校验；undefined = 未校验（含校验失败）。 */
export function getFilePathVerdict(absPath: string): boolean | undefined {
	return verdictCache.get(absPath);
}

export function subscribeFilePathVerdicts(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function armFlushTimer(): void {
	if (flushTimer === null) {
		flushTimer = setTimeout(() => {
			flushTimer = null;
			void flushVerdictBatch();
		}, FLUSH_DELAY_MS);
	}
}

/**
 * 批量请求存在性校验：自动过滤已缓存项并去重，250ms 去抖合并后一次 IPC。
 * 结果写回缓存并广播；订阅方（各 anchor）各自 re-read 自己的键。
 */
export function requestFilePathVerdicts(paths: string[]): void {
	let added = false;
	for (const raw of paths) {
		if (!raw || verdictCache.has(raw)) continue;
		if (pendingPaths.includes(raw)) continue;
		pendingPaths.push(raw);
		added = true;
	}
	if (!added) return;
	armFlushTimer();
}

async function flushVerdictBatch(): Promise<void> {
	if (flushing) return;
	const batch = [...new Set(pendingPaths)].slice(0, BATCH_MAX);
	pendingPaths = [];
	if (batch.length === 0) return;
	flushing = true;
	try {
		// 主进程保证返回与入参等长的 boolean[]；防御性兜底把缺失位当未知处理。
		const results = await desktopApi.files.pathsExist(batch);
		batch.forEach((path, index) => {
			const exists = Array.isArray(results) ? results[index] : undefined;
			if (typeof exists === "boolean") verdictCache.set(path, exists);
		});
	} catch {
		// 校验通道不可用（预览模式/窗口关停中）：不留缓存，UI 维持链接形态。
	} finally {
		trimCache();
		flushing = false;
		notifyListeners();
		// 批量请求期间又来了新路径：继续追加调度，直到清空。
		if (pendingPaths.length > 0) armFlushTimer();
	}
}
