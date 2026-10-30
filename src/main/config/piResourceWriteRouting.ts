/**
 * 资源写通道的目标路由（task-16）。
 *
 * 缺省/local target 一律返回既有单例（存量行为逐字不变）；非本机 target 才进池，池未装配时回
 * PI_RESOURCE_UNAVAILABLE 而不是退回本机——「回退本机」正是这次要消除的静默错配。
 */

import { PI_RESOURCE_CODES, type PiResourceOptions } from "../../shared/piConfig";
import type { PiResourceManagerPool } from "./PiResourceManagerPool";
import { readPiResourceOptions } from "./piResourceTarget";

export async function resolvePiResourceWriteManager<T>(input: {
	options: unknown;
	pool: PiResourceManagerPool | undefined;
	/** 本机/缺省目标：装配层的既有单例。 */
	local: () => T;
	/** 非本机目标：只从池取该档案的管理器。 */
	pick: (pool: PiResourceManagerPool, parsed: PiResourceOptions) => Promise<T>;
}): Promise<T> {
	const parsed = readPiResourceOptions(input.options);
	const target = parsed.target ?? { kind: "local" };
	if (target.kind === "local") return input.local();
	if (input.pool === undefined) throw new Error(PI_RESOURCE_CODES.unavailable);
	return await input.pick(input.pool, parsed);
}
