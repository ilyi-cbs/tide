// Delivery outlook of an at_risk / overdue finding (object page): the date
// axis (ordered, requested, today, needed, arrival ranges) and the options to
// act, with the recommended one first. Pure: no CDS, no I/O; "today" is a
// parameter (NS-B2). The UI only draws and calls what is returned (NS-I2).
import { addDays, dayText as day, daysBetween } from "../../kernel/calendar";
import type { ImpactLevel } from "../../kernel/types";

export type DeliveryList = "at_risk" | "overdue";
export const DELIVERY_LISTS: readonly DeliveryList[] = ["at_risk", "overdue"];

export interface Marker {
  kind: "ordered" | "requested" | "confirmed" | "today" | "needed" | "shortage";
  date: string;
  label: string;
}

export interface Band {
  kind: "estimate" | "own";
  from: string;
  mid: string;
  cautious: string | null;
  to: string;
  label: string;
}

export type Operation =
  | "addToApprovals"
  | "openAction"
  | "confirm"
  | "openFinding"
  | "checkReceipt"
  | "simulate"
  | null;

export interface Option {
  kind:
    | "remind"
    | "openAction"
    | "confirm"
    | "fixPlannedTime"
    | "checkReceipt"
    | "watch"
    | "simulate";
  title: string;
  reason: string;
  effect: string;
  operation: Operation;
  target: string | null;
  recommended: boolean;
}

export interface OutlookInput {
  aiOnly?: boolean;
  asOf: string;
  list: DeliveryList;
  status: "open" | "closed";
  nextActionKind: string | null;
  poDate: string | null;
  requested: string | null;
  plannedDays: number | null;
  grid: {
    p10: string | null;
    p50: string | null;
    p80: string | null;
    p90: string | null;
    basis: string | null;
    source?: string | null;
    sourceText: string;
    chanceLate?: number | null;
    ownP10: string | null;
    ownP50: string | null;
    ownP90: string | null;
    nOwn: number;
    agreement: string | null;
  } | null;
  impact: {
    level: ImpactLevel | null;
    levelText: string;
    needDate: string | null;
    shortageFrom: string | null;
  } | null;
  action: { ID: string; status: string; since: string | null } | null;
  confirmedDate: string | null;
  rootCause: { ID: string; issue: string } | null;
  siblingReceived: string | null;
  canSimulate: boolean;
}

export interface Outlook {
  asOf: string;
  requiredDate: string | null;
  earliestCredibleDate: string | null;
  mostLikelyDate: string | null;
  lateRiskDate: string | null;
  daysAfterRequired: number | null;
  evidenceSource: string;
  comparableDeliveries: number;
  calculatedAt: string;
  headline: string;
  situation: string;
  estimateSource: string;
  /** Machine-readable origin; UI decisions must not infer it from estimateSource. */
  forecastKind:
    "tabpfn" | "empirical" | "confirmation" | "sap_planned" | "none";
  plannedDays: number | null;
  hasAiPrediction: boolean;
  onTimeProbability: number | null;
  requestedDateMissed: boolean;
  scenarios: Array<{ level: number; arrivalDate: string }>;
  markers: Marker[];
  bands: Band[];
  agreementText: string;
  options: Option[];
}

const days = (n: number) => `${n} ${Math.abs(n) === 1 ? "day" : "days"}`;
const SEVERE: ReadonlySet<string> = new Set([
  "customer_order_late",
  "production_affected",
  "stock_uncovered",
]);
const CALM: ReadonlySet<string> = new Set(["covered_by_stock", "no_impact"]);

/** "Overdue by 41 days" / "Due in 6 days" / "Due today". */
export function headline(
  list: DeliveryList,
  requested: string | null,
  asOf: string,
): string {
  if (!requested) return "";
  const d = daysBetween(asOf, requested);
  if (d < 0) return `Overdue by ${days(-d)}`;
  if (list === "overdue") return "Overdue";
  return d === 0 ? "Due today" : `Due in ${days(d)}`;
}

