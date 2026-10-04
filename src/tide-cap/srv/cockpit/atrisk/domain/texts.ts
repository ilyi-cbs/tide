// Buyer-facing text uses one row's values and avoids probability claims.
import { dayText } from "../../kernel/calendar";
import {
  EMPIRICAL_MIN,
  PDT_FLAG_WORDS,
  type AtRiskSource,
  type PdtFlag,
  type RuleVerdict,
} from "./rules";

export const RULE_LABEL = "historical late rate of this verdict";
export const NOT_CALIBRATED = "for ordering, not calibrated";

// ---------------------------------------------------------------- texts (P-11)

const n0 = (v: number) =>
  Number.isInteger(v) ? String(v) : (Math.round(v * 10) / 10).toString();
const days = (v: number) => `${n0(v)} ${Math.abs(v) === 1 ? "day" : "days"}`;

export const SOURCE_CHECK: Record<AtRiskSource, string> = {
  rule: "requested gap against the planned delivery time (rule)",
  empirical: "requested gap against the lead time range (own history)",
  tabpfn: "requested gap against the lead time range (TabPFN)",
  fake: "requested gap against a test-provider range; not TabPFN evidence",
  fallback: "requested gap against a fallback lead time range",
};

export interface TextInput {
  source: AtRiskSource;
  gap: number;
  plannedDays: number | null;
  flag: PdtFlag | null;
  p50: number | null;
  /** Trigger: morning run or arrived during the day. */
  arrived?: boolean;
}

/** Expected days late: planned (rule) or typical (model) duration beyond the gap. */
export function expectedDelay(
  t: Pick<TextInput, "source" | "gap" | "plannedDays" | "p50">,
): number {
  const expected = t.source === "rule" ? t.plannedDays : t.p50;
  if (expected === null || expected === undefined) return 0;
  return Math.max(0, Math.ceil(expected) - t.gap);
}

function plannedWords(t: TextInput): string | null {
  if (t.flag === "not_maintained") return "no planned time is maintained";
  if (t.plannedDays === null || t.plannedDays === undefined) return null;
  const base = `the planned time is ${days(Number(t.plannedDays))}`;
  return t.flag ? `${base} (${PDT_FLAG_WORDS[t.flag]})` : base;
}

/** "What is wrong", buyer words; no probabilities. */
export function issueText(t: TextInput): string {
  if (t.source === "fake")
    return "Test-provider estimate; not measured delivery evidence";
  if (t.gap < 0) return `Requested ${days(-t.gap)} before the order date`;
  const bits = [`Needed in ${days(t.gap)}`];
  const planned = plannedWords(t);
  if (t.source === "rule") {
    if (planned) bits.push(planned);
  } else if (t.p50 !== null) {
    bits.push(
      `${t.source === "empirical" ? "past deliveries" : "similar deliveries"} usually take ${days(Math.ceil(t.p50))}`,
    );
  } else if (planned) bits.push(planned);
  const late = expectedDelay(t);
  return bits.join(", ") + (late > 0 ? `; expected ${days(late)} late` : "");
}

export function issueTechnical(t: TextInput): string {
  const parts = [`gap ${days(t.gap)}`];
  if (t.plannedDays !== null && t.plannedDays !== undefined)
    parts.push(`planned ${days(Number(t.plannedDays))}`);
  if (t.source !== "rule" && t.p50 !== null) parts.push(`p50 ${days(t.p50)}`);
  const late = expectedDelay(t);
  return parts.join(", ") + (late > 0 ? `; expected ${days(late)} late` : "");
}

export const NEXT_STEP = "Prepare a reminder";

function sentence(bits: string[]): string {
  const text = bits
    .filter(Boolean)
    .map((b) => b[0].toUpperCase() + b.slice(1))
    .join(". ");
  return text && !text.endsWith(".") ? `${text}.` : text;
}

/** Plain chain: "Checked this morning: … → Next: prepare a reminder." */
export function chainText(t: TextInput): string {
  if (t.source === "fake")
    return "Test-provider estimate; not measured delivery evidence.";
  const when = t.arrived ? "Checked as it arrived" : "Checked this morning";
  const bits: string[] = [];
  if (t.gap < 0)
    bits.push(`the requested date is ${days(-t.gap)} before the order date`);
  else bits.push(`the requested date is ${days(t.gap)} after the order`);
  const planned = plannedWords(t);
  if (planned) bits.push(planned);
  if (t.source !== "rule" && t.p50 !== null)
    bits.push(
      `${t.source === "empirical" ? "past deliveries" : "similar deliveries"} usually take ${days(Math.ceil(t.p50))}`,
    );
  const late = expectedDelay(t);
  if (late > 0) bits.push(`expected ${days(late)} late`);
  return `${when}: ${sentence(bits)} → Next: ${NEXT_STEP.toLowerCase()}.`;
}

