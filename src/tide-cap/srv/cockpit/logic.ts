// Pure domain logic of the buyer cockpit: lead-time ranges, item status,
// planned delivery time verdicts, proposals and backtests. No I/O.

import { DEFAULT_PDT, PLACEHOLDERS, PLACEHOLDER_MIN, currentValue, placeholderRule } from "./leadtimes/domain/leadtimes";
import { addDays, daysBetween } from "./kernel/calendar";
import { auc, runCost, CU_PER_CONTEXT_CELL, CU_PER_PREDICTED_CELL } from "./kernel/stats";

export { auc, runCost, CU_PER_CONTEXT_CELL, CU_PER_PREDICTED_CELL };

export { DEFAULT_PDT, PLACEHOLDERS, PLACEHOLDER_MIN, addDays, daysBetween };
export const GRID = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
export const EMPIRICAL_MIN = 20;
export const PROPOSAL_QUANTILE = 0.8;
export const BACKTEST_QUANTILES = [0.5, 0.6, 0.7, 0.8, 0.9];
export const LATER_SHARE = 0.3;

export type Grid = Record<string, number>; // "0.1" -> days

/** Linear interpolation between order statistics (numpy default). */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function empiricalGrid(values: number[], levels = GRID): Grid {
  const s = [...values].sort((a, b) => a - b);
  return Object.fromEntries(
    levels.map((l) => [String(l), round1(quantile(s, l))]),
  );
}

export function gridFrom(levels: number[], values: number[]): Grid {
  // Monotone and non-negative along the grid.
  let prev = 0;
  return Object.fromEntries(
    levels.map((l, i) => {
      prev = Math.max(prev, values[i] ?? prev, 0);
      return [String(l), round1(prev)];
    }),
  );
}

export const at = (g: Grid | null | undefined, q: number) =>
  g ? (g[String(q)] ?? null) : null;

export const round1 = (v: number) => Math.round(v * 10) / 10;

export const maxDate = (a: string, b: string) => (a > b ? a : b);

/** Rule on a maintained planned delivery time; null when the rule does not fire (one implementation: leadtimes domain). */
export const pdtRule = placeholderRule;

/** Effective planned delivery time: info record if > 0, else material master (one implementation: leadtimes domain). */
export const effectiveDays = currentValue;

export type Verdict =
  | "not_maintained"
  | "default"
  | "placeholder"
  | "below_range"
  | "above_range"
  | "within_range"
  | "no_range";

export function pdtVerdict(
  days: number | null | undefined,
  grid: Grid | null,
): Verdict {
  const ruled = pdtRule(days);
  if (ruled) return ruled;
  const p10 = at(grid, 0.1);
  const p90 = at(grid, 0.9);
  if (p10 === null || p90 === null) return "no_range";
  if ((days as number) < p10) return "below_range";
  if ((days as number) > p90) return "above_range";
  return "within_range";
}

export const verdictCriticality = (v: Verdict) =>
  v === "within_range" ? 3 : v === "no_range" ? 0 : v === "below_range" ||
    v === "default" || v === "not_maintained" || v === "placeholder"
    ? 1
    : 2;

export const VERDICT_TEXT: Record<Verdict, string> = {
  not_maintained: "not maintained (0 days)",
  default: "system default of 2 days",
  placeholder: "placeholder value",
  below_range: "below p10 of real lead times",
  above_range: "above p90 of real lead times",
  within_range: "within p10–p90",
  no_range: "no lead-time range to compare",
};

export type Status = "on_time" | "at_risk" | "late" | "overdue" | "no_estimate";

export interface Expectation {
  p10: string | null;
  p50: string | null;
  p80: string | null;
  p90: string | null;
}

/**
 * Expected availability dates of an open item. The item is still open at the
 * as-of date, so no date lies before it.
 */
export function expectation(
  poDate: string,
  grid: Grid | null,
  asOf: string,
): Expectation {
  const d = (q: number) => {
    const v = at(grid, q);
    return v === null ? null : maxDate(addDays(poDate, v), asOf);
  };
  return { p10: d(0.1), p50: d(0.5), p80: d(0.8), p90: d(0.9) };
}

export function itemStatus(
  requested: string | null,
  e: Expectation,
  asOf: string,
): Status {
  if (requested && requested < asOf) return "overdue";
  if (!e.p50 || !requested) return "no_estimate";
  if (e.p50 > requested) return "late";
  if (e.p80 && e.p80 > requested) return "at_risk";
  return "on_time";
}

export const STATUS_CRITICALITY: Record<Status, number> = {
  overdue: 1,
  late: 1,
  at_risk: 2,
  on_time: 3,
  no_estimate: 0,
};
export const STATUS_RANK: Record<Status, number> = {
  overdue: 1,
  late: 1,
  at_risk: 2,
  no_estimate: 3,
  on_time: 4,
};

/** Proposal from the older share of own lead times, checked on the later ones. */
export function backtest(
  leadTimesByReceipt: number[],
  current: number | null,
): {
  rows: {
    quantile: number;
    label: string;
    proposalDays: number;
    shareLateAbove: number;
    meanBufferDays: number;
    meanDaysLate: number;
    nOlder: number;
    nLater: number;
  }[];
  current?: { shareLateAbove: number; meanBufferDays: number };
} {
  const n = leadTimesByReceipt.length;
  if (n < EMPIRICAL_MIN) return { rows: [] };
  const nLater = Math.max(1, Math.round(n * LATER_SHARE));
  const older = [...leadTimesByReceipt.slice(0, n - nLater)].sort(
    (a, b) => a - b,
  );
  const later = leadTimesByReceipt.slice(n - nLater);
  const check = (p: number) => ({
    shareLateAbove: round3(later.filter((v) => v > p).length / later.length),
    meanBufferDays: round1(mean(later.map((v) => Math.max(p - v, 0)))),
    meanDaysLate: round1(mean(later.map((v) => Math.max(v - p, 0)))),
  });
  const rows = BACKTEST_QUANTILES.map((q) => {
    const p = Math.ceil(quantile(older, q));
    return {
      quantile: q,
      label: `p${Math.round(q * 100)}`,
      proposalDays: p,
      ...check(p),
      nOlder: older.length,
      nLater,
    };
  });
  const out: ReturnType<typeof backtest> = { rows };
  if (current !== null) {
    const c = check(current);
    out.current = {
      shareLateAbove: c.shareLateAbove,
      meanBufferDays: c.meanBufferDays,
    };
  }
  return out;
}

export const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
export const median = (xs: number[]) =>
  quantile([...xs].sort((a, b) => a - b), 0.5);
export const round3 = (v: number) => Math.round(v * 1000) / 1000;

export const historyBucket = (n: number) =>
  n === 0 ? "0" : n < 5 ? "1-4" : n < EMPIRICAL_MIN ? "5-19" : "20+";
