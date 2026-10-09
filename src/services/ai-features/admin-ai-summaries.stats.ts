// Deterministic statistics behind the admin AI summaries (forecast / anomaly / sentiment). Pure functions, no I/O, no model:
// every number the model later describes is computed here. Missing = null, never 0.

export const FORECAST_MIN_MONTHS = 4;        // fewer months with data -> NOT_ENOUGH_DATA
export const FORECAST_TREND_MIN_MONTHS = 6;  // the linear projection is produced only from this many months with data
export const FORECAST_WINDOW_MONTHS = 12;
export const ANOMALY_WINDOW_DAYS = 30;
export const ANOMALY_SIGMA = 3;              // a day is unusual when its value is >= mean + 3 * std-dev
export const ANOMALY_MIN_EVENTS = 10;        // a metric is evaluated only with >= this many events in the window
export const SENTIMENT_MIN_REVIEWS = 10;
export const SENTIMENT_MAX_SNIPPETS = 20;
export const SENTIMENT_SNIPPET_CHARS = 160;

const round = (n: number, d = 1) => { const f = 10 ** d; return Math.round(n * f) / f; };

export interface MonthPoint { month: string; inflow: number | null; outflow: number | null }
export interface MonthSeriesInput { amount: number; at: Date }

export const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/** The last `n` COMPLETE UTC months before `now` (oldest first), as 'YYYY-MM'. The current partial month is excluded. */
export function lastCompleteMonths(now: Date, n = FORECAST_WINDOW_MONTHS): string[] {
  const out: string[] = [];
  for (let i = n; i >= 1; i--) out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  return out;
}

/** Sums rows per month. A month with no rows is null (not 0): the series only states what was really recorded. */
export function monthlyTotals(rows: MonthSeriesInput[], months: string[]): (number | null)[] {
  const sums = new Map<string, number>();
  for (const r of rows) {
    if (!Number.isFinite(r.amount)) continue;
    const k = monthKey(r.at);
    sums.set(k, (sums.get(k) ?? 0) + r.amount);
  }
  return months.map((m) => (sums.has(m) ? round(sums.get(m)!, 2) : null));
}

export function changePercent(prev: number | null, curr: number | null): number | null {
  if (prev === null || curr === null || prev <= 0) return null;
  return round(((curr - prev) / prev) * 100, 1);
}

/** Least-squares line over (index, value) of the months that have data; projects the value at index `next`. Null below the minimum or when negative. */
export function linearNextValue(values: (number | null)[], minPoints = FORECAST_TREND_MIN_MONTHS): number | null {
  const pts = values.map((v, i) => (v === null ? null : [i, v] as const)).filter((p): p is readonly [number, number] => p !== null);
  if (pts.length < minPoints) return null;
  const n = pts.length;
  const sx = pts.reduce((s, p) => s + p[0], 0), sy = pts.reduce((s, p) => s + p[1], 0);
  const sxx = pts.reduce((s, p) => s + p[0] * p[0], 0), sxy = pts.reduce((s, p) => s + p[0] * p[1], 0);
  const den = n * sxx - sx * sx;
  if (den === 0) return null;
  const slope = (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n;
  const next = intercept + slope * values.length;
  return Number.isFinite(next) && next >= 0 ? round(next, 2) : null;
}

export const PLATFORM_CURRENCY = 'USD';

export interface ForecastMetrics {
  currency: string | null;
  /** True when the data holds more than one currency: only one is summed (never mixed), no next-month estimate is produced. */
  mixedCurrencies: boolean;
  /** Every currency that appeared in the rows (labels only). */
  currenciesSeen: string[];
  months: { month: string; inflow: number | null; outflow: number | null; inflowChangePercent: number | null }[];
  monthsWithData: number;
  inflowNextMonthEstimate: number | null;
  inflowTrendBasedOnMonths: number | null;
}

/**
 * Which currency the series uses. Amounts of different currencies are NEVER summed together. The platform currency (USD) wins when it is
 * present; otherwise the most frequent currency in the data; with no rows at all there is no currency (null) — never a default.
 */
export function pickForecastCurrency(rows: { currency: string }[]): { currency: string | null; seen: string[]; mixed: boolean } {
  const tally = new Map<string, number>();
  for (const r of rows) tally.set(r.currency, (tally.get(r.currency) ?? 0) + 1);
  const seen = [...tally.keys()].sort();
  if (seen.length === 0) return { currency: null, seen, mixed: false };
  const currency = tally.has(PLATFORM_CURRENCY) ? PLATFORM_CURRENCY : [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return { currency, seen, mixed: seen.length > 1 };
}

export function buildForecastMetrics(inflow: MonthSeriesInput[], outflow: MonthSeriesInput[], months: string[], currency: string | null, mixedCurrencies = false, currenciesSeen: string[] = currency ? [currency] : []): ForecastMetrics {
  const inV = monthlyTotals(inflow, months), outV = monthlyTotals(outflow, months);
  const monthsWithData = months.filter((_, i) => inV[i] !== null || outV[i] !== null).length;
  const withInflow = inV.filter((v) => v !== null).length;
  return {
    currency, mixedCurrencies, currenciesSeen,
    months: months.map((m, i) => ({ month: m, inflow: inV[i], outflow: outV[i], inflowChangePercent: i > 0 ? changePercent(inV[i - 1], inV[i]) : null })),
    monthsWithData,
    // a trend over one currency is only honest when the data really is one currency
    inflowNextMonthEstimate: mixedCurrencies ? null : linearNextValue(inV),
    inflowTrendBasedOnMonths: !mixedCurrencies && withInflow >= FORECAST_TREND_MIN_MONTHS ? withInflow : null,
  };
}

// ---- anomaly ----

export const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** The last `days` UTC calendar days ending today (oldest first). */
export function lastDays(now: Date, days = ANOMALY_WINDOW_DAYS): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(dayKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i))));
  return out;
}

