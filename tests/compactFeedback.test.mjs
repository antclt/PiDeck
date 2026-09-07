import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 手动压缩统一策略：可用态、按钮态、错误分类。
 * 圆环按钮 / /compact / 主进程重复压缩共用同一套规则。
 */

const {
	compactUiState,
	resolveCompactUsagePercent,
	classifyCompactError,
} = loadTsCommonJs("src/shared/compactFeedback.ts");

test("compactUiState is ready whenever usage data exists, regardless of occupancy", () => {
	// loadTsCommonJs 在 vm 里跑，对象原型跨 realm，不能 deepEqual 整个对象
	const fields = (percent, compacting) => {
		const state = compactUiState(percent, compacting);
		return `${state.ready}:${state.compacting}:${state.urgency}`;
	};
	// 无占用数据（会话未运行/尚未上报）：未就绪，禁用
	assert.equal(fields(undefined, false), "false:false:idle");
	assert.equal(fields(null, false), "false:false:idle");
	// 数据可用即随时可压缩（不再有 30% 门槛），0% 占用也可点
	assert.equal(fields(0, false), "true:false:idle");
	assert.equal(fields(12, false), "true:false:idle");
	assert.equal(fields(45, false), "true:false:idle");
	// urgency 色阶保留：≥70 黄 / ≥90 红（仅视觉提示）
	assert.equal(fields(70, false), "true:false:warn");
	assert.equal(fields(90, false), "true:false:danger");
	assert.equal(fields(90, true), "true:true:danger");
	// 压缩中：有数据时 ready 保持 true，禁用由 compacting 态负责
	assert.equal(fields(90, true), "true:true:danger");
	// 压缩中 + 无数据：同样未就绪（ready false，且 compacting 也禁用）
	assert.equal(fields(undefined, true), "false:true:idle");
});

test("resolveCompactUsagePercent matches ring occupancy, including zero-percent token fallback", () => {
	assert.equal(resolveCompactUsagePercent(undefined), null);
	assert.equal(resolveCompactUsagePercent({}), null);
	assert.equal(resolveCompactUsagePercent({ contextPercent: 45.3 }), 45.3);
	// 不封顶：pi 按 tokens/window 直接计算，缓存超窗等场景可 >100%（CLI footer 同口径）
	assert.equal(resolveCompactUsagePercent({ contextPercent: 112 }), 112);
	assert.equal(
		resolveCompactUsagePercent({ contextPercent: 0, contextTokens: 0, contextWindow: 1000 }),
		0,
	);
	const recomputed = resolveCompactUsagePercent({
		contextPercent: 0,
		contextTokens: 408,
		contextWindow: 1_000_000,
	});
	assert.ok(recomputed != null && Math.abs(recomputed - 0.0408) < 1e-9);
	// 圆环会显示 ~40%，斜杠 /compact 必须同样不拦截
	const drifted = resolveCompactUsagePercent({
		contextPercent: 0,
		contextTokens: 40_000,
		contextWindow: 100_000,
	});
	assert.equal(drifted, 40);
});

test("no client-side low-usage skip: any reported occupancy reaches the RPC", () => {
	// 不再有 shouldSkipCompactForLowUsage：低占用也由 pi 自行判定
	const feedback = readFileSync("src/shared/compactFeedback.ts", "utf8");
	assert.doesNotMatch(feedback, /COMPACT_READY_PERCENT/);
	assert.doesNotMatch(feedback, /shouldSkipCompactForLowUsage/);
});

test("classifyCompactError maps pi/DSH strings to one notice kind", () => {
	assert.equal(classifyCompactError("nothing to compact"), "nothingToDo");
	assert.equal(classifyCompactError("Already compacted"), "nothingToDo");
	assert.equal(classifyCompactError("session too small to compact"), "tooSmall");
	assert.equal(classifyCompactError("too small"), "tooSmall");
	assert.equal(classifyCompactError("already compacting"), "inProgress");
	assert.equal(classifyCompactError("compaction in progress"), "inProgress");
	assert.equal(classifyCompactError("Compaction cancelled"), "silent");
	assert.equal(classifyCompactError("cancelled"), "silent");
	assert.equal(classifyCompactError("boom"), "failed");
	assert.equal(classifyCompactError(""), "failed");
});

test("meter compact button uses shared ui state and e2e testid", () => {
	const meter = readFileSync("src/renderer/src/components/session/SessionContextMeter.tsx", "utf8");
	assert.match(meter, /from "\.\.\/\.\.\/\.\.\/\.\.\/shared\/compactFeedback"/);
	assert.match(meter, /resolveCompactUsagePercent\(state\)/);
	assert.match(meter, /compactUiState\(context\?\.percent, compacting\)/);
	assert.match(meter, /data-testid="session-context-compact"/);
	assert.match(meter, /sessionContext\.compactNotReady/);
	assert.match(meter, /sessionContext\.compactNotReadyHint/);
	assert.match(meter, /compactDisabled = compactUi\.compacting \|\| !compactUi\.ready/);
});

test("composer compact path toasts done and maps inProgress", () => {
	const composer = readFileSync(
		"src/renderer/src/hooks/useSessionComposerController.ts",
		"utf8",
	);
	assert.match(composer, /function compactNotice/);
	assert.match(composer, /classifyCompactError/);
	// 客户端不再按占用拦截：低占用也发 RPC，由 pi 自行判定
	assert.doesNotMatch(composer, /shouldSkipCompactForLowUsage/);
	assert.match(composer, /app\.compactDone/);
	assert.match(composer, /app\.compactInProgress/);
	assert.match(composer, /app\.compactSessionTooSmall/);
	assert.match(composer, /const runManualCompact = useCallback/);
	assert.match(composer, /await runManualCompact\(target, prompt\)/);
	assert.equal(
		(composer.match(/friendlyCompactError\(error\)/g) || []).length,
		1,
		"error mapping lives in the shared runManualCompact helper",
	);
});

test("pi and dsh compact throw already compacting instead of returning success", () => {
	const pi = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	assert.match(pi, /throw new Error\("already compacting"\)/);
	assert.doesNotMatch(
		pi,
		/Compact skipped: already compacting[\s\S]{0,120}return this\.getRuntimeState\(agentId\)/,
	);
	const dsh = readFileSync("src/main/dsh/DshAgentManager.ts", "utf8");
	assert.match(dsh, /if \(runtime\.isCompacting\) \{\s*\n\s*throw new Error\("already compacting"\)/);
});

test("locales keep compact feedback keys in sync", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	for (const locale of [zh, en]) {
		assert.match(locale, /"app\.compactDone":/);
		assert.match(locale, /"app\.compactInProgress":/);
		assert.match(locale, /"app\.compactNothingToDo":/);
		assert.match(locale, /"app\.compactSessionTooSmall":/);
		assert.match(locale, /"sessionContext\.compactNotReady":/);
		assert.match(locale, /"sessionContext\.compactNotReadyHint":/);
	}
});
