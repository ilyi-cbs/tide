// Calendar arithmetic belongs to kernel/calendar.
import { addDays, daysBetween } from "../../kernel/calendar";
import { round } from "../../kernel/stats";

/** 19 grid levels 0.05 … 0.95 of every stored line grid. */
export const LEVELS = Array.from(
  { length: 19 },
  (_, k) => Math.round(5 * (k + 1)) / 100,
);
export const EMPIRICAL_MIN = 20;
export const HORIZON_WORKING_DAYS = 10;
export const TOP_PER_GROUP = 20;
export const LATE_AT = 0.5;
export const P_MIN = 0.025;
export const P_MAX = 0.975;
export const RATE_WINDOW_DAYS: [number, number] = [365, 30];
export const MIN_RATE_ROWS = 50;
export const DEFAULT_PDT = 2;
export const PLACEHOLDERS = [180, 360, 999];
export const PLACEHOLDER_MIN = 180;
export const PLANT_CONTEXT_ROWS = 2500;
export const CONTEXT_SEED = 1;

/** Grid JSON: keys with two decimals ("0.05" … "0.95", as the kernel fixtures), values in days. */
export type Grid = Record<string, number>;
export const levelKey = (l: number) => l.toFixed(2);
export type AtRiskSource =
  "rule" | "empirical" | "tabpfn" | "fake" | "fallback";
export type PdtFlag = "not_maintained" | "default" | "placeholder";
export type RuleVerdict = "fires" | "does_not_fire";

// ---------------------------------------------------------------- dates

/** Requested date inside [asOf, horizonEnd] (both inclusive). */
export function inWindow(
  requested: string | null | undefined,
  asOf: string,
  horizonEnd: string,
): boolean {
  if (!requested) return false;
  const r = requested.slice(0, 10);
  return r >= asOf && r <= horizonEnd;
}

// ---------------------------------------------------------------- planned time (P-4)

/** Placeholder rule on a planned delivery time; null = realistic. */
export function pdtFlag(days: number | null | undefined): PdtFlag | null {
  if (days === null || days === undefined || Number.isNaN(Number(days)))
    return "not_maintained";
  const v = Number(days);
  if (v === 0) return "not_maintained";
  if (v === DEFAULT_PDT) return "default";
  if (PLACEHOLDERS.includes(v) || v >= PLACEHOLDER_MIN) return "placeholder";
  return null;
}

export const isRealistic = (days: number | null | undefined) =>
  pdtFlag(days) === null;

export const PDT_FLAG_WORDS: Record<PdtFlag, string> = {
  not_maintained: "not maintained",
  default: "system default",
  placeholder: "a placeholder",
};

export function gapDays(poDate: string, requested: string): number {
  return daysBetween(poDate, requested);
}

export const ruleFires = (gap: number, planned: number) => gap < planned;

/** Source of an item's P(late): realistic planned time → rule; ≥ 20 own lead times → empirical; else tabpfn. */
export function sourceFor(
  planned: number | null | undefined,
  nOwn: number,
  gridSource?: string | null,
): AtRiskSource {
  if (isRealistic(planned)) return "rule";
  if (nOwn >= EMPIRICAL_MIN) return "empirical";
  // Without a grid provenance the label stays the legacy "tabpfn"; a known grid source wins.
  if (gridSource === undefined) return "tabpfn";
  return gridSource === "tabpfn" ||
    gridSource === "fake" ||
    gridSource === "empirical"
    ? gridSource
    : "fallback";
}

// ---------------------------------------------------------------- quantiles, grids

export const clip = (p: number) => Math.min(P_MAX, Math.max(P_MIN, p));

