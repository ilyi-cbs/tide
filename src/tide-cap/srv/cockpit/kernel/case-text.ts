// Buyer words for case rows; pure helpers shared by readers and the Finding writers.
import type { FindingList, ImpactLevel, Source } from "./types";

const SOURCE_TEXT: Record<Source, string> = {
  rule: "Check",
  lookup: "Master data",
  empirical: "Past deliveries",
  tabpfn: "AI estimate",
  fake: "Test estimate",
  calculation: "Calculated",
  confirmation: "Supplier confirmation",
  fallback: "Past deliveries",
  none: "–",
};

/** Buyer word of a source (§2); unknown or missing → "–". */
export function sourceText(s: string | null | undefined): string {
  return SOURCE_TEXT[s as Source] ?? SOURCE_TEXT.none;
}

/** Buyer word of a list (§Type column). */
const LIST_TEXT: Record<FindingList, string> = {
  at_risk: "At Risk",
  overdue: "Overdue",
  price: "Price",
  pdt: "Planned Delivery Time",
  mm_pdt: "Planned Delivery Time",
  freetext: "Free Text",
  duplicate: "Duplicate",
  rare: "Rare",
};

const LIST_CRITICALITY: Record<FindingList, number> = {
  at_risk: 2,
  overdue: 1,
  price: 1,
  pdt: 2,
  mm_pdt: 1,
  freetext: 0,
  duplicate: 5,
  rare: 2,
};

export function listText(l: FindingList | string | null | undefined): string {
  return LIST_TEXT[l as FindingList] ?? String(l ?? "");
}

export function listCriticality(
  l: FindingList | string | null | undefined,
): number {
  return LIST_CRITICALITY[l as FindingList] ?? 0;
}

/** Open findings require attention; closed findings communicate a successful resolution. */
export function statusCriticality(status: string | null | undefined): number {
  return status === "closed" ? 3 : status === "open" ? 2 : 0;
}

const IMPACT_TEXT: Record<ImpactLevel, string> = {
  customer_order_late: "Customer order at risk",
  production_affected: "Production at risk",
  stock_uncovered: "Stock runs short",
  covered_by_stock: "Stock covers it",
  no_impact: "No impact",
};

const IMPACT_CRITICALITY: Record<ImpactLevel, number> = {
  customer_order_late: 1,
  production_affected: 1,
  stock_uncovered: 2,
  covered_by_stock: 3,
  no_impact: 0,
};

/** P-2 rank of an impact level: 0 most severe … 4 no impact; unknown → 5. */
export function impactRank(level: string | null | undefined): number {
  const i = Object.keys(IMPACT_TEXT).indexOf(String(level));
  return i < 0 ? 5 : i;
}

/** 1 red, 2 yellow, 3 green, 0 neutral (no impact or no level). */
export function impactCriticality(level: string | null | undefined): number {
  return IMPACT_CRITICALITY[level as ImpactLevel] ?? 0;
}

const eur = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** "Customer order at risk · 12,400 EUR"; revenue only when > 0. Empty for no level. */
export function impactText(
  level: string | null | undefined,
  revenue?: number | null,
): string {
  const text = IMPACT_TEXT[level as ImpactLevel];
  if (!text) return "";
  return revenue && revenue > 0
    ? `${text} · ${eur.format(Math.round(revenue))} EUR`
    : text;
}

export const findingID = (list: FindingList | string, objectKey: string) =>
  `${list}:${objectKey}`;
