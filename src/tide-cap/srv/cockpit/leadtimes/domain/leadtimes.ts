// Pure lead-time logic of the cockpit (P-3 … P-6). No CDS, no I/O.
//
// P-3 lead-time range: own history (≥ 20) → empirical quantiles; else one
//     model call over the narrowest context level with ≥ 5 rows.
// P-4 planned delivery time of an info record: placeholder rule, range check
//     against own lead times, proposal ceil(p80) of own lead times.
// P-5 buffer simulator: proposal from the older 70 % of own lead times,
//     checked on the later 30 %.
// P-6 material master planned delivery time: order-share weighted median of
//     the material's sources.

import { addDays } from "../../kernel/calendar";
import { groupBy } from "../../kernel/collections";

export const EMPIRICAL_MIN = 20;
export const MIN_CONTEXT = 5;
export const CONTEXT_ROWS = 2_500;
export const RELEVANCE_DAYS = 365;
export const DEFAULT_PDT = 2;
export const PLACEHOLDERS = [180, 360, 999];
export const PLACEHOLDER_MIN = 180;
export const PROPOSAL_QUANTILE = 0.8;
export const PROPOSAL_QUANTILES = [0.5, 0.6, 0.7, 0.8, 0.9];
export const LATER_SHARE = 0.3;
export const SIGNAL_DAYS = 2;
export const MM_MIN_POS = 5;
export const MISMATCH_DAYS = 3;
export const MISMATCH_SHARE = 0.2;
/** Special procurement keys supplied by another plant (stock transfer). */
export const STOCK_TRANSFER = new Set(["40", "45"]);
/** The 19 levels of a LeadTimeRange: 0.05, 0.10 … 0.95. */
export const LEVELS = Array.from(
  { length: 19 },
  (_, i) => Math.round((i + 1) * 5) / 100,
);

export type Levels = Record<string, number>; // "0.05" -> days

export const round1 = (v: number) => Math.round(v * 10) / 10;
export const round2 = (v: number) => Math.round(v * 100) / 100;
export const round3 = (v: number) => Math.round(v * 1000) / 1000;
export const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Linear interpolation between order statistics (numpy default). */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export const median = (xs: number[]) =>
  quantile(
    [...xs].sort((a, b) => a - b),
    0.5,
  );

/** Levels from values along `levels`: monotone, ≥ 0, one decimal. */
export function levelsFrom(values: number[], levels = LEVELS): Levels {
  let prev = 0;
  return Object.fromEntries(
    levels.map((l, i) => {
      prev = Math.max(prev, values[i] ?? prev, 0);
      return [String(l), round1(prev)];
    }),
  );
}

export function empiricalLevels(values: number[], levels = LEVELS): Levels {
  const s = [...values].sort((a, b) => a - b);
  return levelsFrom(
    levels.map((l) => quantile(s, l)),
    levels,
  );
}

export const levelAt = (
  g: Levels | null | undefined,
  q: number,
): number | null => (g ? (g[String(q)] ?? g[q.toFixed(2)] ?? null) : null);

/** Contract A1 JSON of 19 levels: keys "0.05" … "0.95" (two decimals, as the kernel fixtures). */
export const levelsJson = (g: Levels) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(g).map(([k, v]) => [Number(k).toFixed(2), v]),
    ),
  );

/** Parses stored levels (either key format) back to String(level) keys. */
export function parseLevels(json: string | null | undefined): Levels | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json);
    return Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [String(Number(k)), Number(v)]),
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- P-3 ladder

export type LadderLevel =
  "material_supplier" | "material" | "supplier" | "material_group" | "plant";

export const LADDER_TEXT: Record<LadderLevel, string> = {
  material_supplier: "material + supplier within plant",
  material: "material within plant",
  supplier: "supplier within plant",
  material_group: "material group within plant",
  plant: "whole plant (sample)",
};

export interface LadderKey {
  Material?: string | null;
  Supplier?: string | null;
  MaterialGroup?: string | null;
}

/** Context levels available for a key, narrowest first; the plant sample is always last. */
export function ladder(
  k: LadderKey,
): { level: LadderLevel; filter: Record<string, string> }[] {
  const out: { level: LadderLevel; filter: Record<string, string> }[] = [];
  if (k.Material && k.Supplier)
    out.push({
      level: "material_supplier",
      filter: { Material: k.Material, Supplier: k.Supplier },
    });
  if (k.Material)
    out.push({ level: "material", filter: { Material: k.Material } });
  if (k.Supplier)
    out.push({ level: "supplier", filter: { Supplier: k.Supplier } });
  if (k.MaterialGroup)
    out.push({
      level: "material_group",
      filter: { MaterialGroup: k.MaterialGroup },
    });
  out.push({ level: "plant", filter: {} });
  return out;
}

