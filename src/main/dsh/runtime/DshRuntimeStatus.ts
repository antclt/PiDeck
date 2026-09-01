/**
 * DSH runtime 安装态探测与状态服务（AgentRuntimeProvider 阶段 1）。
 *
 * 阶段 1：dsh runtime（28 个 @deepseek-ai/* 依赖）仍随包分发，探测结果恒 installed；
 * 本模块先把「runtime 是否可用」做成一等状态源，UI 据此门控（见 shared/types/dshRuntime）。
 * 阶段 2 状态源切换为「外部 runtime 目录 manifest 探测 + app 内置 node_modules 回退」时，
 * 消费方（IPC / 渲染层）零改动。
 *
 * 探测锚点与 DshHost.start 完全一致：createRequire(appPath).resolve("@deepseek-ai/dsh-base")
 * ——同一接缝（--dsh-node-modules 的 appRoot 推导），保证「探测可用 = host 可 fork」。
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
	DshRuntimeSource,
	DshRuntimeState,
	DshRuntimeStatus,
} from "../../../shared/types/dshRuntime";

/** 探测结果：ok 时给出 runtime node_modules 锚点（appRoot，与 DshHost 的 appRoot 同源）。 */
export type DshRuntimeProbeResult =
	| { ok: true; appRoot: string }
	| { ok: false; error: string };

/**
 * 一次完整的 runtime 探测结果（外部 runtime 优先，内置回退）。
 * appRoot 语义与阶段 1 一致：包含 node_modules 的那个目录（DshHost 拿它拼
 * `--dsh-node-modules`，hostEntry 再从它建 createRequire）。
 */
export type DshRuntimeProbe =
	| { ok: true; appRoot: string; source: DshRuntimeSource; runtimeVersion?: string; installDir?: string }
	| { ok: false; error: string };

/**
 * 组合探测：外部已安装 runtime 优先，未安装时回退 app 内置 node_modules。
 *
 * 为什么保留内置回退：阶段 2 的依赖分区（把 @deepseek-ai 移入 devDependencies）
 * 是最后一步，在那之前存量安装包里仍然内置 runtime；有回退才能保证「装了新版
 * PiDeck 但还没下载 runtime」的用户 DSH 功能不消失。依赖分区完成后内置探测
 * 恒失败，行为自动退化为纯外部模式，无需再改这里。
 */
export function probeDshRuntime(input: {
	/** 外部 runtime（DshRuntimeManager.resolveActive）；undefined = 未安装。 */
	managed?: { nodeModules: string; runtimeVersion: string };
	/** app 内置 runtime 探测结果。 */
	bundled: DshRuntimeProbeResult;
}): DshRuntimeProbe {
	if (input.managed) {
		return {
			ok: true,
			// node_modules 的上一级才是 appRoot（与 bundled 分支的 dirname×3 对齐）。
			appRoot: dirname(input.managed.nodeModules),
			// 版本目录（runtimesRoot/<version>）即安装落盘位置，UI 概览页展示/打开用。
			installDir: dirname(input.managed.nodeModules),
			source: "managed",
			runtimeVersion: input.managed.runtimeVersion,
		};
	}
	if (input.bundled.ok) {
		return { ok: true, appRoot: input.bundled.appRoot, source: "builtin" };
	}
	return { ok: false, error: input.bundled.error };
}

/**
 * 探测 app 内置 dsh runtime（纯探测，不抛错）：
 * dev = 项目 node_modules；打包 = app.asar(unpacked) 内 node_modules。
 * 失败 = runtime 不在（阶段 2 lite 分发 / 依赖被移除），映射为 notInstalled。
 */
