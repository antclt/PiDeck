/**
 * 每日用量堆叠柱状图（自绘 SVG）。
 *
 * 视图切换：日（近 30 天）/ 周（近 12 周聚合）/ 月（近 12 月聚合）。
 * 每根柱按 provider 堆叠，provider 颜色来自固定色板（不足时循环）。
 * hover 显示当日总量（SVG <title>）。
 */

import { useMemo, useState } from "react";
import type { UsageAggregated, UsageDayRow } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartContainer, ChartTooltipContent } from "../../ui-shadcn/chart";
import { formatTokens } from "./format";

type RangeMode = "day" | "week" | "month";

/** 近 N 天/周/月聚合桶：label + 总量 + provider 分解。 */
type Bucket = {
  label: string;
  tokens: number;
  byProvider: Array<{ provider: string; tokens: number }>;
};

const DAY_MS = 24 * 3600 * 1000;

function buildBuckets(rows: UsageDayRow[], mode: RangeMode, now: Date): Bucket[] {
  if (rows.length === 0) return [];
  const last = new Date(rows[rows.length - 1].day + "T00:00:00");
  if (Number.isNaN(last.getTime())) return [];
  const end = Math.min(now.getTime(), last.getTime() + DAY_MS);

  if (mode === "day") {
    const start = end - 30 * DAY_MS;
    return rows
      .filter((r) => new Date(r.day + "T00:00:00").getTime() >= start)
      .map((r) => ({
        label: r.day.slice(5),
        tokens: r.totals.tokens,
        byProvider: r.byProvider.map((p) => ({ provider: p.provider, tokens: p.tokens })),
      }));
  }

  // 周 / 月：按本地周一起始 / 月起始聚合成桶（升序）
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    const d = new Date(r.day + "T00:00:00");
    let key: string;
    let label: string;
    if (mode === "week") {
      const monday = new Date(d);
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      // 本地日期键（不用 toISOString，避免 UTC 偏移导致标签错位一天）
      const m = String(monday.getMonth() + 1).padStart(2, "0");
      const day = String(monday.getDate()).padStart(2, "0");
      key = `${monday.getFullYear()}-${m}-${day}`;
      label = key.slice(5);
    } else {
      key = r.day.slice(0, 7);
      label = key;
    }
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { label, tokens: 0, byProvider: [] };
      buckets.set(key, bucket);
    }
    bucket.tokens += r.totals.tokens;
    for (const p of r.byProvider) {
      const existing = bucket.byProvider.find((b) => b.provider === p.provider);
      if (existing) {
        existing.tokens += p.tokens;
      } else {
        bucket.byProvider.push({ provider: p.provider, tokens: p.tokens });
      }
    }
  }
  const sorted = [...buckets.values()];
  const limit = mode === "week" ? 12 : 12;
  return sorted.slice(Math.max(0, sorted.length - limit));
}

const RANGE_LABELS: Record<RangeMode, string> = {
  day: t("usageStats.daily.rangeDay"),
  week: t("usageStats.daily.rangeWeek"),
  month: t("usageStats.daily.rangeMonth"),
};

// 给低用量日期保留可悬停的最小柱高，并用透明命中区覆盖整根柱，避免只能点中 1px 图形。
const CHART_HEIGHT = 240;

export function UsageDailyChart(props: { data: UsageAggregated }) {
  const [mode, setMode] = useState<RangeMode>("day");
  const { data } = props;

  const buckets = useMemo(
    () => buildBuckets(data.daily, mode, new Date()),
    [data.daily, mode],
  );
  // provider 名可能包含 `/`、`.` 等字符，不能直接作为 CSS 变量名；使用稳定的
  // provider key 避免 ChartContainer 生成无效变量后，Recharts 柱体退回黑色。
  const providers = [...new Set(buckets.flatMap((bucket) => bucket.byProvider.map((item) => item.provider)))];
  const providerKeys = providers.map((provider, index) => ({ provider, key: `provider_${index}` }));
  const chartData = buckets.map((bucket) => ({
    ...bucket,
    ...Object.fromEntries(providerKeys.map(({ provider, key }) => [
      key,
      bucket.byProvider.find((item) => item.provider === provider)?.tokens ?? 0,
    ])),
  }));
  const chartConfig = Object.fromEntries(providerKeys.map(({ provider, key }, index) => [
    key,
    { label: provider, color: `hsl(${(index * 67 + 250) % 360} 75% 65%)` },
  ]));

  return (
    <div className="usage-stats-chart">
      <div className="usage-stats-chart-toolbar">
        {(["day", "week", "month"] as RangeMode[]).map((m) => (
          <Button
            key={m}
            variant={mode === m ? "default" : "ghost"}
            size="sm"
            onClick={() => setMode(m)}
          >
            {RANGE_LABELS[m]}
          </Button>
        ))}
      </div>
      {buckets.length === 0 ? (
        <div className="usage-stats-hint">{t("usageStats.table.empty")}</div>
      ) : (
        <ChartContainer config={chartConfig} className="h-[240px] w-full aspect-auto">
          <BarChart data={chartData} margin={{ top: 12, right: 16, left: 12, bottom: 4 }} barCategoryGap="28%">
              <CartesianGrid vertical={false} stroke="var(--color-border-subtle)" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
              <YAxis tickLine={false} axisLine={false} width={58} tickFormatter={(value: number) => formatTokens(Number(value))} />
              <Tooltip cursor={{ fill: "var(--color-muted)", opacity: 0.35 }} content={<ChartTooltipContent />} />
              {providerKeys.map(({ provider, key }) => (
                <Bar key={provider} dataKey={key} stackId="usage" fill={`var(--color-${key})`} radius={2} minPointSize={3} />
              ))}
          </BarChart>
        </ChartContainer>
      )}
    </div>
  );
}