export interface DailyStats {
  key: string;
  totalEvents: number;
  evaluated: boolean;
  mean: number | null;
  stdDev: number | null;
  anomalyDays: { date: string; count: number; zScore: number }[];
}

export function dailyAnomalyStats(key: string, timestamps: Date[], days: string[], sigma = ANOMALY_SIGMA, minEvents = ANOMALY_MIN_EVENTS): DailyStats {
  const counts = new Map<string, number>(days.map((d) => [d, 0]));
  for (const t of timestamps) { const k = dayKey(t); if (counts.has(k)) counts.set(k, counts.get(k)! + 1); }
  const series = days.map((d) => counts.get(d)!);
  const total = series.reduce((a, b) => a + b, 0);
  if (total < minEvents) return { key, totalEvents: total, evaluated: false, mean: null, stdDev: null, anomalyDays: [] };
  const mean = total / series.length;
  const std = Math.sqrt(series.reduce((s, v) => s + (v - mean) ** 2, 0) / series.length);
  const anomalyDays = std === 0 ? [] : days
    .map((d, i) => ({ date: d, count: series[i], zScore: round((series[i] - mean) / std, 2) }))
    .filter((x) => x.zScore >= sigma && x.count > mean);
  return { key, totalEvents: total, evaluated: true, mean: round(mean, 2), stdDev: round(std, 2), anomalyDays };
}

export function topCounts(labels: string[], limit = 5): { label: string; count: number }[] {
  const m = new Map<string, number>();
  for (const l of labels) if (l) m.set(l, (m.get(l) ?? 0) + 1);
  return [...m.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, limit);
}

// ---- sentiment ----

export interface SentimentMetrics {
  totalReviews: number;
  averageRating: number | null;
  withCommentCount: number;
  distribution: { stars: number; count: number; percent: number }[];
  positivePercent: number | null; // 4-5 stars
  negativePercent: number | null; // 1-2 stars
  commentSnippets: string[];
}

export function buildSentimentMetrics(ratings: number[], withCommentCount: number, snippets: string[]): SentimentMetrics {
  const valid = ratings.filter((r) => Number.isFinite(r) && r >= 0.5);
  const total = valid.length;
  const counts = [0, 0, 0, 0, 0];
  for (const r of valid) counts[Math.min(5, Math.max(1, Math.round(r))) - 1]++;
  const pct = (c: number) => (total > 0 ? round((c / total) * 100, 1) : 0);
  return {
    totalReviews: total,
    averageRating: total > 0 ? round(valid.reduce((a, b) => a + b, 0) / total, 2) : null,
    withCommentCount,
    distribution: counts.map((count, i) => ({ stars: i + 1, count, percent: pct(count) })),
    positivePercent: total > 0 ? pct(counts[3] + counts[4]) : null,
    negativePercent: total > 0 ? pct(counts[0] + counts[1]) : null,
    commentSnippets: snippets,
  };
}