/**
 * First ladder level with at least MIN_CONTEXT rows; `count` answers the
 * number of context rows of a level (the plant sample is taken as is).
 */
export async function chooseLevel(
  k: LadderKey,
  count: (filter: Record<string, string>) => Promise<number> | number,
): Promise<{
  level: LadderLevel;
  filter: Record<string, string>;
  rows: number;
}> {
  for (const l of ladder(k)) {
    const n = await count(l.filter);
    if (l.level === "plant" || n >= MIN_CONTEXT)
      return { ...l, rows: Math.min(n, CONTEXT_ROWS) };
  }
  /* c8 ignore next */
  throw new Error("unreachable");
}

export interface LeadTimeRangeResult {
  Material: string | null;
  Supplier: string | null;
  Plant: string;
  source: "rule" | "empirical" | "tabpfn" | "fake" | "fallback" | "none";
  n: number;
  contextLevel: string;
  contextRows: number;
  p10: number | null;
  p50: number | null;
  p80: number | null;
  p90: number | null;
  levels: string | null; // JSON Levels
  sentence: string;
  note?: string;
}

const fmt = (v: number | null) =>
  v === null ? "–" : Number.isInteger(v) ? String(v) : v.toFixed(1);

/** The first-view sentence of a range, buyer words only. */
export function rangeSentence(
  r: Pick<
    LeadTimeRangeResult,
    "source" | "n" | "contextRows" | "p10" | "p50" | "p90"
  >,
): string {
  if (r.source === "rule")
    return "Supplied by another plant: no delivery time from a supplier.";
  if (r.p50 === null) return "No past deliveries to compare.";
  if (r.source === "empirical" && r.n >= EMPIRICAL_MIN)
    return `Your last ${r.n} deliveries took ${fmt(r.p50)} days on average, mostly between ${fmt(r.p10)} and ${fmt(r.p90)}.`;
  if (r.source === "empirical")
    return `Similar deliveries took ${fmt(r.p50)} days on average, mostly between ${fmt(r.p10)} and ${fmt(r.p90)}.`;
  if (r.source === "fallback")
    return `Context estimate from similar deliveries: about ${fmt(r.p50)} days, likely between ${fmt(r.p10)} and ${fmt(r.p90)}. Review the available history.`;
  return `AI estimate from similar deliveries: about ${fmt(r.p50)} days, likely between ${fmt(r.p10)} and ${fmt(r.p90)}. An estimate, not a promise.`;
}

export function rangeResult(
  key: { Material: string | null; Supplier: string | null; Plant: string },
  source: LeadTimeRangeResult["source"],
  n: number,
  contextLevel: string,
  contextRows: number,
  levels: Levels | null,
  note?: string,
): LeadTimeRangeResult {
  const base = {
    ...key,
    source,
    n,
    contextLevel,
    contextRows,
    p10: levelAt(levels, 0.1),
    p50: levelAt(levels, 0.5),
    p80: levelAt(levels, 0.8),
    p90: levelAt(levels, 0.9),
    levels: levels ? levelsJson(levels) : null,
    ...(note ? { note } : {}),
  };
  return { ...base, sentence: rangeSentence(base) };
}

/** Out of scope: stock transfer (special procurement 40/45). */
export function outOfScope(
  key: { Material: string | null; Supplier: string | null; Plant: string },
  spk: string,
) {
  return rangeResult(
    key,
    "rule",
    0,
    "stock transfer",
    0,
    null,
    `special procurement ${spk}: the supplying plant determines the lead time`,
  );
}

/** Own history with ≥ EMPIRICAL_MIN lead times, else null. */
export function ownRange(
  key: { Material: string | null; Supplier: string | null; Plant: string },
  own: number[],
): LeadTimeRangeResult | null {
  if (own.length < EMPIRICAL_MIN) return null;
  return rangeResult(
    key,
    "empirical",
    own.length,
    "own history of this source",
    own.length,
    empiricalLevels(own),
  );
}

/**
 * Range from a model answer. `fallback` set (no varying feature in the
 * context): the context quantiles are retained as an explicit fallback.
 */
