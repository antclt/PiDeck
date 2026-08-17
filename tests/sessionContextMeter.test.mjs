import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { formatPercent } from "../src/renderer/src/components/session/TimelineFormat.ts";

// 与 sessionWidgetChips.test.mjs 相同的 TSX 编译替身模式：只测公开 helper 与源码结构。
function compile(filePath, stubs = {}) {
  const source = readFileSync(filePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: filePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => stubs[specifier] ?? {};
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: localRequire,
    console,
  }, { filename: filePath });
  return module.exports;
}

const meterPath = "src/renderer/src/components/session/SessionContextMeter.tsx";
const meterSource = () => readFileSync(meterPath, "utf8");
const bottomBarSource = () =>
  readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
const zh = () => readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = () => readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

function loadMeterHelpers() {
  return compile(meterPath, {
    react: {},
    "../../i18n": { t: (key) => key },
    "../../../../shared/types": {},
    "../ui-shadcn/tooltip": {},
  });
}

test("formatTokens follows the dsh StatsLine compaction", () => {
  const { formatTokens } = loadMeterHelpers();
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1K");
  assert.equal(formatTokens(1234), "1.2K");
  // dsh 语义：≥100 直接取整（123.4K → 123K），不保留小数
  assert.equal(formatTokens(123400), "123K");
  assert.equal(formatTokens(999500), "1000K");
  assert.equal(formatTokens(1_000_000), "1M");
  assert.equal(formatTokens(128_000_000), "128M");
  assert.equal(formatTokens(12_400_000), "12.4M");
});

test("contextOccupancy keeps raw percent and recomputes zero percent from tokens", () => {
  const { contextOccupancy } = loadMeterHelpers();
  const occ = (state) => contextOccupancy(state);
  // vm 跨 realm 对象原型不同，deepEqual 会误判，按字段断言
  const fieldsOf = (state) => {
    const result = occ(state);
    return result === null ? null : `${result.percent}:${result.usedTokens}:${result.contextWindow}`;
  };
  // 常规：percent 保留原始精度（不再四舍五入成整数）
  assert.equal(fieldsOf({ contextPercent: 45.3, contextTokens: 57600, contextWindow: 128000 }), "45.3:57600:128000");
  // 超过 100 封顶（主进程可能上报未封顶的估算值）
  assert.equal(fieldsOf({ contextPercent: 112, contextTokens: 100, contextWindow: 200 }), "100:100:200");
  // percent 上报为 0 但 tokens 非 0（pi/dsh 取整成 0 或未随 tokens 刷新）：
  // 按 tokens/window 重算，避免「占用 0% 但 ~408 / 1M」的自相矛盾展示
  const recomputed = occ({ contextPercent: 0, contextTokens: 408, contextWindow: 1_000_000 });
  assert.ok(recomputed !== null && Math.abs(recomputed.percent - 0.0408) < 1e-9);
  assert.equal(recomputed.usedTokens, 408);
  // tokens 为 0 时保持 0，不重算
  assert.equal(fieldsOf({ contextPercent: 0, contextTokens: 0, contextWindow: 1000 }), "0:0:1000");
  // 缺任一字段 = 无 capacity（模型切换瞬间），返回 null 不渲染
  assert.equal(occ(undefined), null);
  assert.equal(occ({ contextPercent: 50 }), null);
  assert.equal(occ({ contextTokens: 50, contextWindow: 100 }), null);
  assert.equal(occ({ contextPercent: 50, contextTokens: 50 }), null);
});

test("formatPercent keeps sub-percent precision for small context usage", () => {
  // 1M 窗口下 408 tokens ≈ 0.04%：整数四舍五入会显示成「0%」，必须保留有效数字
  assert.equal(formatPercent(0.0408), "0.04");
  assert.equal(formatPercent(0), "0");
  assert.equal(formatPercent(0.004), "0"); // 两位小数后仍为 0
  assert.equal(formatPercent(0.996), "1");
  assert.equal(formatPercent(1), "1");
  assert.equal(formatPercent(1.26), "1.3");
  assert.equal(formatPercent(9.94), "9.9");
  assert.equal(formatPercent(10), "10");
  assert.equal(formatPercent(45), "45");
  assert.equal(formatPercent(45.3), "45");
  assert.equal(formatPercent(100), "100");
});

