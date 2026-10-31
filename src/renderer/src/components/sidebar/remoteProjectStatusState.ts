/**
 * 远端项目 root 复核状态的收窄（渲染层，设计 (i) 的呈现端）。
 *
 * `rootStatus(projectId)` 是只读查询：ok → 项目级状态；needs-attention → 侧栏给「需处理」提示 + 稳定码。
 * 读不懂就按 unavailable 记：不显示提示，也不编一个码（宁可不打扰，也不能谎报目录已漂移）。
 */

export type RemoteProjectRootStatusView = {
	status: "ok" | "needs-attention" | "unavailable";
	code: string | null;
	/**
	 * hello 声明的能力清单；缺席/读不懂即 null（未知）。远端内容搜索等能力只从这里判定——
	 * 不猜、不回退到"默认支持"。
	 */
	helperCapabilities: readonly string[] | null;
};

/** 一个码就是一个码，绝不是自由文本。 */
const STABLE_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCode(value: unknown): string | null {
	return typeof value === "string" && STABLE_CODE.test(value) ? value : null;
}

/** 能力名与 helper 契约同形：非空、有界、无控制字节；不是字符串的项整体丢弃（宁缺勿猜）。 */
const CAPABILITY = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

function readCapabilities(value: unknown): readonly string[] | null {
	if (!Array.isArray(value)) return null;
	const capabilities: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !CAPABILITY.test(entry)) return null;
		capabilities.push(entry);
	}
	return capabilities;
}

export function readRootStatusResponse(raw: unknown): RemoteProjectRootStatusView {
	if (!isRecord(raw)) return { status: "unavailable", code: null, helperCapabilities: null };
	if (raw.ok === false) return { status: "unavailable", code: readCode(raw.code), helperCapabilities: null };
	if (raw.ok !== true) return { status: "unavailable", code: null, helperCapabilities: null };
	// 现行 IPC 契约是 Op 信封（main 的 opOk 把事实放进 value）；扁平形状仍兼容——它出现在本次迁移
	// 之前的宿主与既有测试里。信封优先：两处字段同时存在时以契约为准，避免读到投机字段。
	const payload: Record<string, unknown> = isRecord(raw.value) ? raw.value : raw;
	// 能力清单是可选诊断：读不懂时按未知处理，不影响 root 状态提示本身。
	const helperCapabilities = readCapabilities(payload.helperCapabilities);
	// code 缺失（或不是稳定码）不影响提示本身：状态才是需要行动的信号，码只是 hint。
	if (payload.status === "ok") return { status: "ok", code: null, helperCapabilities };
	if (payload.status === "needs-attention") return { status: "needs-attention", code: readCode(payload.code), helperCapabilities };
	return { status: "unavailable", code: null, helperCapabilities };
}