export function markers(i: OutlookInput): Marker[] {
  const out: Marker[] = [];
  if (i.poDate) out.push({ kind: "ordered", date: i.poDate, label: "Ordered" });
  if (i.requested)
    out.push({
      kind: "requested",
      date: i.requested,
      label: "Requested on PO",
    });
  out.push({ kind: "today", date: i.asOf, label: "Today" });
  if (i.confirmedDate)
    out.push({
      kind: "confirmed",
      date: i.confirmedDate,
      label: "Supplier confirmed",
    });
  const need = i.impact?.needDate;
  if (need && need !== i.requested)
    out.push({ kind: "needed", date: need, label: "Needed" });
  const short = i.impact?.shortageFrom;
  if (short && short !== need)
    out.push({ kind: "shortage", date: short, label: "Stock runs short" });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function bands(i: OutlookInput): Band[] {
  const g = i.grid;
  if (!g) return [];
  const out: Band[] = [];
  // A supplier confirmation is a commitment, not a forecast interval.
  if (!i.confirmedDate && g.p10 && g.p50 && g.p90)
    out.push({
      kind: "estimate",
      from: g.p10,
      mid: g.p50,
      cautious: g.p80,
      to: g.p90,
      label:
        g.basis === "survivors"
          ? "Historical arrival window"
          : g.source === "tabpfn"
            ? "80% predicted arrival window"
            : "Historical arrival window",
    });
  if (!i.confirmedDate && g.ownP10 && g.ownP50 && g.ownP90)
    out.push({
      kind: "own",
      from: g.ownP10,
      mid: g.ownP50,
      cautious: null,
      to: g.ownP90,
      label: `Your last ${g.nOwn} deliveries`,
    });
  return out;
}

/** Only TabPFN supplies the buyer-facing 50/80/90 arrival scenarios. */
export function scenarios(
  i: OutlookInput,
): Array<{ level: number; arrivalDate: string }> {
  if (i.confirmedDate || i.grid?.source !== "tabpfn") return [];
  return [
    { level: 10, arrivalDate: i.grid.p10 },
    { level: 50, arrivalDate: i.grid.p50 },
    { level: 80, arrivalDate: i.grid.p80 },
    { level: 90, arrivalDate: i.grid.p90 },
  ].filter(
    (scenario): scenario is { level: number; arrivalDate: string } =>
      !!scenario.arrivalDate,
  );
}

/** Explicit origin for presentation; sourceText is display-only and never controls AI branding. */
export function forecastKind(i: OutlookInput): Outlook["forecastKind"] {
  if (i.confirmedDate) return "confirmation";
  if (i.grid?.source === "tabpfn") return "tabpfn";
  if (i.aiOnly) return "none";
  if (i.grid?.p50) return "empirical";
  if (i.poDate && i.plannedDays !== null) return "sap_planned";
  return "none";
}

export function agreementText(i: OutlookInput): string {
  if (i.confirmedDate) return "";
  const g = i.grid;
  if (!g || !g.ownP50) return "";
  if (g.agreement === "aligned")
    return `Your own ${g.nOwn} deliveries agree with the estimate.`;
  if (g.agreement === "divergent")
    return `Your own ${g.nOwn} deliveries point to ${day(g.ownP50)} — worth a second look.`;
  return "";
}

/** Options for the buyer, recommended first (at most one recommended). */
export function options(i: OutlookInput): Option[] {
  const open = i.status === "open";
  const level = i.impact?.level ?? null;
  const severe = !!level && SEVERE.has(level);
  const calm = !!level && CALM.has(level);
  const overdue = i.list === "overdue";
  const pending =
    i.action &&
    (i.action.status === "needs_decision" || i.action.status === "waiting")
      ? i.action
      : null;
  const canRemind = open && !!i.nextActionKind && !pending;
  const need = i.impact?.needDate ?? null;
  const out: Option[] = [];

  if (pending?.status === "waiting")
    out.push({
      kind: "confirm",
      title: "Record supplier confirmation",
      reason: `A delivery reminder was sent${pending.since ? ` on ${day(pending.since)}` : ""}; record the date confirmed by the supplier.`,
      effect: "The forecast and impact assessment will use the confirmed date.",
      operation: "confirm",
      target: null,
      recommended: false,
    });
  if (pending?.status === "needs_decision")
    out.push({
      kind: "openAction",
      title: "Review prepared delivery reminder",
      reason: "A delivery reminder for this item is awaiting your approval.",
      effect: "Opens the prepared reminder for review and decision.",
      operation: "openAction",
      target: pending.ID,
      recommended: false,
    });
  if (canRemind) {
    const title = severe
      ? overdue
        ? "Request an expedited delivery commitment"
        : "Request an earlier delivery commitment"
      : overdue
        ? "Request a confirmed delivery date"
        : "Request delivery date confirmation";
    const reason = severe
      ? `${i.impact!.levelText}${need ? `: needed by ${day(need)}` : ""}.`
      : overdue
        ? "The requested delivery date has passed and no receipt has been recorded."
        : "The forecast indicates that delivery is likely after the requested date.";
    out.push({
      kind: "remind",
      title,
      reason,
      effect:
        "Prepares a delivery reminder for approval; nothing is sent automatically.",
      operation: "addToApprovals",
      target: null,
      recommended: false,
    });
  }
  if (open && calm)
    out.push({
      kind: "watch",
      title: "Monitor delivery status",
      reason:
        level === "covered_by_stock"
          ? "Available stock covers the expected delay."
          : "No demand is affected by the expected delay.",
      effect:
        "No action is required at this time; the item remains monitored until receipt.",
      operation: null,
      target: null,
      recommended: false,
    });
  if (open && !pending && !i.confirmedDate)
    out.push({
      kind: "confirm",
      title: "Record supplier confirmation",
      reason:
        "Use this when the supplier has already confirmed a delivery date by phone or email.",
      effect: "The forecast and impact assessment will use the confirmed date.",
      operation: "confirm",
      target: null,
      recommended: false,
    });
  if (overdue && i.siblingReceived)
    out.push({
      kind: "checkReceipt",
      title: "Verify goods receipt status",
      reason: `Other items on this purchase order were received on ${day(i.siblingReceived)}; this delivery may be awaiting goods-receipt posting.`,
      effect: "Verify the receipt with Goods Receiving; no action is prepared.",
      operation: "checkReceipt",
      target: null,
      recommended: false,
    });
  if (i.rootCause)
    out.push({
      kind: "fixPlannedTime",
      title: "Review planned delivery time",
      reason:
        i.rootCause.issue ||
        "The planned delivery time does not reflect observed supplier lead times.",
      effect:
        "Opens the planned delivery time finding to improve planning for future orders.",
      operation: "openFinding",
      target: i.rootCause.ID,
      recommended: false,
    });
  if (i.canSimulate)
    out.push({
      kind: "simulate",
      title: "Plan replenishment using the delivery forecast",
      reason:
        "Review the recommended order timing to protect the next delivery date.",
      effect: "Opens replenishment planning for this material.",
      operation: "simulate",
      target: null,
      recommended: false,
    });
  const pick = recommendedKind(out, {
    severe,
    calm,
    overdue,
    waiting: pending?.status === "waiting",
  });
  const k = out.findIndex((o) => o.kind === pick);
  if (k >= 0) {
    const [r] = out.splice(k, 1);
    out.unshift({ ...r, recommended: true });
  }
  return out;
}

function recommendedKind(
  opts: Option[],
  f: { severe: boolean; calm: boolean; overdue: boolean; waiting: boolean },
): Option["kind"] | null {
  const has = (k: Option["kind"]) => opts.some((o) => o.kind === k);
  if (has("openAction")) return "openAction";
  if (f.waiting) return "confirm";
  if (has("remind") && (f.severe || f.overdue || !f.calm)) return "remind";
  if (has("watch")) return "watch";
  if (has("remind")) return "remind";
  return null;
}

export function outlook(i: OutlookInput): Outlook {
  if (i.aiOnly && i.grid?.source !== "tabpfn") i = { ...i, grid: null };
  const typical = i.grid?.p50;
  const plannedDate =
    !i.aiOnly &&
    !i.confirmedDate &&
    !typical &&
    i.poDate &&
    i.plannedDays !== null
      ? [i.asOf, addDays(i.poDate, Math.ceil(i.plannedDays))].sort().at(-1)!
      : null;
  const forecastDate = typical ?? plannedDate;
  const earliest = i.confirmedDate ?? (typical ? (i.grid?.p10 ?? null) : null);
  const latest = i.confirmedDate ?? (typical ? (i.grid?.p90 ?? null) : null);
  const mostLikely = i.confirmedDate ?? forecastDate;
  const daysAfterRequired =
    i.requested && mostLikely
      ? Math.max(0, daysBetween(i.requested, mostLikely))
      : null;
  const estimated = !i.confirmedDate && !!forecastDate;
  const plannedFallback = !i.confirmedDate && !typical && !!plannedDate;
  const situation = i.confirmedDate
    ? `Supplier confirmed ${day(i.confirmedDate)}${i.requested && i.confirmedDate > i.requested ? `, after the requested date (${day(i.requested)})` : ""}.`
    : estimated
      ? `${plannedFallback ? "SAP's planned delivery time points to" : "Expected around"} ${day(forecastDate!)}${i.requested && forecastDate! > i.requested ? `, after the requested date (${day(i.requested)})` : ""}.`
      : "No reliable arrival estimate is available for this open item.";
  const predictionScenarios = scenarios(i);
  const sourceKind = forecastKind(i);
  const requestedDateMissed = !!i.requested && i.requested < i.asOf;
  const chanceLate = i.grid?.chanceLate;
  const onTimeProbability =
    sourceKind === "tabpfn" &&
    !!i.requested &&
    !requestedDateMissed &&
    typeof chanceLate === "number" &&
    Number.isFinite(chanceLate) &&
    chanceLate >= 0 &&
    chanceLate <= 1
      ? Math.round((1 - chanceLate) * 10000) / 10000
      : null;
  return {
    asOf: i.asOf,
    requiredDate: i.requested,
    earliestCredibleDate: earliest,
    mostLikelyDate: mostLikely,
    lateRiskDate: latest,
    daysAfterRequired,
    evidenceSource: i.confirmedDate
      ? "Supplier confirmation"
      : plannedFallback
        ? "SAP planned delivery time"
        : (i.grid?.sourceText ?? "No reliable estimate"),
    comparableDeliveries: i.grid?.nOwn ?? 0,
    calculatedAt: i.asOf,
    headline: headline(i.list, i.requested, i.asOf),
    situation,
    estimateSource: i.confirmedDate
      ? "Supplier confirmation"
      : estimated
        ? plannedFallback
          ? "SAP planned delivery time"
          : sourceKind === "tabpfn"
            ? "AI forecast (TabPFN)"
            : i.grid!.basis === "survivors"
              ? "Past deliveries still open this long"
              : i.grid!.sourceText
        : "No reliable estimate",
    forecastKind: sourceKind,
    plannedDays: i.plannedDays,
    hasAiPrediction: predictionScenarios.length > 0,
    onTimeProbability,
    requestedDateMissed,
    scenarios: predictionScenarios,
    markers: markers(i),
    bands: bands(i),
    agreementText: agreementText(i),
    options: options(i),
  };
}
