/**
 * Provider 用量展示纯函数：usageTone 档位（cc-switch utilizationColor 语义）、
 * usagePercent 推导、徽标主值文本、余额格式化与相对时间。三处消费
 * （圆球/模型卡片/选择器行）共用，视觉阈值（≥90 红 / ≥70 橙 / 其余绿；剩余 <10% 橙、≤0 红）在此锁定。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const display = loadTsCommonJs("src/renderer/src/utils/providerUsageDisplay.ts");

function balanceResult(value, currency) {
  return { success: true, kind: "balance", balance: { value, currency } };
}

function periodsResult(percents) {
  const periods = {};
  if (percents.rolling != null) periods.rolling = { percent: percents.rolling };
  if (percents.weekly != null) periods.weekly = { percent: percents.weekly };
  if (percents.monthly != null) periods.monthly = { percent: percents.monthly };
  return { success: true, kind: "periods", periods };
}

function creditsResult(credits) {
  return { success: true, kind: "credits", credits };
}

test("usageTone：百分比档位对齐 cc-switch utilizationColor（≥90 红 / ≥70 橙 / 其余绿）", () => {
  assert.equal(display.usageTone(periodsResult({ rolling: 30, weekly: 80, monthly: 10 })), "low");
  assert.equal(display.usageTone(periodsResult({ rolling: 95 })), "empty");
  assert.equal(display.usageTone(periodsResult({ rolling: 69.4 })), "ok");
  // 70 与 90 属于高档位起点
  assert.equal(display.usageTone(periodsResult({ rolling: 70 })), "low");
  assert.equal(display.usageTone(periodsResult({ rolling: 90 })), "empty");
});

test("usageTone：credits 优先 windows 最高窗；余额 ≤0 红", () => {
  assert.equal(
    display.usageTone(
      creditsResult({ windows: [{ key: "fiveHour", total: 100, used: 92 }, { key: "weekly", total: 100, used: 10 }] }),
    ),
    "empty",
  );
  // remaining 反推 used：total 200 remaining 60 → 70% → low
  assert.equal(display.usageTone(creditsResult({ total: 200, remaining: 60 })), "low");
  assert.equal(display.usageTone(balanceResult(86.3, "CNY")), "ok");
  assert.equal(display.usageTone(balanceResult(0, "CNY")), "empty");
  // total 1000 remaining 50 → 已用 95% → empty（百分比档优先于剩余比例档）
  assert.equal(display.usageTone(creditsResult({ total: 1000, remaining: 50 })), "empty");
  // total 1000 remaining 0 → 已用 100% → empty
  assert.equal(display.usageTone(creditsResult({ total: 1000, remaining: 0 })), "empty");
  // 只有剩余量（无总额）→ ok（无上限概念不判橙红）
  assert.equal(display.usageTone(creditsResult({ remaining: 5 })), "ok");
  // 只有已用量（无总额）→ 中性灰
  assert.equal(display.usageTone(creditsResult({ used: 42 })), "neutral");
});

test("usageTone：失败结果返回 neutral（inline 层会先按失败不渲染）", () => {
  assert.equal(display.usageTone({ success: false, error: "x" }), "neutral");
});

test("usageToneForPercent：Details 逐窗口行与 usageTone 同阈值", () => {
  assert.equal(display.usageToneForPercent(null), "neutral");
  assert.equal(display.usageToneForPercent(69.9), "ok");
  assert.equal(display.usageToneForPercent(70), "low");
  assert.equal(display.usageToneForPercent(90), "empty");
});

test("tone → 样式类映射（绿/橙/红含 dark 变体，进度条与文字分列）", () => {
  assert.match(display.USAGE_TONE_TEXT_CLASS.ok, /green-600/);
  assert.match(display.USAGE_TONE_TEXT_CLASS.low, /orange-500/);
  assert.match(display.USAGE_TONE_TEXT_CLASS.empty, /red-500/);
  assert.match(display.USAGE_TONE_BAR_CLASS.empty, /bg-red-500/);
  assert.match(display.USAGE_TONE_BAR_CLASS.low, /bg-orange-500/);
  assert.match(display.USAGE_TONE_BAR_CLASS.ok, /bg-green-500/);
});

test("usagePercent：periods 封顶 100；credits remaining 可反推 used", () => {
  assert.equal(display.usagePercent(periodsResult({ rolling: 130, weekly: 5 })), 100);
  assert.equal(
    display.usagePercent(creditsResult({ total: 200, remaining: 60 })),
    70,
    "used = total - remaining = 140 → 70%",
  );
  // total<=0 不产生百分比（避免除零误报 danger）
  assert.equal(display.usagePercent(creditsResult({ total: 0, used: 10 })), null);
  assert.equal(display.usagePercent(balanceResult(10, "USD")), null);
});

test("formatUsageBadgeText：periods/credits-windows 出百分比，balance 出余额，credits 出剩余", () => {
  assert.equal(display.formatUsageBadgeText(periodsResult({ rolling: 12.4 })), "12%");
  assert.equal(display.formatUsageBadgeText(balanceResult(86.3, "CNY")), "¥86.3");
  assert.equal(display.formatUsageBadgeText(creditsResult({ remaining: 120.5 })), "120.5");
  assert.equal(
    display.formatUsageBadgeText(creditsResult({ windows: [{ key: "fiveHour", total: 100, used: 45 }] })),
    "45%",
  );
  // 无可展示数值 → null（调用方不渲染）
  assert.equal(display.formatUsageBadgeText({ success: false, error: "x" }), null);
  assert.equal(display.formatUsageBadgeText({ success: true }), null);
});

test("formatBalance：已知币种符号前缀、未知代码后缀、无币种纯数字", () => {
  assert.equal(display.formatBalance({ value: 110, currency: "USD" }), "$110");
  assert.equal(display.formatBalance({ value: 110, currency: "CNY" }), "¥110");
  assert.equal(display.formatBalance({ value: 3.5, currency: "XYZ" }), "3.5 XYZ");
  assert.equal(display.formatBalance({ value: 42 }), "42");
  assert.equal(display.formatAmount(3.14159), "3.14", "最多两位小数四舍五入");
  assert.equal(display.formatAmount(42), "42", "整数不出现小数点");
  assert.equal(display.currencySymbol("rmb"), "¥", "币种代码大小写不敏感");
});

test("relativeTimeParts：刚刚/分钟/小时/天/过期 五档（cc-switch Clock 行语义）", () => {
  const now = 1_000_000_000_000;
  const json = (value) => JSON.stringify(value);
  assert.equal(display.relativeTimeParts(now - 5_000, now).key, "config.usage.timeJustNow");
  assert.equal(
    json(display.relativeTimeParts(now - 3 * 60_000, now)),
    json({ key: "config.usage.timeMinutesAgo", params: { n: 3 } }),
  );
  assert.equal(
    json(display.relativeTimeParts(now - 2 * 3_600_000, now)),
    json({ key: "config.usage.timeHoursAgo", params: { n: 2 } }),
  );
  assert.equal(
    json(display.relativeTimeParts(now - 5 * 86_400_000, now)),
    json({ key: "config.usage.timeDaysAgo", params: { n: 5 } }),
  );
  // 超过 30 天 → stale（避免「9999 天前」这类荒谬值）
  assert.equal(display.relativeTimeParts(now - 31 * 86_400_000, now).key, "config.usage.timeStale");
  // 时钟倒挂（未来时间戳）按刚刚处理
  assert.equal(display.relativeTimeParts(now + 60_000, now).key, "config.usage.timeJustNow");
});
