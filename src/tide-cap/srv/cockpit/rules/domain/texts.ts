// Pure domain of the rule lists (P-13): no CDS, no I/O, "today" is the asOf parameter.
import { OVERDUE_DAYS, PRICE_MIN_PRIOR } from "./constants";
import { median } from "../../kernel/stats";

export { median };

// dates

export const ms = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
export const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

export function addMonths(date: string, months: number): string {
  const d = new Date(ms(date));
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return iso(d.getTime());
}

// ---------------------------------------------------------------- numbers

export function fmtNumber(v: number): string {
  if (!Number.isFinite(v)) return "–";
  if (Math.abs(v) >= 100) return Math.round(v).toLocaleString("en-US");
  return String(Math.round(v * 100) / 100);
}

export const fmtAmount = (v: number | null | undefined, currency?: string | null) =>
  v == null ? "" : `${fmtNumber(v)}${currency ? ` ${currency}` : ""}`;

// ---------------------------------------------------------------- chain

export const NEXT_REMINDER = "Prepare a reminder";
export const NEXT_PRICE = "Add to the change list";
export const NEXT_WORKLIST = "Add to the worklist export";

const lower = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const sentence = (s: string) => (s.endsWith(".") ? s : `${s}.`);

/** Plain chain: "Checked this morning: <issue>. Next: <step>." */
export function plainChain(issue: string, nextStep: string, arrived = false): string {
  const when = arrived ? "Checked as it arrived" : "Checked this morning";
  return `${when}: ${sentence(issue)} Next: ${lower(nextStep)}.`;
}

/** Technical chain: Trigger → Check → Result → Next. */
export function technicalChain(check: string, result: string, nextStep: string, arrived = false): string {
  const trigger = arrived ? "arrived during the day" : "morning run at 06:00";
  return [trigger, check, result, lower(nextStep)].filter(Boolean).join(" → ");
}

export const CHECKS = {
  overdue: `requested date has passed and an open quantity remains (rule)`,
  price: `net price per unit against the median of at least ${PRICE_MIN_PRIOR} earlier prices of the material in the plant (rule)`,
  duplicate: "normalised descriptions compared within the material type, active materials (rule)",
  rare: "planning field pairs counted within plant and material type (rule)",
} as const;
