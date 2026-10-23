import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 会话定位轴「滚动档位」的源码契约（2026-10 用户反馈「长会话刻度被抽稀丢掉」）：
 * 刻度超出可用高度时导轨内部滚动 + 两端渐隐，不再压缩到不可点击、也不再抽稀丢刻度。
 * 纯规划逻辑见 outlineRailTicks.test.mjs；这里钉渲染侧必须存在的接线，
 * 缺任一条都会静默退化成「刻度过密」或「滚轮只滚时间线」。
 */

const railSource = readFileSync("src/renderer/src/components/motion/preview-rail.tsx", "utf8");
const outlineSource = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");

test("导轨接受 railMaxHeight 并在超容量时内部滚动", () => {
	assert.match(railSource, /railMaxHeight\?:\s*number/);
	assert.match(railSource, /const\s+scrollable\s*=\s*!isHorizontal\s*&&\s*railMaxHeight\s*!==\s*undefined\s*&&\s*contentSize\s*>\s*railMaxHeight/);
	assert.match(railSource, /overflow-y-auto/);
	// 滚动条隐藏：刻度轴本身是视觉元素，出现系统滚动条会破坏贴边观感
	assert.match(railSource, /scrollbar-width:none/);
});

test("超容量时两端渐隐提示还有更多刻度", () => {
	assert.match(railSource, /maskImage:\s*scrollerMask/);
	assert.match(railSource, /linear-gradient\(to bottom, transparent 0, #000 16px/);
	assert.match(railSource, /linear-gradient\(to bottom, #000 0, #000 calc\(100% - 16px\), transparent 100%\)/);
});

test("滚轮先滚导轨，到边界才交还外层时间线", () => {
	// 必须是非 passive 原生监听：React 的 onWheel 是 passive，preventDefault 无效
	assert.match(railSource, /addEventListener\("wheel", handler, \{ passive: false \}\)/);
	assert.match(railSource, /onWheelFallback/);
	// 正则空白容忍：改格式不应让断言失效
	const boundary = railSource.match(/const\s+atTop\s*=\s*scroller\.scrollTop\s*<=\s*0\s*;[\s\S]{0,600}?onWheelFallback\s*\(\s*event\.deltaY\s*\)\s*;/);
	assert.ok(boundary, "滚轮到边界才转发外层时间线");
});

test("刻度列表不因滚动逐帧重渲染（滚动位置写 ref 而不是 state）", () => {
	// 只认 ref 写法：放进 state 会让长会话每次滚动重渲染整列刻度
	assert.match(railSource, /scrollTopRef\.current\s*=\s*scroller\.scrollTop/);
	assert.doesNotMatch(railSource, /setScrollTop\s*\(/);
});

test("隐藏滚动条只用 scrollbar-width，不恢复 webkit 伪元素规则", () => {
	// foundation.css 明确禁止：元素声明 scrollbar-width 后 Chromium 121+ 会完全忽略
	// ::-webkit-scrollbar 系列规则，写了就是死代码（第三方轨道会「看起来生效」但实际无效）。
	assert.doesNotMatch(railSource, /-webkit-scrollbar/);
	assert.match(railSource, /\[scrollbar-width:none\]/);
});

test("跟随只在刻度移出安全带时才居中（if-needed，不是每次都重算）", () => {
	// 相邻检查点只差一个 pitch，无条件居中会让导轨每次滚屏都「抽」一下
	assert.match(railSource, /const\s+FOLLOW_SAFE_BAND_PX\s*=\s*\d+/);
	assert.match(railSource, /center\s*>=\s*scrollTop\s*\+\s*FOLLOW_SAFE_BAND_PX\s*&&\s*center\s*<=\s*scrollTop\s*\+\s*viewHeight\s*-\s*FOLLOW_SAFE_BAND_PX\)\s*return;/);
	// 安全带只夹可视带：用 contentSize 夹会把末尾刻度误判成带外
	assert.doesNotMatch(railSource, /center\s*<=\s*contentSize\s*-/);
});

test("进出滚动档位时重置跟随记录（浏览器会把 scrollTop 归零）", () => {
	assert.match(railSource, /followedIdRef\.current\s*=\s*undefined/);
	assert.match(railSource, /\},\s*\[\s*scrollable\s*,\s*railMaxHeight\s*\]\s*\)/);
});

test("未加载刻度画淡一档（对齐 dsh 的 markUnloaded），点之前就知道要补页", () => {
	assert.match(railSource, /muted\?:\s*boolean/);
	assert.match(railSource, /item\.muted\s*&&\s*"opacity-60"/);
	assert.match(outlineSource, /muted:\s*item\.pending\s*===\s*true/);
});

test("补页预算用尽不能再静默：必须给可见提示", () => {
	const stageSource = readFileSync("src/renderer/src/components/session/SessionSurfaceStage.tsx", "utf8");
	const giveUp = stageSource.match(/pendingAttempts\s*>=\s*RAIL_PENDING_MAX_ATTEMPTS\)\s*\{[\s\S]{0,600}?showNotice\(\s*t\(\s*"outline\.jumpUnreachable"/);
	assert.ok(giveUp, "放弃补页时必须 showNotice（静默放弃＝点了没反应）");
});

test("预览卡只渲染一张并绝对定位，不再为对齐渲染 N 个占位格子", () => {
	assert.doesNotMatch(railSource, /\{items\.map\(\(item\) => \(\s*<div key=\{item\.id\} style=/);
	assert.match(railSource, /const\s+displayedItem\s*=\s*displayedIndex\s*>=\s*0\s*\?\s*items\[displayedIndex\]\s*:\s*undefined/);
	assert.match(railSource, /ref=\{cardRef\}/);
});

test("窗口按源下标截取后再规划间距（顺序反了会永远只显示最新一批）", () => {
	assert.match(outlineSource, /windowRailItems\(\s*props\.items\s*,\s*activeSourceIndex\s*\)/);
	assert.match(outlineSource, /planRailTicks\(\s*visibleItems\s*,/);
	// 源下标必须来自未截断的 props.items
	assert.match(outlineSource, /outlineItemIndex\.get\(railActiveId\)/);
});

test("会话定位轴把可用高度与滚轮回调接给导轨", () => {
	assert.match(outlineSource, /railMaxHeight=\{\s*plan\.scrollable\s*\?\s*availableHeight\s*:\s*undefined\s*\}/);
	assert.match(outlineSource, /onWheelFallback=\{\s*props\.onTimelineWheel\s*\}/);
	// 外层容器不再自己吃滚轮（会与导轨内部滚动打架）
	assert.doesNotMatch(outlineSource, /<div\s+ref=\{containerRef\}\s+onWheel=/);
});