export function probeBundledDshRuntime(appPath: string): DshRuntimeProbeResult {
	try {
		// 与 DshHost.start 相同的解析链：从 appPath 建 require 再解析 dsh-base，
		// 避免主进程产物（CJS）自身解析路径与 host fork 时产生分叉。
		const require = createRequire(join(appPath, "package.json"));
		const basePkgPath = require.resolve("@deepseek-ai/dsh-base/package.json");
		return { ok: true, appRoot: dirname(dirname(dirname(basePkgPath))) };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** 探测结果 → 安装态映射（纯函数，单测覆盖）。阶段 2 增补 manifest 兼容区间判定 → broken。 */
export function dshRuntimeStateFromProbe(probe: DshRuntimeProbeResult): DshRuntimeState {
	return probe.ok ? "installed" : "notInstalled";
}

/**
 * DSH runtime 状态服务：进程内缓存探测结果 + 变更订阅。
 * 阶段 1 状态在进程生命周期内不变（内置分发）；阶段 2 安装/卸载/更新后调 refresh()
 * 重探测并广播，渲染层经 dsh-runtime:status-changed 收到推送。
 */
export class DshRuntimeStatusService {
	private current: DshRuntimeStatus | null = null;
	private readonly listeners = new Set<(status: DshRuntimeStatus) => void>();

	/**
	 * @param getAppPath 内置 runtime 的解析起点（app.asar / 项目根）。
	 * @param log 日志出口。
	 * @param resolveManaged 外部 runtime 解析（阶段 2：DshRuntimeManager.resolveActive）。
	 *   缺省 = 纯内置模式（阶段 1 形态，也是不装 runtime 时的自然退路）。
	 */
	constructor(
		private readonly getAppPath: () => string,
		private readonly log: (scope: string, message: string, detail?: unknown) => void = () => {},
		private readonly resolveManaged: () =>
			| { nodeModules: string; runtimeVersion: string }
			| undefined = () => undefined,
	) {}

	/** 当前状态（首次调用探测并缓存；IPC 查询走这里）。 */
	getStatus(): DshRuntimeStatus {
		this.current ??= this.probeOnce();
		return this.current;
	}

	/**
	 * 供 DshHost 取 runtime 锚点（appRoot，即包含 node_modules 的目录）。
	 * 与 getStatus 共用同一份探测结果，避免「状态说装了、host 却找不到路径」的分叉。
	 */
	resolveAppRoot(): string | undefined {
		const probe = this.probeOnceFresh();
		return probe.ok ? probe.appRoot : undefined;
	}

	/** 是否允许新建 DSH 会话（门控判定的唯一入口，避免调用方各自比对状态枚举）。 */
	canCreateDshSession(): boolean {
		return this.getStatus().state === "installed";
	}

	/** 订阅状态变更（返回退订函数）。 */
	subscribe(listener: (status: DshRuntimeStatus) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/**
	 * 重探测并广播（阶段 2 安装/卸载/更新后调用）。
	 * 状态未变化时不广播，避免无意义的 UI 重渲染。
	 */
	refresh(): DshRuntimeStatus {
		const next = this.probeOnce();
		const changed =
			this.current?.state !== next.state ||
			this.current?.runtimeVersion !== next.runtimeVersion ||
			this.current?.source !== next.source;
		this.current = next;
		if (changed) {
			this.log("dsh-runtime", `runtime status changed: ${next.state}`, { source: next.source });
			for (const listener of this.listeners) {
				try {
					listener(next);
				} catch {
					// 订阅者异常不影响后续广播
				}
			}
		}
		return next;
	}

	/** 探测一次并返回状态快照（不写缓存，供 resolveAppRoot 这类旁路查询用）。 */
	private probeOnceFresh(): DshRuntimeProbe {
		return probeDshRuntime({
			managed: this.resolveManaged(),
			bundled: probeBundledDshRuntime(this.getAppPath()),
		});
	}

	private probeOnce(): DshRuntimeStatus {
		const probe = this.probeOnceFresh();
		if (probe.ok) {
			return {
				state: "installed",
				source: probe.source,
				...(probe.runtimeVersion ? { runtimeVersion: probe.runtimeVersion } : {}),
				// 外部 managed runtime 时给出落盘目录（runtimesRoot/<version>），UI 概览页展示/打开用；
				// builtin 内置分发没有独立安装目录（在 app.asar 内），不填。
				...(probe.source === "managed" && probe.installDir ? { installDir: probe.installDir } : {}),
			};
		}
		// 两者都没有 = 未安装 runtime（阶段 2 依赖分区后的常态）。
		this.log("dsh-runtime", "dsh runtime not available", { error: probe.error });
		return { state: "notInstalled" };
	}
}
