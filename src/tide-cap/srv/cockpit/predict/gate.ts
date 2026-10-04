// P-8 reality check, ranking and the chat result (pure).
import {
  Filters,
  Item,
  MIN_AUC,
  MIN_EVALUATED,
  MIN_PER_CLASS,
  REFUSAL,
  Request,
  SHOW_ROWS,
  TOO_LITTLE,
  TOP_K,
  Target,
  Verdict,
  days,
} from "./types";
import { supplierRegion } from "./features";
import { Labelled, Plan, context, plan } from "./plan";
import { auc, median } from "../kernel/stats";
import { predictionSource } from "../kernel/prediction-source";

export { auc, median };

export interface Gate {
  verdict: Verdict;
  evaluated: number;
  positives?: number;
  topPositive?: number;
  auc?: number;
  maeP50?: number;
  maeBaseline?: number;
  withinRange?: number;
  summary: string;
}

/** Order of the top TOP_K by score (stable: evaluation order on ties). */
const topIdx = (scores: number[]) =>
  scores
    .map((s, i) => [s, i] as const)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .slice(0, TOP_K)
    .map(([, i]) => i);

/**
 * Verdict of the reality check. `scores`: probability of the positive class
 * per evaluated item, or [p10, p50, p90] per item for lead time; null when
 * the minimum was not met (no model call).
 */
export function gate(
  req: Request,
  evaluated: Labelled[],
  backtestContext: Labelled[],
  scores: number[][] | null,
): Gate {
  const y = evaluated.map((e) => e.y);
  const n = y.length;
  if (req.target === "lead_time_days") {
    if (n < MIN_EVALUATED || !scores)
      return { verdict: "too little", evaluated: n, summary: TOO_LITTLE };
    const mae = y.reduce((a, v, i) => a + Math.abs(scores[i][1] - v), 0) / n;
    const mid = median(backtestContext.map((c) => c.y));
    const base = y.reduce((a, v) => a + Math.abs(mid - v), 0) / n;
    const inside = y.filter(
      (v, i) => v >= scores[i][0] && v <= scores[i][2],
    ).length;
    return {
      verdict: mae < base ? "pass" : "fail",
      evaluated: n,
      maeP50: Math.round(mae * 10) / 10,
      maeBaseline: Math.round(base * 10) / 10,
      withinRange: inside,
      summary:
        `Reality check: had I asked this 8 weeks ago, a typical miss was ${mae.toFixed(1)} days, ` +
        `against ${base.toFixed(1)} days for the usual duration; ${inside} of ${n} fell in the likely range`,
    };
  }
  const pos = y.filter((v) => v === 1).length;
  if (n < MIN_EVALUATED || Math.min(pos, n - pos) < MIN_PER_CLASS || !scores)
    return {
      verdict: "too little",
      evaluated: n,
      positives: pos,
      summary: TOO_LITTLE,
    };
  const s = scores.map((r) => r[0]);
  const top = topIdx(s).reduce((a, i) => a + y[i], 0);
  const a = auc(y, s);
  const word = req.target === "late_by_days" ? "late" : "partly delivered";
  const usual = Math.round((TOP_K * pos) / n);
  const ok = top / TOP_K > pos / n && a >= MIN_AUC;
  return {
    verdict: ok ? "pass" : "fail",
    evaluated: n,
    positives: pos,
    topPositive: top,
    auc: Number.isNaN(a) ? undefined : Math.round(a * 100) / 100,
    summary: `Reality check: had I asked this 8 weeks ago, ${top} of my top ${TOP_K} would have been ${word} (normally ${usual} of ${TOP_K})`,
  };
}

export const answerFor = (verdict: Verdict, target: Target) =>
  verdict === "too little"
    ? TOO_LITTLE
    : verdict === "fail"
      ? REFUSAL
      : `${target === "lead_time_days" ? "ranges" : "ranking"} in the results card`;

export const notEvaluatedLabel = (target: Target) =>
  `${target === "late_by_days" ? "outcome not yet known" : "not yet delivered"}, not evaluated`;

export interface RankedRow {
  rank: number;
  item: Item;
  score: number | null;
  p10Days: number | null;
  p50Days: number | null;
  p90Days: number | null;
}

