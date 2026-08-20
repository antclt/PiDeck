import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 低成本体验包（借鉴 Vercel AI Elements）：
 * 1. Shimmer 微光文本——RespondingIndicator 进行态标签用渐变扫光提示活动进行中；
 * 2. 思考耗时人性化——ThinkingBlock 展示「思考了 Xs / Thought for Xs」，不再裸显工程化数字。
 */

const shimmerSource = readFileSync(
	"src/renderer/src/components/session/ShimmerText.tsx",
	"utf8",
);
const cardsSource = readFileSync(
	"src/renderer/src/components/session/TimelineEventCards.tsx",
	"utf8",
);
const timelineCss = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
const zhCN = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enUS = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("ShimmerText 零依赖 CSS 实现：bg-clip-text + Tailwind 动画，不新增手写 CSS class", () => {
	assert.match(shimmerSource, /export function ShimmerText/);
	assert.match(shimmerSource, /bg-clip-text text-transparent/);
	// 动画走 Tailwind 工具类 + motion-safe（reduced-motion 退化为静态文本）
	assert.match(shimmerSource, /motion-safe:animate-\[shimmer-sweep/);
	// 明暗取语义 token，暗色模式自适应
	assert.match(shimmerSource, /--color-text-tertiary/);
	assert.match(shimmerSource, /--color-text-primary/);
	assert.match(shimmerSource, /--color-warning/);
	// 不引第三方动画库（零依赖约束）
	assert.doesNotMatch(shimmerSource, /from "(framer-motion|motion|gsap)/);
});

test("shimmer-sweep keyframes 定义在 timeline.css（规则允许 keyframes）", () => {
	assert.match(timelineCss, /@keyframes shimmer-sweep/);
});

test("RespondingIndicator 使用 beUI ReasoningText（swap）轮播状态短语", () => {
	// 短语组常量与函数体分开截取（中间隔着 export type）
	const phrasesStart = cardsSource.indexOf("const RESPONDING_PHRASES");
	const phrases = cardsSource.slice(
		phrasesStart,
		cardsSource.indexOf("\n};", phrasesStart) + 3,
	);
	const fnStart = cardsSource.indexOf("export function RespondingIndicator");
	const fn = cardsSource.slice(
		fnStart,
		cardsSource.indexOf("\nexport ", fnStart + 10) || undefined,
	);
	assert.ok(fn, "RespondingIndicator must exist");
	// 四种状态各有 i18n 短语组（waiting 单条 = 不轮播）
	assert.match(phrases, /agent\.loading\.starting1/);
	assert.match(phrases, /agent\.loading\.executing1/);
	assert.match(phrases, /agent\.loading\.responding1/);
	assert.match(phrases, /agent\.loading\.waiting/);
	// 组件使用 beUI ReasoningText + swap 变体；状态切换 key 重建从第一条重新轮播
	assert.match(fn, /ReasoningText/);
	assert.match(fn, /variant="swap"/);
	assert.match(fn, /key=\{kind\}/);
	// 状态判定抽到 deriveRespondingKind（pi / DSH 共用），组件只接线
	assert.match(fn, /deriveRespondingKind/);
	assert.match(fn, /liveTextStreaming/);
	assert.match(fn, /liveThinkingStreaming/);
});

test("RespondingIndicator 轮播短语文案中英同步", () => {
	for (const suffix of ["starting1", "starting2", "starting3", "executing1", "executing2", "executing3", "responding1", "responding2", "responding3", "waiting"]) {
		const key = `agent.loading.${suffix}`;
		assert.match(zhCN, new RegExp(`"${key}":`));
		assert.match(enUS, new RegExp(`"${key}":`));
	}
});

test("ThinkingBlock 耗时改人性化 i18n 文案，不再裸显数字", () => {
	const block = cardsSource.match(
		/function ThinkingBlock[\s\S]*?\n\t\},\n/,
	)?.[0] ?? "";
	assert.ok(block, "ThinkingBlock must exist");
	assert.match(block, /thinking\.duration/);
	// 耗时仍由 startedAt/endedAt 计算（c73f05c7 重构后变量名 durationMs → durationText）
	assert.match(block, /formatDuration\(props\.endedAt - props\.startedAt\)/);
});

test("thinking.duration 文案中英同步", () => {
	assert.match(zhCN, /"thinking\.duration": "思考了 \{duration\}"/);
	assert.match(enUS, /"thinking\.duration": "Thought for \{duration\}"/);
});

test("ThinkingBlock 折叠态把耗时和预览放在同一行，流式默认展开打字机", () => {
	const block = cardsSource.match(
		/function ThinkingBlock[\s\S]*?\n\t\},\n/,
	)?.[0] ?? "";
	assert.ok(block, "ThinkingBlock must exist");
	// 流式默认展开；endedAt 出现后收成单行
	assert.match(block, /props\.defaultExpanded \?\? Boolean\(props\.isStreaming\)/);
	assert.match(block, /if \(props\.endedAt\)/);
	assert.match(block, /if \(props\.isStreaming\) setExpanded\(true\)/);
	// 折叠预览挂在 trigger 行内，展开才渲染 markdown
	assert.match(block, /!expanded && \(/);
	assert.match(block, /<SingleLinePreview/);
	assert.match(block, /showSweep=\{false\}/);
	assert.match(block, /<ChevronRight/);
	assert.doesNotMatch(block, /border-dashed/);
});

test("thinking Brain logo uses thinking-row-icon instead of gray text utilities", () => {
	const block = cardsSource.match(
		/function ThinkingBlock[\s\S]*?\n\t\},\n/,
	)?.[0] ?? "";
	assert.ok(block, "ThinkingBlock must exist");
	assert.match(block, /<Brain size=\{15\} className="thinking-row-icon shrink-0"/);
	assert.doesNotMatch(block, /<Brain[^>]*text-text-secondary/);
});

test("thinking markdown is one size smaller than chat body", () => {
	assert.match(
		timelineCss,
		/\[data-marker-kind="thinking"\] \.markdown-body[\s\S]*?font-size:\s*var\(--font-size-control\)/,
	);
	assert.doesNotMatch(
		timelineCss,
		/\[data-marker-kind="thinking"\] \.markdown-body[\s\S]*?font-size:\s*var\(--font-size-chat\)/,
	);
});
