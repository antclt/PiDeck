/**
 * 开发诊断快照：设置里打开「性能诊断」后，主进程按固定间隔采样，
 * 给设置页一份可对照的数据（内存 / 事件循环延迟 / 最近关键耗时）。
 * 默认关闭，生产零开销。
 */

export type DiagnosticsEventTiming = {
	/** 事件名，如 agent.create / session.history.load */
	name: string;
	/** 开始时刻 epoch ms */
	startedAt: number;
	/** 耗时 ms */
	durationMs: number;
	detail?: Record<string, string | number | boolean | null>;
};

export type DiagnosticsSnapshot = {
	enabled: boolean;
	sampledAt: number;
	/** 主进程 RSS / 堆（字节） */
	main: {
		rssBytes: number;
		heapUsedBytes: number;
		heapTotalBytes: number;
		externalBytes: number;
		arrayBuffersBytes: number;
	};
	/** 最近一次事件循环延迟（setImmediate 往返），ms */
	eventLoopLagMs: number;
	/** 采样窗口内的最大事件循环延迟，ms */
	eventLoopLagMaxMs: number;
	/** 内存 CSV 路径；未开内存采样时为 null */
	memoryProfilePath: string | null;
	/** 事件耗时 JSONL 路径；未开诊断时为 null */
	timingsPath: string | null;
	/** 最近若干条关键耗时（新→旧） */
	recentTimings: DiagnosticsEventTiming[];
};
