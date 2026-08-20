/**
 * 会话缓存命中率统计（纯函数，无 IO）：
 * 解析 session JSONL 中所有 assistant 消息的 usage，计算
 * - latest：最后一条 assistant 消息的命中率（与 pi CLI footer 的 latestCacheHitRate 一致）
 * - average：全部 assistant 消息的算术平均命中率（「当前会话平均缓存率」）
 *
 * 命中率口径（与 pi 一致）：cacheRead / (input + cacheRead + cacheWrite) * 100
 */

export type CacheHitStats = {
	/** 最后一条 assistant 消息的命中率（0-100），无样本时为 undefined */
	latest: number | undefined;
	/** 全部 assistant 消息的平均命中率（0-100），无样本时为 undefined */
	average: number | undefined;
	/** 参与统计的 assistant 消息条数 */
	sampleCount: number;
	/** 全部消息文本累计字符数（含 user/assistant 的 text），
	 *  渲染层据此估算「对话占上下文比例」（见 SessionContextMeter）。 */
	messageChars?: number;
};

type UsageLike = {
	input?: number | null;
	cacheRead?: number | null;
	cacheWrite?: number | null;
};

/** 单条 usage → 命中率百分比；无有效 token 数据返回 undefined */
export function hitRateFromUsage(usage: UsageLike | undefined): number | undefined {
	if (!usage) return undefined;
	const input = usage.input ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const promptTokens = input + cacheRead + cacheWrite;
	if (promptTokens <= 0) return undefined;
	return (cacheRead / promptTokens) * 100;
}

/** 从消息对象提取文本字符数：兼容 content 数组（[{type:"text",text}]）与裸 text 字段。
 *  估算用途，无需精确 token 级解析。 */
function messageTextChars(message: {
	role?: unknown;
	usage?: unknown;
	text?: unknown;
	content?: unknown;
}): number {
	let chars = 0;
	if (typeof message.text === "string") chars += message.text.length;
	if (Array.isArray(message.content)) {
		for (const part of message.content) {
			if (
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string"
			) {
				chars += (part as { text: string }).text.length;
			}
		}
	}
	return chars;
}

/**
 * 从 session JSONL 原始文本统计缓存命中率与消息字符数。
 * 逐行解析容忍坏行；命中率只统计带 usage 的 assistant 消息，字符数统计全部消息。
 */
/** 大会话逐行 parse 时每隔这么多行让出事件循环，避免 getRuntimeState 首次扫盘冻窗。 */
const CACHE_HIT_PARSE_YIELD_EVERY = 400;

function accumulateCacheHitStats(raw: string): {
	rates: number[];
	latest: number | undefined;
	messageChars: number;
	lines: string[];
} {
	return {
		rates: [],
		latest: undefined,
		messageChars: 0,
		lines: raw.split(/\r?\n/),
	};
}

function consumeCacheHitLine(
	state: { rates: number[]; latest: number | undefined; messageChars: number },
	line: string,
): void {
	const trimmed = line.trim();
	if (!trimmed) return;
	try {
		const entry = JSON.parse(trimmed) as Record<string, unknown>;
		const message = entry?.message as
			| { role?: unknown; usage?: unknown; text?: unknown; content?: unknown }
			| undefined;
		if (!message) return;
		state.messageChars += messageTextChars(message);
		if (message.role !== "assistant" || !message.usage) return;
		const rate = hitRateFromUsage(message.usage as UsageLike);
		if (rate === undefined) return;
		if (state.latest === undefined) state.latest = rate; // 逆序遍历，首个命中即最后一条
		state.rates.push(rate);
	} catch {
		// 单行解析失败忽略，继续统计其余行
	}
}

function finishCacheHitStats(state: {
	rates: number[];
	latest: number | undefined;
	messageChars: number;
}): CacheHitStats {
	const base: CacheHitStats = {
		latest: state.latest,
		average: undefined,
		sampleCount: 0,
		/** 全部消息文本字符数：始终返回（可能为 0），渲染层据此估算对话占比 */
		messageChars: state.messageChars,
	};
	if (state.rates.length === 0) return base;
	const average = state.rates.reduce((sum, rate) => sum + rate, 0) / state.rates.length;
	return { ...base, average, sampleCount: state.rates.length };
}

export function computeCacheHitStats(raw: string): CacheHitStats {
	const parsed = accumulateCacheHitStats(raw);
	for (let i = parsed.lines.length - 1; i >= 0; i--) {
		consumeCacheHitLine(parsed, parsed.lines[i]);
	}
	return finishCacheHitStats(parsed);
}

/** 与 computeCacheHitStats 同口径，大会话 parse 时每 N 行 setImmediate 让出主线程。 */
export async function computeCacheHitStatsAsync(raw: string): Promise<CacheHitStats> {
	const parsed = accumulateCacheHitStats(raw);
	let processed = 0;
	for (let i = parsed.lines.length - 1; i >= 0; i--) {
		consumeCacheHitLine(parsed, parsed.lines[i]);
		processed += 1;
		if (processed % CACHE_HIT_PARSE_YIELD_EVERY === 0) {
			await new Promise<void>((resolve) => {
				setImmediate(resolve);
			});
		}
	}
	return finishCacheHitStats(parsed);
}

export type CacheHitStatsReader = (sessionPath: string) => Promise<CacheHitStats>;

type FileMeta = { size: number; mtimeMs: number };

type CacheHitStatsReaderInput = {
	readFile: (path: string) => Promise<string>;
	stat: (path: string) => Promise<FileMeta>;
	/** 缓存条目上限，超出时整体清空（会话数远小于该值，防御性上限） */
	maxEntries?: number;
};

/**
 * 创建带文件级缓存的命中率读取器：按 (size, mtimeMs) 判断文件是否变化，
 * 未变化直接复用上次解析结果（O(1)），避免 getRuntimeState 高频调用时
 * 反复读文件 + 逐行 JSON.parse 阻塞主进程。
 */
export function createCacheHitStatsReader(input: CacheHitStatsReaderInput): CacheHitStatsReader {
	const { readFile, stat, maxEntries = 100 } = input;
	const cache = new Map<string, { meta: FileMeta; stats: CacheHitStats }>();

	return async function readCacheHitStats(sessionPath: string): Promise<CacheHitStats> {
		try {
			const meta = await stat(sessionPath);
			const cached = cache.get(sessionPath);
			if (cached && cached.meta.size === meta.size && cached.meta.mtimeMs === meta.mtimeMs) {
				return cached.stats;
			}
			const raw = await readFile(sessionPath);
			const stats = await computeCacheHitStatsAsync(raw);
			if (cache.size >= maxEntries) cache.clear();
			cache.set(sessionPath, { meta, stats });
			return stats;
		} catch {
			// 文件不存在/无法读取：不缓存，返回空统计
			return { latest: undefined, average: undefined, sampleCount: 0 };
		}
	};
}