/** Linear interpolation between order statistics (numpy default). */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Grid from quantile values aligned with `levels`: sorted, ≥ 0, rounded to 0.01. */
export function gridFrom(values: number[], levels: number[] = LEVELS): Grid {
  const v = levels.map((_, i) => Number(values[i]));
  const finite = v.filter(Number.isFinite);
  const fill = finite.length ? finite[0] : 0;
  const sorted = v
    .map((x) => (Number.isFinite(x) ? x : fill))
    .sort((a, b) => a - b);
  return Object.fromEntries(
    levels.map((l, i) => [levelKey(l), round(Math.max(0, sorted[i]), 2)]),
  );
}

export function empiricalGrid(
  history: number[],
  levels: number[] = LEVELS,
): Grid {
  const s = [...history].sort((a, b) => a - b);
  return gridFrom(
    levels.map((l) => quantile(s, l)),
    levels,
  );
}

export const gridValues = (g: Grid, levels: number[] = LEVELS) =>
  levels.map((l) => g[levelKey(l)] ?? g[String(l)]);
export const gridAt = (g: Grid | null | undefined, q: number): number | null =>
  g ? (g[levelKey(q)] ?? g[String(q)] ?? null) : null;

/** Codec of LineGrid.levels (NS-C5): JSON object "0.05" … "0.95" → days, or an array of 19 values. */
export function parseGrid(json: string | null | undefined): Grid | null {
  if (!json) return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (Array.isArray(v))
    return v.length === LEVELS.length &&
      v.every((x) => Number.isFinite(Number(x)))
      ? gridFrom(v.map(Number))
      : null;
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const vals = LEVELS.map((l) => Number(o[levelKey(l)] ?? o[String(l)]));
  return vals.every(Number.isFinite) ? gridFrom(vals) : null;
}

export const serializeGrid = (g: Grid): string => JSON.stringify(g);

export function gridSummary(g: Grid) {
  return {
    p10: gridAt(g, 0.1),
    p50: gridAt(g, 0.5),
    p80: gridAt(g, 0.8),
    p90: gridAt(g, 0.9),
  };
}

/** Share of own lead times above the requested gap, clipped. */
export function pExceedEmpirical(history: number[], gap: number): number {
  if (!history.length) return NaN;
  return clip(history.filter((h) => h > gap).length / history.length);
}

/**
 * P(lead time > gap) from a quantile grid. Lead times are whole days, so
 * P = 1 − F(gap + 0.5), F linear between grid points; outside the grid the
 * tail mass is split evenly (np.interp with left/right values).
 */
export function pExceedFromQuantiles(
  q: number[],
  gap: number,
  levels: number[] = LEVELS,
): number {
  const xs = [...q].sort((a, b) => a - b).map((v, i) => v + i * 1e-9);
  const x = gap + 0.5;
  const n = levels.length;
  let F: number;
  if (x < xs[0]) F = levels[0] / 2;
  else if (x > xs[n - 1]) F = 1 - (1 - levels[n - 1]) / 2;
  else {
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const t = xs[i + 1] === xs[i] ? 0 : (x - xs[i]) / (xs[i + 1] - xs[i]);
    F = levels[i] + t * (levels[i + 1] - levels[i]);
  }
  return clip(1 - F);
}

// ---------------------------------------------------------------- historical late rates (rule rows)

export interface RateRow {
  Plant: string;
  PurchaseOrderDate: string;
  RequestedDate: string | null;
  /** First goods receipt (null = none). */
  ReceiptDate: string | null;
  PlannedDays: number | null;
}

export interface RateGroup {
  overall: number | null;
  rows: number;
  perPlant: Record<string, number>;
}
export interface LateRates {
  asOf: string;
  fires: RateGroup;
  does_not_fire: RateGroup;
  no_realistic: RateGroup;
}

/**
 * Late rates of items due in [T − 365, T − 30), outcome as known at T (no
 * receipt before T = late), overall and per plant with ≥ 50 rows.
 */