export function modelRange(
  key: { Material: string | null; Supplier: string | null; Plant: string },
  nOwn: number,
  level: LadderLevel,
  contextRows: number,
  quantiles: number[],
  fallback: string | null,
): LeadTimeRangeResult {
  return rangeResult(
    key,
    fallback ? "fallback" : "tabpfn",
    nOwn,
    LADDER_TEXT[level],
    contextRows,
    levelsFrom(quantiles),
    fallback ? `context without a varying feature: ${fallback}` : undefined,
  );
}

// ---------------------------------------------------------------- P-4 pdt

export type PdtVerdict =
  "not_maintained" | "default" | "placeholder" | "below_range" | "above_range";

/** Placeholder rule: empty/0 not maintained, 2 default, 180/360/999/≥ 180 placeholder. */
export function placeholderRule(
  days: unknown,
): "not_maintained" | "default" | "placeholder" | null {
  const v = num(days);
  if (v === null || v === 0) return "not_maintained";
  if (v === DEFAULT_PDT) return "default";
  if (PLACEHOLDERS.includes(v) || v >= PLACEHOLDER_MIN) return "placeholder";
  return null;
}

export const realistic = (days: unknown) => placeholderRule(days) === null;

/** Current value: info record if > 0, else material master. */
export function currentValue(
  infoRecordDays: unknown,
  masterDays: unknown,
): { days: number | null; from: "info record" | "material master" } {
  const ir = num(infoRecordDays);
  if (ir !== null && ir > 0) return { days: ir, from: "info record" };
  const m = num(masterDays);
  return { days: m, from: "material master" };
}

/** Signal when info record and material master differ by ≥ SIGNAL_DAYS. */
export function masterSignal(
  infoRecordDays: unknown,
  masterDays: unknown,
): boolean {
  const ir = num(infoRecordDays);
  const m = num(masterDays);
  return ir !== null && m !== null && ir > 0 && Math.abs(ir - m) >= SIGNAL_DAYS;
}

export interface PdtCheck {
  verdict: PdtVerdict;
  source: "rule" | "empirical";
  p10: number | null;
  p50: number | null;
  p80: number | null;
  p90: number | null;
}

/** A finding when the rule fires, or with ≥ 20 own lead times outside p10…p90; else null. */
export function pdtCheck(
  current: number | null,
  own: number[],
): PdtCheck | null {
  const s = [...own].sort((a, b) => a - b);
  const has = s.length >= EMPIRICAL_MIN;
  const q = (x: number) => (has ? round1(quantile(s, x)) : null);
  const stats = { p10: q(0.1), p50: q(0.5), p80: q(0.8), p90: q(0.9) };
  const ruled = placeholderRule(current);
  if (ruled) return { verdict: ruled, source: "rule", ...stats };
  if (!has) return null;
  const v = current as number;
  if (v < (stats.p10 as number))
    return { verdict: "below_range", source: "empirical", ...stats };
  if (v > (stats.p90 as number))
    return { verdict: "above_range", source: "empirical", ...stats };
  return null;
}

/** Proposal ceil(p80) of own lead times, only with ≥ 20; else null ("no proposal"). */
export function pdtProposal(
  own: number[],
  q = PROPOSAL_QUANTILE,
): number | null {
  if (own.length < EMPIRICAL_MIN) return null;
  return Math.ceil(
    quantile(
      [...own].sort((a, b) => a - b),
      q,
    ),
  );
}

/** Buyer words of a verdict (explain.py VERDICT_PLAIN). */
export const VERDICT_PLAIN: Record<
  PdtVerdict | "within_range" | "no_range",
  string
> = {
  below_range: "shorter than recent deliveries",
  above_range: "longer than recent deliveries",
  within_range: "in line with recent deliveries",
  default: "system default",
  placeholder: "a placeholder",
  not_maintained: "not maintained",
  no_range: "no past deliveries to compare",
};

export const VERDICT_TECHNICAL: Record<PdtVerdict, string> = {
  not_maintained: "0 days or empty: field not maintained",
  default: "2 days: system default, likely never maintained",
  placeholder: "value in 180, 360, 999 or at least 180 days",
  below_range: "below p10 of own lead times",
  above_range: "above p90 of own lead times",
};

