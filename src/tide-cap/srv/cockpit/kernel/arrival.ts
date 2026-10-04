// Arrival of a PO item that is still open at the as-of day: the lead-time
// grid conditioned on "not arrived yet" (lead time > age). Without this an
// old open item's range lies in the past and collapses to "today" (OPEN.md
// F-1). Pure: no CDS, no I/O, "today" is a parameter (NS-B2).
import { addDays, daysBetween } from "./calendar";
import { round } from "./stats";

/** Grid JSON shape: level ("0.05" or "0.1") -> lead time in days. */
export type LevelGrid = Record<string, number>;
export type OpenBasis = "grid" | "survivors" | "none";

/** 19 levels 0.05 … 0.95, the shape of every stored line grid. */
export const OPEN_LEVELS = Array.from(
  { length: 19 },
  (_, k) => Math.round(5 * (k + 1)) / 100,
);
/** Above this share of the grid already passed, the grid's tail is too thin to condition on. */
export const OPEN_MAX_PASSED = 0.9;
/** Fewest past lead times longer than the item's age for the survivor fallback. */
export const SURVIVOR_MIN = 20;

type Pts = Array<[number, number]>;

function points(g: LevelGrid | null | undefined): Pts | null {
  if (!g) return null;
  const pts = Object.entries(g)
    .map(([k, v]) => [Number(k), Number(v)] as [number, number])
    .filter(
      ([k, v]) => Number.isFinite(k) && Number.isFinite(v) && k > 0 && k < 1,
    )
    .sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return null;
  for (let i = 1; i < pts.length; i++)
    pts[i][1] = Math.max(pts[i][1], pts[i - 1][1]);
  return pts;
}

/** Days at `level`: linear between points, beyond the last point along the last segment. */
function quantileAt(pts: Pts, level: number): number {
  if (level <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [l1, v1] = pts[i];
    if (level <= l1) {
      const [l0, v0] = pts[i - 1];
      return v0 + ((v1 - v0) * (level - l0)) / (l1 - l0);
    }
  }
  const [l0, v0] = pts[pts.length - 2];
  const [l1, v1] = pts[pts.length - 1];
  return v1 + ((v1 - v0) * (level - l1)) / (l1 - l0);
}

/** Share of lead times at or below `days`: linear from (floor days, 0) to the first point, between points, along the last segment above. */
function cdfAt(pts: Pts, days: number, floor = 0): number {
  const [l0, v0] = pts[0];
  if (days <= floor) return 0;
  if (days <= v0) return v0 > floor ? (l0 * (days - floor)) / (v0 - floor) : l0;
  for (let i = 1; i < pts.length; i++) {
    const [la, va] = pts[i - 1];
    const [lb, vb] = pts[i];
    if (days <= vb)
      return vb === va ? lb : la + ((lb - la) * (days - va)) / (vb - va);
  }
  const [la, va] = pts[pts.length - 2];
  const [lb, vb] = pts[pts.length - 1];
  return vb === va
    ? 1
    : Math.min(1, lb + ((lb - la) * (days - vb)) / (vb - va));
}

/**
 * Grid of an item that has not arrived after `ageDays`: the levels of the
 * lead time given lead time > age. Null when the age is beyond the grid's
 * tail (more than OPEN_MAX_PASSED of it already passed).
 */
export function openGrid(
  grid: LevelGrid | null | undefined,
  ageDays: number,
): LevelGrid | null {
  const pts = points(grid);
  if (!pts) return null;
  const passed = ageDays > 0 ? cdfAt(pts, ageDays) : 0;
  if (passed > OPEN_MAX_PASSED) return null;
  return Object.fromEntries(
    OPEN_LEVELS.map((q) => [
      q.toFixed(2),
      round(Math.max(ageDays, quantileAt(pts, passed + q * (1 - passed))), 2),
    ]),
  );
}

/** Fallback when the age is beyond the grid: past lead times longer than the age, at least SURVIVOR_MIN of them. */
export function survivorGrid(
  history: readonly number[],
  ageDays: number,
  min = SURVIVOR_MIN,
): LevelGrid | null {
  const s = history.filter((h) => h > ageDays).sort((a, b) => a - b);
  if (s.length < min) return null;
  const at = (q: number) => {
    const pos = q * (s.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  };
  return Object.fromEntries(
    OPEN_LEVELS.map((q) => [q.toFixed(2), round(at(q), 2)]),
  );
}

export interface OpenArrival {
  basis: OpenBasis;
  grid: LevelGrid | null;
  p10: string | null;
  p50: string | null;
  p80: string | null;
  p90: string | null;
}

const NO_ARRIVAL: OpenArrival = {
  basis: "none",
  grid: null,
  p10: null,
  p50: null,
  p80: null,
  p90: null,
};

export function modelArrival(poDate: string | null, grid: LevelGrid | null | undefined, asOf: string): OpenArrival {
  const pts = points(grid);
  if (!poDate || !pts || pts[0][1] <= Math.max(0, daysBetween(poDate, asOf))) return NO_ARRIVAL;
  const date = (level: number) => addDays(poDate, Math.ceil(quantileAt(pts, level) - 1e-9));
  return {
    basis: "grid",
    grid: Object.fromEntries(pts.map(([level, days]) => [level.toFixed(2), days])),
    p10: date(0.1),
    p50: date(0.5),
    p80: date(0.8),
    p90: date(0.9),
  };
}

/** Arrival dates of an open item: conditioned grid, else survivors of `pool`, else none. No date before `asOf`. */
export function openArrival(
  poDate: string | null,
  grid: LevelGrid | null | undefined,
  asOf: string,
  pool: readonly number[] = [],
): OpenArrival {
  if (!poDate) return NO_ARRIVAL;
  const age = Math.max(0, daysBetween(poDate, asOf));
  let basis: OpenBasis = "grid";
  let g = openGrid(grid, age);
  if (!g) {
    basis = "survivors";
    g = survivorGrid(pool, age);
  }
  if (!g) return NO_ARRIVAL;
  const pts = points(g)!;
  const date = (q: number) => {
    const d = addDays(poDate, Math.ceil(quantileAt(pts, q) - 1e-9));
    return d > asOf ? d : asOf;
  };
  return {
    basis,
    grid: g,
    p10: date(0.1),
    p50: date(0.5),
    p80: date(0.8),
    p90: date(0.9),
  };
}

/** Share of an open item's lead times (open grid, item age `ageDays`) above `gapDays`: P = 1 − F(gap + 0.5); null without a grid. */
export function chanceAfter(
  open: LevelGrid | null | undefined,
  gapDays: number,
  ageDays: number,
): number | null {
  const pts = points(open);
  if (!pts) return null;
  return round(1 - cdfAt(pts, gapDays + 0.5, ageDays), 2);
}