export function lateRates(rows: RateRow[], asOf: string): LateRates {
  const lo = addDays(asOf, -RATE_WINDOW_DAYS[0]);
  const hi = addDays(asOf, -RATE_WINDOW_DAYS[1]);
  const acc: Record<
    keyof Omit<LateRates, "asOf">,
    { late: number; n: number; plant: Map<string, [number, number]> }
  > = {
    fires: { late: 0, n: 0, plant: new Map() },
    does_not_fire: { late: 0, n: 0, plant: new Map() },
    no_realistic: { late: 0, n: 0, plant: new Map() },
  };
  for (const r of rows) {
    const req = r.RequestedDate?.slice(0, 10);
    const po = r.PurchaseOrderDate?.slice(0, 10);
    if (!req || !po || req < lo || req >= hi || po >= asOf) continue;
    const gr = r.ReceiptDate?.slice(0, 10);
    const late = gr && gr < asOf ? (gr > req ? 1 : 0) : 1;
    const ok = isRealistic(r.PlannedDays);
    const g = !ok
      ? "no_realistic"
      : ruleFires(gapDays(po, req), Number(r.PlannedDays))
        ? "fires"
        : "does_not_fire";
    const a = acc[g];
    a.late += late;
    a.n += 1;
    const p = a.plant.get(r.Plant) ?? [0, 0];
    p[0] += late;
    p[1] += 1;
    a.plant.set(r.Plant, p);
  }
  const group = (a: (typeof acc)["fires"]): RateGroup => ({
    overall: a.n ? Math.round((a.late / a.n) * 10_000) / 10_000 : null,
    rows: a.n,
    perPlant: Object.fromEntries(
      [...a.plant]
        .filter(([, [, n]]) => n >= MIN_RATE_ROWS)
        .map(([p, [l, n]]) => [p, Math.round((l / n) * 10_000) / 10_000]),
    ),
  });
  return {
    asOf,
    fires: group(acc.fires),
    does_not_fire: group(acc.does_not_fire),
    no_realistic: group(acc.no_realistic),
  };
}

export function rateFor(
  rates: LateRates,
  verdict: RuleVerdict,
  plant: string,
): number | null {
  const g = rates[verdict];
  return g.perPlant[plant] ?? g.overall;
}

// ---------------------------------------------------------------- ranking

export interface Scored {
  PurchaseOrder: string;
  PurchaseOrderItem: string;
  PurchasingGroup: string | null;
  source: AtRiskSource;
  gap: number;
  ruleVerdict: RuleVerdict | null;
  pLate: number | null;
  net: number;
}

/** 0 requested before PO date, 1 rule fires, 2 probability, 3 rule does not fire. */
export function riskRank(
  s: Pick<Scored, "source" | "gap" | "ruleVerdict">,
): 0 | 1 | 2 | 3 {
  if (s.gap < 0) return 0;
  if (s.source !== "rule") return 2;
  return s.ruleVerdict === "fires" ? 1 : 3;
}

export function isAtRisk(s: Scored): boolean {
  if (s.pLate === null || Number.isNaN(s.pLate)) return s.gap < 0;
  return riskRank(s) <= 1 || (s.source !== "rule" && s.pLate >= LATE_AT);
}