const days = (v: number | null) => (v === null ? "not set" : `${fmt(v)} days`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface PdtRowInput {
  current: number | null;
  from: "info record" | "material master";
  check: PdtCheck;
  proposal: number | null;
  nOwn: number;
}

/** "Info record 5 days: shorter than recent deliveries" */
export function pdtIssue(r: PdtRowInput): string {
  return `${cap(r.from)} ${days(r.current)}: ${VERDICT_PLAIN[r.check.verdict]}`;
}

export function pdtIssueTechnical(r: PdtRowInput): string {
  const range =
    r.check.p10 === null
      ? ""
      : `; own lead times p10 ${r.check.p10} / p50 ${r.check.p50} / p90 ${r.check.p90} (n = ${r.nOwn})`;
  return `${r.from} ${days(r.current)}: ${VERDICT_TECHNICAL[r.check.verdict]} (${r.check.source})${range}`.slice(
    0,
    300,
  );
}

export function pdtChain(
  r: PdtRowInput,
  trigger: "morning" | "arrived" = "morning",
): string {
  const bits = [
    `planned delivery time is ${days(r.current)} (${VERDICT_PLAIN[r.check.verdict]})`,
  ];
  if (r.check.p50 !== null)
    bits.push(`deliveries took ${fmt(r.check.p50)} days on average`);
  bits.push(
    r.proposal === null
      ? "no suggestion yet: too few past deliveries"
      : `suggested ${r.proposal} days`,
  );
  const when =
    trigger === "arrived" ? "Checked as it arrived" : "Checked this morning";
  return `${when}: ${bits.map(cap).join(". ")}. Next: add to the change list.`;
}

export function pdtTechnicalChain(
  r: PdtRowInput,
  trigger: "morning" | "arrived" = "morning",
): string {
  const t =
    trigger === "arrived" ? "arrived during the day" : "morning run at 06:00";
  const proposal =
    r.proposal === null
      ? `no proposal: fewer than ${EMPIRICAL_MIN} own lead times`
      : `proposal ceil(p80) = ${r.proposal} days`;
  return [
    t,
    `planned delivery time against own lead times (${r.check.source})`,
    `${pdtIssueTechnical(r)}; ${proposal}`,
    "add to the change list",
  ]
    .join(" → ")
    .slice(0, 1000);
}

/** Rank: 12-month EUR value desc, then PO count desc. */
export const pdtOrder = (
  a: { value12m: number; pos12m: number },
  b: { value12m: number; pos12m: number },
) => b.value12m - a.value12m || b.pos12m - a.pos12m;

// ---------------------------------------------------------------- P-5 buffer

export interface BufferRow {
  quantile: number;
  label: string;
  proposalDays: number;
  lateShare: number;
  meanBufferDays: number;
  meanDaysLate: number;
  nOlder: number;
  nLater: number;
  isCurrent: boolean;
}

/** Split of own lead times in receipt order: older 70 %, later 30 % (at least 1). */
export function splitByReceipt<T>(byReceipt: T[]): { older: T[]; later: T[] } {
  const nLater = Math.max(1, Math.round(byReceipt.length * LATER_SHARE));
  return {
    older: byReceipt.slice(0, byReceipt.length - nLater),
    later: byReceipt.slice(byReceipt.length - nLater),
  };
}

/**
 * Buffer simulator: needs ≥ 20 own lead times (in receipt order). Per
 * quantile 0.5 … 0.9 the proposal from the older part, the share of later
 * deliveries above it, mean buffer and mean days late; plus a row for the
 * current value (isCurrent). Empty below 20.
 */
export function bufferSimulator(
  leadTimesByReceipt: number[],
  current: number | null,
): BufferRow[] {
  const n = leadTimesByReceipt.length;
  if (n < EMPIRICAL_MIN) return [];
  const { older, later } = splitByReceipt(leadTimesByReceipt);
  const sorted = [...older].sort((a, b) => a - b);
  const row = (
    quantileLevel: number,
    label: string,
    p: number,
    isCurrent: boolean,
  ): BufferRow => ({
    quantile: quantileLevel,
    label,
    proposalDays: p,
    lateShare: round3(later.filter((v) => v > p).length / later.length),
    meanBufferDays: round2(mean(later.map((v) => Math.max(p - v, 0)))),
    meanDaysLate: round2(mean(later.map((v) => Math.max(v - p, 0)))),
    nOlder: older.length,
    nLater: later.length,
    isCurrent,
  });
  const rows = PROPOSAL_QUANTILES.map((q) =>
    row(q, `p${Math.round(q * 100)}`, Math.ceil(quantile(sorted, q)), false),
  );
  if (current !== null && Number.isFinite(current)) {
    // Quantile of the current value within the older part (for ordering on a slider).
    const at = sorted.filter((v) => v <= current).length / sorted.length;
    rows.push(row(round3(at), "current", Math.round(current), true));
  }
  return rows;
}

/** Buyer sentence of one simulator row. */
export function bufferSentence(r: BufferRow): string {
  const s = r.lateShare;
  const later =
    s <= 0
      ? "none"
      : s >= 0.999
        ? "every delivery"
        : `about 1 in ${Math.max(1, Math.round(1 / s))}`;
  const early =
    r.meanBufferDays > 0
      ? ` Deliveries arrive ${fmt(round1(r.meanBufferDays))} days early on average.`
      : "";
  return `If you plan with ${r.proposalDays} days: later than planned ${later}.${early}`;
}

// ---------------------------------------------------------------- P-6 mm_pdt

export interface MmPo {
  Material: string;
  Supplier: string;
  PurchaseOrderDate: string;
}

export interface MmSource {
  Material: string;
  Supplier: string;
  pos: number;
  share: number;
  nOwn: number;
  source: "empirical" | "tabpfn" | "fallback" | "none";
  median: number | null;
  infoRecordDays: number | null;
}

/**
 * Sources of materials in one plant: (material, supplier) with POs in the
 * RELEVANCE_DAYS before asOf, stock transfer materials excluded, materials
 * with ≥ MM_MIN_POS POs. Median from own lead times with ≥ 20, else left for
 * the model (source tabpfn, median null).
 */
export function mmSources(
  pos: MmPo[],
  asOf: string,
  stockTransfer: Set<string>,
  own: (m: string, s: string) => number[],
  infoRecord: (m: string, s: string) => number | null,
): MmSource[] {
  const since = addDays(asOf, -RELEVANCE_DAYS);
  const counts = new Map<string, Map<string, number>>();
  for (const p of pos) {
    if (!p.Material || !p.Supplier || stockTransfer.has(p.Material)) continue;
    if (p.PurchaseOrderDate < since || p.PurchaseOrderDate >= asOf) continue;
    const m =
      counts.get(p.Material) ??
      counts.set(p.Material, new Map()).get(p.Material)!;
    m.set(p.Supplier, (m.get(p.Supplier) ?? 0) + 1);
  }
  const out: MmSource[] = [];
  for (const [material, bySupplier] of counts) {
    const total = [...bySupplier.values()].reduce((a, b) => a + b, 0);
    if (total < MM_MIN_POS) continue;
    for (const [supplier, n] of bySupplier) {
      const lts = own(material, supplier);
      const has = lts.length >= EMPIRICAL_MIN;
      out.push({
        Material: material,
        Supplier: supplier,
        pos: n,
        share: n / total,
        nOwn: lts.length,
        source: has ? "empirical" : "tabpfn",
        median: has ? round1(median(lts)) : null,
        infoRecordDays: infoRecord(material, supplier),
      });
    }
  }
  return out.sort(
    (a, b) =>
      a.Material.localeCompare(b.Material) ||
      b.pos - a.pos ||
      a.Supplier.localeCompare(b.Supplier),
  );
}

export const mmTolerance = (proposal: number) =>
  Math.max(MISMATCH_DAYS, MISMATCH_SHARE * proposal);

export interface MmProposal {
  Material: string;
  pos: number;
  proposal: number | null;
  master: number | null;
  difference: number | null;
  tolerance: number | null;
  mismatch: boolean;
  masterFlag: "not_maintained" | "default" | "placeholder" | null;
  sources: MmSource[];
}

/** Per material: ceil(Σ share × median / Σ share) over sources with a median; mismatch; sorted by PO count desc. */
export function mmProposals(
  sources: MmSource[],
  master: (m: string) => number | null,
): MmProposal[] {
  const by = groupBy(sources, (s) => s.Material);
  const out: MmProposal[] = [];
  for (const [material, list] of by) {
    const ok = list.filter((s) => s.median !== null);
    const w = ok.reduce((a, s) => a + s.share, 0);
    const proposal =
      w > 0
        ? Math.ceil(
            round3(
              ok.reduce((a, s) => a + s.share * (s.median as number), 0) / w,
            ),
          )
        : null;
    const m = master(material);
    const difference = proposal !== null && m !== null ? m - proposal : null;
    const tolerance = proposal === null ? null : mmTolerance(proposal);
    const mismatch =
      proposal !== null &&
      (m === null || Math.abs(difference as number) > (tolerance as number));
    out.push({
      Material: material,
      pos: list.reduce((a, s) => a + s.pos, 0),
      proposal,
      master: m,
      difference,
      tolerance,
      mismatch,
      masterFlag: m === null ? "not_maintained" : placeholderRule(m),
      sources: [...list].sort((a, b) => b.pos - a.pos),
    });
  }
  return out.sort(
    (a, b) => b.pos - a.pos || a.Material.localeCompare(b.Material),
  );
}

export const MASTER_FLAG_TEXT: Record<
  "not_maintained" | "default" | "placeholder",
  string
> = {
  not_maintained: "not maintained",
  default: "system default",
  placeholder: "placeholder",
};

export function mmIssue(p: MmProposal): string {
  const flag = p.masterFlag ? ` (${VERDICT_PLAIN[p.masterFlag]})` : "";
  if (p.master === null)
    return `Material master not set; suppliers suggest ${p.proposal} days`;
  const dir = (p.difference as number) < 0 ? "too short" : "too long";
  return `Material master ${days(p.master)}${flag}: ${fmt(Math.abs(p.difference as number))} days ${dir}; suppliers suggest ${p.proposal} days`;
}

export function mmIssueTechnical(p: MmProposal): string {
  return `master ${p.master ?? "missing"} vs order-share weighted median ${p.proposal} over ${p.sources.length} sources; tolerance max(${MISMATCH_DAYS}, ${MISMATCH_SHARE} × proposal) = ${p.tolerance}`.slice(
    0,
    300,
  );
}

export function mmChain(
  p: MmProposal,
  trigger: "morning" | "arrived" = "morning",
): string {
  const when =
    trigger === "arrived" ? "Checked as it arrived" : "Checked this morning";
  const flag = p.masterFlag ? ` (${VERDICT_PLAIN[p.masterFlag]})` : "";
  return `${when}: The material master says ${days(p.master)}${flag}. Its suppliers suggest ${p.proposal} days. Next: add to the change list.`;
}

export function mmTechnicalChain(
  p: MmProposal,
  trigger: "morning" | "arrived" = "morning",
): string {
  const t =
    trigger === "arrived" ? "arrived during the day" : "morning run at 06:00";
  const src = [...new Set(p.sources.map((s) => s.source))].join("/");
  return [
    t,
    `material master against the order-share weighted sources (${src})`,
    mmIssueTechnical(p),
    "add to the change list",
  ]
    .join(" → ")
    .slice(0, 1000);
}

/** Expert JSON of the sources of a material (UI sources table). */
export function mmSourcesJson(p: MmProposal, plant: string) {
  return p.sources.map((s) => ({
    Supplier: s.Supplier,
    pos: s.pos,
    // Shares are evidence weights. Keep the exact fraction used for the
    // weighted proposal instead of rounding the persisted source evidence.
    share: s.share,
    nOwn: s.nOwn,
    source: s.source,
    median: s.median,
    infoRecordDays: s.infoRecordDays,
    findingID: `pdt:${s.Material}|${s.Supplier}|${plant}`,
  }));
}

// ---------------------------------------------------------------- expert codec

/** Expert JSON of pdt / mm_pdt findings: the fields other code reads (kernel reads proposalDays). */
export interface LeadTimeExpert {
  proposalDays: number | null;
  currentDays?: number | null;
  currentFrom?: "info record" | "material master";
  masterDays?: number | null;
  PurchasingInfoRecord?: string | null;
  [k: string]: unknown;
}

export const serializeExpert = (e: LeadTimeExpert) => JSON.stringify(e);

export function parseExpert(json: string | null | undefined): LeadTimeExpert {
  if (!json) return { proposalDays: null };
  try {
    const e = JSON.parse(json);
    return e && typeof e === "object"
      ? { proposalDays: null, ...e }
      : { proposalDays: null };
  } catch {
    return { proposalDays: null };
  }
}

/** Legacy SourceRange.quantiles keys: String(level) ("0.1"), from 19-level JSON. */
export function legacyQuantiles(levelsJsonText: string): string {
  const g = parseLevels(levelsJsonText) ?? {};
  return JSON.stringify(g);
}

// ---------------------------------------------------------------- dates

export { addDays };