test("meter ring follows the dsh geometry: 14px viewBox, r=5.5, 2px stroke, top-start fill", () => {
  const source = meterSource();
  // 几何常量与 svg 结构（dsh ContextMeter 逐字节移植）
  assert.match(source, /const RADIUS = 5\.5/);
  assert.match(source, /CIRCUMFERENCE = 2 \* Math\.PI \* RADIUS/);
  assert.match(source, /viewBox="0 0 14 14" width="14" height="14"/);
  assert.match(source, /strokeDasharray=\{`\$\{CIRCUMFERENCE \* percent \/ 100\} \$\{CIRCUMFERENCE\}\`\}/);
  assert.match(source, /transform="rotate\(-90 7 7\)"/);
  // 28px 圆形点击区（与附件按钮同族）+ 无 capacity 不渲染
  assert.match(source, /size-7 flex-none place-items-center rounded-full/);
  assert.match(source, /if \(context === null\) return null/);
  // 打开期间挂 document 监听（外点/Escape 关闭）
  assert.match(source, /addEventListener\("pointerdown", onPointerDown\)/);
  assert.match(source, /addEventListener\("keydown", onKeyDown\)/);
});

test("contextSegments prefers host breakdown and falls back to estimate split", () => {
  const { contextSegments } = loadMeterHelpers();
  const seg = (state) => {
    const result = contextSegments(state);
    if (result === null) return null;
    return result.kind === "breakdown"
      ? `breakdown:${result.system}:${result.tools}:${result.conversation}`
      : `estimate:${result.conversation}:${result.systemTools}`;
  };
  // host contextBreakdown 投影（dsh）：系统/工具/对话三段直接可用，0 也是有效值
  assert.equal(
    seg({ contextSystemTokens: 2400, contextToolsTokens: 1800, contextMessageTokens: 57600 }),
    "breakdown:2400:1800:57600",
  );
  assert.equal(seg({ contextSystemTokens: 0, contextToolsTokens: 0, contextMessageTokens: 0 }), "breakdown:0:0:0");
  // 无投影（pi）：对话 = 消息估算 token，系统+工具 = 反推余量
  assert.equal(seg({ contextTokens: 128000, contextMessageTokens: 57600 }), "estimate:57600:70400");
  // 估算超过总量时对话封顶，系统+工具为 0（不出现负数）
  assert.equal(seg({ contextTokens: 1000, contextMessageTokens: 5000 }), "estimate:1000:0");
  // 缺任一字段 = 无估算（渲染单段条）
  assert.equal(seg(undefined), null);
  assert.equal(seg({ contextTokens: 128000 }), null);
  assert.equal(seg({ contextMessageTokens: 100 }), null);
  assert.equal(seg({ contextTokens: 0, contextMessageTokens: 100 }), null);
});

test("meter panel shows the localized reading and ~used/window figures", () => {
  const source = meterSource();
  assert.match(source, /w-\[264px\]/);
  assert.match(source, /t\("sessionContext\.used", \{ percent: formatPercent\(percent\) \}\)/);
  assert.match(source, /formatTokens\(context\.usedTokens!\)\} \/ \$\{formatTokens\(context\.contextWindow!\)\}/);
  // 面板占用条：4px 圆角条，宽度按 percent
  assert.match(source, /h-1 overflow-hidden rounded-full bg-muted/);
  assert.match(source, /width: `\$\{percent\}%`/);
  assert.match(source, /data-testid="session-context-meter"/);
});

test("panel adds dsh-style segments legend when message estimate exists", () => {
  const source = meterSource();
  // 三段（host breakdown）与两段（估算）图例共用色：对话蓝、工具紫、系统蓝灰
  assert.match(source, /COLOR_CONVERSATION = "var\(--color-context-conversation, #2563eb\)"/);
  assert.match(source, /COLOR_SYSTEM_TOOLS = "var\(--color-context-system-tools, rgb\(167, 139, 250\)\)"/);
  assert.match(source, /COLOR_TOOLS = "var\(--color-context-tools, rgb\(167, 139, 250\)\)"/);
  assert.match(source, /COLOR_SYSTEM = "var\(--color-context-system, #94a3b8\)"/);
  // host breakdown 三段条：宽度 = percent × 份额 / breakdownTotal（dsh-web 同宽算法）
  assert.match(source, /breakdownSegments/);
  assert.match(source, /percent \* part\.tokens\) \/ breakdownTotal/);
  // 估算两段条：宽度按占 contextWindow 比例（与单段总占用条同一容器）
  assert.match(source, /segments\.conversation \/ context\.contextWindow!/);
  assert.match(source, /segments\.systemTools \/ context\.contextWindow!/);
  // 图例行：swatch + 文案 + 右侧 ~tokens（dsh rows 形态）
  assert.match(source, /t\("sessionContext\.conversation"\)/);
  assert.match(source, /t\("sessionContext\.systemTools"\)/);
  assert.match(source, /t\("sessionContext\.system"\)/);
  assert.match(source, /t\("sessionContext\.tools"\)/);
  assert.match(source, /size-2 flex-none rounded-\[2px\]/);
  assert.match(source, /~\{formatTokens\(segments\.conversation\)\}/);
  assert.match(source, /~\{formatTokens\(segments\.system\)\}/);
});

test("panel reuses the SessionStatus detail builder and keeps compact action", () => {
  const source = meterSource();
  // 详情复用会话头部 SessionStatus 的构建器：两处明细语义一致（首字/耗时/tps 等）
  assert.match(source, /import \{ buildSessionStatusDetail \} from "\.\/SurfaceComponents"/);
  assert.match(source, /const detail = buildSessionStatusDetail\(\s*props\.state,/);
  assert.match(source, /props\.state\?\.cacheHitAveragePercent \?\? undefined,/);
  // 明细行与「最近一次回复」性能组分开渲染（不混读为会话均值）
  assert.match(source, /detail\.detailRows\.map\(/);
  assert.match(source, /detail\.replyPerfRows\.map\(/);
  assert.match(source, /t\("ctx\.detail\.lastReply"\)/);
  // DSH 会话统计组（host sessionStats 投影；回合/墙钟/平均首字/生成速度）
  assert.match(source, /detail\.sessionStatRows\.map\(/);
  assert.match(source, /t\("ctx\.detail\.sessionStats"\)/);
  assert.match(source, /row\.emphasis \? " mt-1 border-t border-border\/70 pt-1\.5" : ""/);
  // 旧的自实现三行（命中率/输入输出/费用）已删除，避免与 builder 重复
  assert.doesNotMatch(source, /sessionContext\.cacheHit/);
  assert.doesNotMatch(source, /sessionContext\.inputOutput/);
  assert.doesNotMatch(source, /sessionContext\.cost/);
  // 压缩按钮：从右上角紧凑徽章迁入面板底部，保留 urgency 色阶 + 压缩中禁用
  assert.match(source, /t\("sessionContext\.compact"\)/);
  assert.match(source, /t\("sessionContext\.compacting"\)/);
  assert.match(source, /percent >= 90 \? "text-destructive/);
  assert.match(source, /percent >= 70 \? "text-amber-500/);
  assert.match(source, /disabled=\{compacting\}/);
  assert.match(source, /onClick=\{props\.onCompact\}/);
  assert.match(source, /showCompact = props\.onCompact !== undefined/);
});

test("panel re-anchors on scroll instead of closing during streaming", () => {
  const source = meterSource();
  // 定位逻辑抽成 positionPanel 供 layout effect 与滚动/resize 复用
  assert.match(source, /const positionPanel = useCallback\(\(\) => \{\s*const trigger = triggerRef\.current;/);
  // 滚动监听回调不再是「关闭面板」（旧行为：任何滚动/缩放都 setOpen(false)，
  // 流式渲染追底滚动会反复点开即关）
  assert.doesNotMatch(source, /const onViewportChange = \(\): void => setOpen\(false\);/);
  assert.doesNotMatch(source, /addEventListener\("scroll", onViewportChange, true\)/);
  // 改为重新锚定：capture 滚动 + rAF 合并 + 位置未变不重复 setState
  // （流式追底滚动每帧触发 scroll，trigger 固定时避免每帧 re-render）
  assert.match(source, /addEventListener\("scroll", reanchor, true\)/);
  assert.match(source, /requestAnimationFrame\(positionPanel\)/);
  assert.match(source, /setPlacement\(\(prev\) =>\s*prev !== null && prev\.left === left && prev\.top === top \? prev : \{ left, top \},\s*\);/);
  // 外点 / Escape 仍是唯一关闭途径（监听保持）
  assert.match(source, /addEventListener\("pointerdown", onPointerDown\)/);
  assert.match(source, /addEventListener\("keydown", onKeyDown\)/);
});

test("bottom bar wires the meter next to send controls and merges model + thinking into one chip", () => {
  const source = bottomBarSource();
  // ContextMeter 挂在右侧组（git 分支之前、发送控件同组）
  assert.match(source, /import \{ SessionContextMeter \} from "\.\/SessionContextMeter"/);
  assert.match(source, /<SessionContextMeter\s*state=\{props\.state\}\s*onCompact=\{props\.onCompact\}/);
  assert.match(source, /composer-bottom-right ml-auto flex shrink-0 items-center gap-2/);
  // 模型/思考合并 chip：模型名 · 思考档位 + chevron（dsh ModelSelect trigger 形态）
  assert.match(source, /composer-bar-btn model-thinking/);
  assert.match(source, /\{modelValue\}<\/span>\s*<span className="flex-none text-muted-foreground\/70" aria-hidden="true">·<\/span>/);
  assert.match(source, /<ChevronDown\s*size=\{12\}/);
  assert.match(source, /rotate-180/);
  // root 菜单两行 drill-in：模型/思考 + 当前值 + 右 chevron，点击复用既有 Dialog
  assert.match(source, /t\("app\.model"\)/);
  assert.match(source, /t\("app\.think"\)/);
  assert.match(source, /<ChevronRight size=\{14\}/);
  assert.match(source, /drillIn\(props\.onPickModel\)/);
  assert.match(source, /drillIn\(props\.onPickThinking\)/);
  // 旧的分离按钮（绿色思考、斜体模型）不再存在
  assert.doesNotMatch(source, /composer-bar-btn model flex h-7/);
  assert.doesNotMatch(source, /composer-bar-btn thinking h-7 max-w-\[10rem\]/);
});

test("context meter copy is present in both locale dictionaries", () => {
  assert.match(zh(), /"sessionContext\.used": "上下文已用 \{percent\}%"/);
  assert.match(en(), /"sessionContext\.used": "\{percent\}% of context used"/);
  for (const locale of [zh(), en()]) {
    assert.match(locale, /"sessionContext\.figures": "~\{used\} \/ \{window\}"/);
    assert.match(locale, /"sessionContext\.conversation":/);
    assert.match(locale, /"sessionContext\.systemTools":/);
    // host breakdown 三段图例文案（系统/工具/对话）
    assert.match(locale, /"sessionContext\.system":/);
    assert.match(locale, /"sessionContext\.tools":/);
    // 会话统计组文案（DSH sessionStats 投影）
    assert.match(locale, /"ctx\.detail\.sessionStats":/);
    assert.match(locale, /"ctx\.detail\.turnsSteps":/);
    assert.match(locale, /"ctx\.detail\.llmDuration":/);
    assert.match(locale, /"ctx\.detail\.toolDuration":/);
    assert.match(locale, /"ctx\.detail\.ttftAverage":/);
    // 命中/输入输出/费用行已并入共享明细构建器（ctx.detail.*），面板不再单独占用文案 key
    assert.doesNotMatch(locale, /"sessionContext\.cacheHit":/);
    assert.doesNotMatch(locale, /"sessionContext\.cacheHitAvg":/);
    assert.doesNotMatch(locale, /"sessionContext\.inputOutput":/);
    assert.doesNotMatch(locale, /"sessionContext\.cost":/);
    assert.match(locale, /"sessionContext\.compact":/);
    assert.match(locale, /"sessionContext\.compacting":/);
  }
});