/** At-risk items sorted by purchasing group, rank, net amount desc, P × net desc; top N per group. */
export function morningList<T extends Scored>(
  items: T[],
  top = TOP_PER_GROUP,
): T[] {
  const cand = items.filter(isAtRisk);
  const keyed = cand.map((s, i) => ({
    s,
    i,
    rank: riskRank(s),
    value: s.net || 0,
    ev: (s.pLate ?? 0) * (s.net || 0),
  }));
  keyed.sort(
    (a, b) =>
      (a.s.PurchasingGroup ?? "").localeCompare(b.s.PurchasingGroup ?? "") ||
      a.rank - b.rank ||
      b.value - a.value ||
      b.ev - a.ev ||
      a.i - b.i,
  );
  const count = new Map<string, number>();
  const out: T[] = [];
  for (const { s } of keyed) {
    const g = s.PurchasingGroup ?? "";
    const n = count.get(g) ?? 0;
    if (n >= top) continue;
    count.set(g, n + 1);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------- single item (feed, detail)

export interface ItemInput {
  gap: number | null;
  plannedDays: number | null;
  /** Grid of the line (own history or model); null = none. */
  grid?: Grid | null;
  nOwn?: number;
  /** Own lead times, for the empirical P. */
  history?: number[];
  /** Historical late rate of the rule verdict, when known. */
  rate?: number | null;
  /** Provenance of `grid` (tabpfn/fake/fallback/empirical/none); undefined = legacy. */
  gridSource?: string | null;
}

export interface ItemVerdict {
  atRisk: boolean;
  rank: 0 | 1 | 2 | 3 | null;
  source: AtRiskSource;
  ruleVerdict: RuleVerdict | null;
  pLate: number | null;
  flag: PdtFlag | null;
  reason: string;
}

/**
 * Single-item verdict (P-1): gap < 0 → at risk; usable planned time →
 * gap < planned; else gap < p50 of the range.
 */
export function verdictForItem(i: ItemInput): ItemVerdict {
  const flag = pdtFlag(i.plannedDays);
  const nOwn = i.nOwn ?? i.history?.length ?? 0;
  const source = sourceFor(i.plannedDays, nOwn, i.gridSource);
  if (i.gap === null || i.gap === undefined)
    return {
      atRisk: false,
      rank: null,
      source,
      ruleVerdict: null,
      pLate: null,
      flag,
      reason: "no requested date",
    };
  const gap = i.gap;
  let ruleVerdict: RuleVerdict | null = null;
  let pLate: number | null = null;
  if (source === "rule") {
    ruleVerdict = ruleFires(gap, Number(i.plannedDays))
      ? "fires"
      : "does_not_fire";
    pLate = i.rate ?? null;
  } else if (source === "empirical" && i.history?.length)
    pLate = pExceedEmpirical(i.history, gap);
  else if (i.grid) pLate = pExceedFromQuantiles(gridValues(i.grid), gap);
  const rank = riskRank({ source, gap, ruleVerdict });
  const p50 = gridAt(i.grid, 0.5);
  let atRisk: boolean;
  let reason: string;
  if (gap < 0) [atRisk, reason] = [true, "requested date before PO date"];
  else if (source === "rule")
    [atRisk, reason] = [
      ruleVerdict === "fires",
      ruleVerdict === "fires" ? "rule fires" : "rule does not fire",
    ];
  else if (p50 !== null)
    [atRisk, reason] = [
      gap < p50,
      gap < p50 ? "median lead time longer than the gap" : "no finding",
    ];
  else [atRisk, reason] = [false, "no lead time range"];
  return { atRisk, rank, source, ruleVerdict, pLate, flag, reason };
}

// ---------------------------------------------------------------- context sample (P-0)

/** numpy default_rng is not portable; a seeded mulberry32 draw keeps the sample reproducible. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded sample of `rows` (without replacement), then sorted by PO and item. */
export function plantSample<
  T extends { PurchaseOrder: string; PurchaseOrderItem: string },
>(all: T[], rows = PLANT_CONTEXT_ROWS, seed = CONTEXT_SEED): T[] {
  const sorted = [...all].sort(
    (a, b) =>
      a.PurchaseOrder.localeCompare(b.PurchaseOrder) ||
      a.PurchaseOrderItem.localeCompare(b.PurchaseOrderItem),
  );
  if (sorted.length <= rows) return sorted;
  const rnd = mulberry32(seed);
  const idx = sorted.map((_, i) => i);
  for (let i = 0; i < rows; i++) {
    const j = i + Math.floor(rnd() * (idx.length - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx
    .slice(0, rows)
    .sort((a, b) => a - b)
    .map((i) => sorted[i]);
}