/** Technical chain: Trigger → Check → Result → Next. */
export function technicalChainText(t: TextInput): string {
  const trigger = t.arrived ? "arrived during the day" : "morning run at 06:00";
  const check =
    t.gap < 0
      ? "requested date against the PO date (rule)"
      : SOURCE_CHECK[t.source];
  return [trigger, check, issueTechnical(t), NEXT_STEP.toLowerCase()].join(
    " → ",
  );
}

export function itemTitle(
  po: string,
  item: string,
  materialText: string | null | undefined,
): string {
  return [`${po}/${item}`, materialText]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 120);
}

export function itemSubtitle(
  supplierName: string | null | undefined,
  plant: string | null | undefined,
): string {
  return [supplierName, plant ? `Plant ${plant}` : null]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 200);
}

/** Range sentence (P-11): own history with counts, model without. */
export function rangeSentence(
  source: string,
  nOwn: number,
  g: { p10: number | null; p50: number | null; p90: number | null },
): string {
  if (g.p50 === null || g.p10 === null || g.p90 === null) return "";
  if (source === "fake")
    return "Test-provider range; not measured TabPFN evidence.";
  if (source === "empirical" && nOwn >= EMPIRICAL_MIN)
    return `Your last ${nOwn} deliveries took ${n0(g.p50)} days on average, mostly between ${n0(g.p10)} and ${n0(g.p90)}.`;
  return `AI estimate from similar deliveries: about ${n0(g.p50)} days, likely between ${n0(g.p10)} and ${n0(g.p90)}. An estimate, not a promise.`;
}

/** Range in words with the item's markers: "Fast 8 days · typical 12 days · slow 20 days. Requested 5 days after the order, planned 14 days." */
export function rangeWords(
  g: { p10: number | null; p50: number | null; p90: number | null },
  gap: number | null = null,
  planned: number | null = null,
): string {
  if (g.p50 === null || g.p10 === null || g.p90 === null)
    return "No estimate for this delivery yet.";
  let text = `Fast ${days(g.p10)} · typical ${days(g.p50)} · slow ${days(g.p90)}.`;
  if (gap !== null) text += ` Requested ${days(gap)} after the order`;
  if (planned !== null)
    text +=
      gap !== null ? `, planned ${days(planned)}` : ` Planned ${days(planned)}`;
  return gap !== null || planned !== null ? `${text}.` : text;
}

/** When the stored range was estimated (the section's note; Recompute is not offered for the morning grid). */
export const NOTE_TEXT: Record<"morning" | "arrived" | "receipt", string> = {
  morning: "Estimated this morning.",
  arrived: "Estimated when the order arrived.",
  receipt:
    "Estimated again after the latest goods receipt of this material from this supplier.",
};

export interface ArrivalTextInput {
  basis: "grid" | "survivors" | "none";
  p10: string | null;
  p50: string | null;
  p90: string | null;
  requested: string | null;
  /** Days from the requested date to the expected arrival (negative = before). */
  lateDays: number | null;
}

/** Expected arrival of an open item in buyer words (dates, no levels). */
export function arrivalSentence(a: ArrivalTextInput): string {
  if (a.basis === "none" || !a.p50 || !a.p10 || !a.p90)
    return "No arrival estimate: this item has been open longer than almost all comparable deliveries.";
  let text = `Expected around ${dayText(a.p50)}, likely between ${dayText(a.p10)} and ${dayText(a.p90)}`;
  if (a.requested && a.lateDays !== null)
    text +=
      a.lateDays > 0
        ? `, ${days(a.lateDays)} after the requested date`
        : ", in time for the requested date";
  text += ".";
  if (a.basis === "survivors")
    text += " Based on past deliveries that took at least this long.";
  return text;
}

/** "About 7 in 10" (whole tenths, never 0 or 10: an estimate is not a certainty). */
export function chanceWords(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "";
  return `About ${Math.min(9, Math.max(1, Math.round(p * 10)))} in 10`;
}

/** The chance of arriving after the requested date, with its caveat. */
export function chanceSentence(p: number | null): string {
  const w = chanceWords(p);
  return w
    ? `${w} comparable deliveries still open at this point arrived after the requested date. A rough estimate, not a promise.`
    : "";
}

export interface ExpertInput {
  source: AtRiskSource;
  pLate: number | null;
  gap: number;
  plannedDays: number | null;
  flag: PdtFlag | null;
  riskRank: number;
  ruleVerdict: RuleVerdict | null;
  nOwn: number;
  contextLevel: string | null;
  gridRef: string;
  contextRows?: number;
}

export function expertJson(e: ExpertInput): string {
  return JSON.stringify({
    source: e.source,
    p_late: e.pLate === null ? null : Math.round(e.pLate * 1000) / 1000,
    label: e.source === "rule" ? RULE_LABEL : NOT_CALIBRATED,
    gap: e.gap,
    plannedDays: e.plannedDays,
    plannedFlag: e.flag,
    riskRank: e.riskRank,
    ruleVerdict: e.ruleVerdict,
    grid: e.gridRef,
    nOwn: e.nOwn,
    contextLevel: e.contextLevel,
    ...(e.contextRows !== undefined ? { contextRows: e.contextRows } : {}),
  });
}