/** Top SHOW_ROWS by probability (classification) or by p50 (lead time), stable. */
export function rank(
  rows: Item[],
  scores: number[][],
  req: Request,
): RankedRow[] {
  const range = req.target === "lead_time_days";
  const key = (i: number) => (range ? scores[i][1] : scores[i][0]);
  return rows
    .map((item, i) => ({ item, i }))
    .sort((a, b) => key(b.i) - key(a.i) || a.i - b.i)
    .slice(0, SHOW_ROWS)
    .map(({ item, i }, n) => ({
      rank: n + 1,
      item,
      score: range ? null : scores[i][0],
      p10Days: range ? Math.round(scores[i][0] * 10) / 10 : null,
      p50Days: range ? Math.round(scores[i][1] * 10) / 10 : null,
      p90Days: range ? Math.round(scores[i][2] * 10) / 10 : null,
    }));
}

/** Buyer words of the question, e.g. "late by more than 7 days". */
export function targetText(target: Target, lateDays: number | null): string {
  if (target === "late_by_days") return `late by more than ${lateDays} days`;
  if (target === "lead_time_days") return "lead time in days";
  return "partial first delivery";
}

// ------------------------------------------------------------------ result

/** Rows the model sees of a prediction (the card shows up to SHOW_ROWS). */
export const MODEL_ROWS = 10;

export interface ChatResultInput {
  ID: string;
  req: Request;
  filters: Filters;
  plan: Plan;
  check: Gate;
  ranked: RankedRow[];
  calls: number;
  latencyMs: number;
  link: (i: Item) => string | null;
  predictionRun?: { backend?: string | null; fallback?: string | null } | null;
}

/** The tool result (for the model) and the results card (for the UI) of one question. */
export function chatResult(x: ChatResultInput) {
  const { req, plan: p, check } = x;
  const noRows = check.verdict === "pass" && !p.rows.length;
  const rows = x.ranked.map((r) => ({
    rank: r.rank,
    PurchaseOrder: r.item.PurchaseOrder,
    PurchaseOrderItem: r.item.PurchaseOrderItem,
    Material: r.item.Material,
    Supplier: r.item.Supplier,
    SupplierRegion: supplierRegion(r.item.SupplierCountry),
    PurchasingGroup: r.item.PurchasingGroup,
    PurchaseOrderDate: r.item.PurchaseOrderDate,
    RequestedDate: r.item.RequestedDate,
    p10Days: r.p10Days,
    p50Days: r.p50Days,
    p90Days: r.p90Days,
    link: x.link(r.item),
  }));
  const result = {
    ID: x.ID,
    // Model calls label by the stored run so fake/fallback never read as tabpfn.
    source: !x.calls
      ? "rule"
      : x.predictionRun === undefined
        ? "tabpfn"
        : predictionSource(x.predictionRun),
    target: req.target,
    targetText: targetText(req.target, req.lateDays),
    lateDays: req.lateDays,
    filters: JSON.stringify(x.filters),
    realityCheck: check.summary,
    verdict: check.verdict,
    answer: noRows
      ? "no open items in this scope"
      : rows.length
        ? answerFor("pass", req.target)
        : answerFor(check.verdict, req.target),
    evaluated: check.evaluated,
    notEvaluated: `${p.notEvaluated} ${notEvaluatedLabel(req.target)}`,
    openItems: p.openItems,
    alreadyLate: req.target === "late_by_days" ? p.alreadyLate : null,
    rowsInCard: rows.length,
    rowsShown: Math.min(rows.length, MODEL_ROWS),
    rows,
    warnings:
      check.verdict === "pass"
        ? p.notes
        : [...p.notes, "Prediction is unvalidated: " + check.summary],
  };
  const card = {
    kind: "prediction",
    ...result,
    filters: x.filters,
    check: {
      summary: check.summary,
      evaluated: check.evaluated,
      positives: check.positives ?? null,
      topPositive: check.topPositive ?? null,
      auc: check.auc ?? null,
      maeP50: check.maeP50 ?? null,
      maeBaseline: check.maeBaseline ?? null,
      withinRange: check.withinRange ?? null,
      cutoff: p.cutoff,
      contextRows: p.backtestContext.length,
    },
    contextRows: p.context.length,
    modelCalls: x.calls,
    latencyMs: x.latencyMs,
  };
  return { result, card };
}
