// Planning (P-7): order timing and buffer from one lead-time distribution of
// a material, supplier and plant. Pure: no CDS, no I/O. Everything on the page
// is date arithmetic on the grid, so the slider moves on the client only.
//
// Lead time = calendar days from PO date to the first goods receipt. Daily
// demand = goods issues of the DEMAND_DAYS days before the as-of date / DEMAND_DAYS.
import { addDays, daysBetween } from "../../kernel/calendar";
import { median, round } from "../../kernel/stats";

export const GRID = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95];
export const SLIDER = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95];
export const DEFAULT_QUANTILE = 0.8;
export const EMPIRICAL_MIN = 20;
export const DEMAND_DAYS = 365;
export const PRICE_ORDERS = 3;
export const NEED_DATE_DAYS = 56;
export const GOODS_ISSUE_TYPES = ["201", "261", "601"];
export const NO_SOURCE_WARNING =
  "No info record and no past orders of this material with this supplier in this plant";
const OWN_LEVELS = new Set([
  "material + supplier within plant",
  "own history of material + supplier within plant",
  "material_supplier",
  "own",
]);

/** Input outside the master data; the service answers 400 before any model call. */
export class PlanningInputError extends Error {
  status = 400;
}

/** Simulation requires model output and never substitutes historical ranges. */
export class PlanningForecastError extends Error {
  status = 424;
}

export { addDays, daysBetween, round };

export const label = (q: number) => `p${Math.round(q * 100)}`;

// ---------------------------------------------------------------- validation

export interface ValidationFacts {
  plantKnown: boolean;
  materialKnown: boolean;
  materialInPlant: boolean;
  /** undefined when no supplier was entered */
  supplierKnown?: boolean;
  /** the entered supplier has a PO or an info record for the material in the plant */
  pairHasSource?: boolean;
}

/** Throws PlanningInputError for unknown input; returns warnings for known but unusual input. */
export function validate(
  f: ValidationFacts,
  input: { Material: string; Plant: string; Supplier?: string | null },
): string[] {
  if (!f.plantKnown) throw new PlanningInputError(`Unknown plant ${input.Plant}`);
  if (!f.materialKnown) throw new PlanningInputError(`Unknown material ${input.Material}`);
  if (!f.materialInPlant)
    throw new PlanningInputError(`Material ${input.Material} is not maintained in plant ${input.Plant}`);
  if (!input.Supplier) return [];
  if (!f.supplierKnown) throw new PlanningInputError(`Unknown supplier ${input.Supplier}`);
  return f.pairHasSource ? [] : [NO_SOURCE_WARNING];
}

// ---------------------------------------------------------------- defaults

export interface PoRow {
  PurchaseOrder: string;
  PurchaseOrderItem?: string;
  PurchaseOrderDate: string;
  Supplier: string;
  OrderQuantity?: number | null;
  PurchaseOrderQuantityUnit?: string | null;
  NetPriceAmount?: number | null;
  NetPriceQuantity?: number | null;
  DocumentCurrency?: string | null;
}

export interface InfoRecordRow {
  Supplier: string;
  PurchasingInfoRecord?: string | null;
  PurchasingDocumentDate?: string | null;
  MaterialPlannedDeliveryDurn?: number | null;
}

const cmp = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0;

/** Info records sorted oldest first (undated first), then by supplier. */
function byRecordDate(irs: InfoRecordRow[]): InfoRecordRow[] {
  return [...irs].sort(
    (a, b) => cmp(a.PurchasingDocumentDate, b.PurchasingDocumentDate) || cmp(a.Supplier, b.Supplier),
  );
}

/**
 * Most recent source of the material in the plant: supplier of the latest PO,
 * else of the latest info record (a source can exist before any PO).
 */
export function defaultSupplier(
  pos: PoRow[],
  irs: InfoRecordRow[],
): { supplier: string | null; from: "latest order" | "latest info record" | null } {
  const po = [...pos]
    .filter((p) => p.Supplier)
    .sort((a, b) => cmp(a.PurchaseOrderDate, b.PurchaseOrderDate) || cmp(a.PurchaseOrder, b.PurchaseOrder));
  if (po.length) return { supplier: po[po.length - 1].Supplier, from: "latest order" };
  const ir = byRecordDate(irs.filter((r) => r.Supplier));
  if (ir.length) return { supplier: ir[ir.length - 1].Supplier, from: "latest info record" };
  return { supplier: null, from: null };
}

/** The value SAP uses at PO creation: latest info record of the supplier if > 0, else material master. */
export function maintainedDays(
  irsOfSupplier: InfoRecordRow[],
  masterDays: number | null | undefined,
): {
  days: number | null;
  from: "info record" | "material master";
  since: string | null;
  infoRecord: string | null;
} {
  const ir = byRecordDate(irsOfSupplier);
  const info = ir.length ? ir[ir.length - 1].MaterialPlannedDeliveryDurn : null;
  if (info !== null && info !== undefined && info > 0) {
    return {
      days: Number(info),
      from: "info record",
      since: ir[ir.length - 1].PurchasingDocumentDate ?? null,
      infoRecord: ir[ir.length - 1].PurchasingInfoRecord ?? null,
    };
  }
  const m = masterDays === null || masterDays === undefined || Number.isNaN(masterDays) ? null : Number(masterDays);
  return { days: m, from: "material master", since: null, infoRecord: null };
}

/** Need date from a row: requirement date, else requested date, else as-of + 56 days. */
export function defaultNeedDate(
  requirementDate: string | null | undefined,
  requestedDate: string | null | undefined,
  asOf: string,
): string {
  return requirementDate || requestedDate || addDays(asOf, NEED_DATE_DAYS);
}

/** Order quantity for the range request: median of the material's PO quantities, else 1. */
export function orderQuantity(pos: PoRow[]): number {
  const q = pos.map((p) => Number(p.OrderQuantity)).filter((v) => Number.isFinite(v) && v > 0);
  return q.length ? median(q) : 1;
}

// ---------------------------------------------------------------- grid

/** Clipped at 0 and never decreasing along the grid. */
export function monotone(values: number[]): number[] {
  let prev = 0;
  return values.map((v) => {
    prev = Math.max(prev, Number.isFinite(v) ? v : prev, 0);
    return round(prev);
  });
}

/**
 * Picks GRID from the 19-level JSON of LeadTimeRange.levels
 * (`{"0.05": d, …, "0.95": d}`; keys may be written "0.1" or "0.10").
 * Missing levels are interpolated linearly between their neighbours.
 */
export function gridValues(levels: string | Record<string, number> | null | undefined): number[] | null {
  if (!levels) return null;
  const obj: Record<string, number> = typeof levels === "string" ? JSON.parse(levels) : levels;
  const pts = Object.entries(obj)
    .map(([k, v]) => [Number(k), Number(v)] as [number, number])
    .filter(([k, v]) => Number.isFinite(k) && Number.isFinite(v))
    .sort((a, b) => a[0] - b[0]);
  if (!pts.length) return null;
  const at = (q: number) => {
    const hit = pts.find(([k]) => Math.abs(k - q) < 1e-9);
    if (hit) return hit[1];
    if (q <= pts[0][0]) return pts[0][1];
    if (q >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
    const i = pts.findIndex(([k]) => k > q);
    const [k0, v0] = pts[i - 1];
    const [k1, v1] = pts[i];
    return v0 + ((v1 - v0) * (q - k0)) / (k1 - k0);
  };
  return monotone(GRID.map(at));
}

// ---------------------------------------------------------------- dates

export const latestOrderDate = (need: string, days: number) => addDays(need, -Math.ceil(days));
export const earliestDelivery = (asOf: string, days: number) => addDays(asOf, Math.ceil(days));

/**
 * SAP order date = need − maintained days; days too late against the latest
 * order date at the median (0 when SAP orders in time).
 */
export function sapView(
  need: string,
  planned: number | null,
  latestAtMedian: string,
): { sapOrderDate: string | null; sapLateDays: number | null } {
  if (planned === null) return { sapOrderDate: null, sapLateDays: null };
  const sapOrderDate = addDays(need, -Math.ceil(planned));
  return { sapOrderDate, sapLateDays: Math.max(daysBetween(latestAtMedian, sapOrderDate), 0) };
}

// ---------------------------------------------------------------- buffer

export const safetyDays = (values: number[], p50: number) => values.map((v) => round(Math.max(v - p50, 0)));

/** Own lead times at most each grid value: real counts. */
export function counts(history: number[], values: number[]): { of: number; within: number[] } {
  return { of: history.length, within: values.map((v) => history.filter((h) => h <= v).length) };
}

export interface IssueRow {
  PostingDate: string;
  GoodsMovementType: string;
  quantity: number;
  unit: string | null;
  cancelled?: boolean | null;
}

/** Goods issues (201/261/601) in the DEMAND_DAYS before the as-of date, per day, one unit only. */
export function dailyDemand(
  issues: IssueRow[],
  asOf: string,
): { daily: number | null; unit: string | null; issues: number; reason: string | null } {
  const start = addDays(asOf, -DEMAND_DAYS);
  const w = issues.filter(
    (i) =>
      GOODS_ISSUE_TYPES.includes(String(i.GoodsMovementType)) &&
      !i.cancelled &&
      i.PostingDate >= start &&
      i.PostingDate < asOf,
  );
  if (!w.length)
    return { daily: null, unit: null, issues: 0, reason: `No goods issues in the ${DEMAND_DAYS} days before ${asOf}` };
  const units = [...new Set(w.map((i) => i.unit ?? ""))];
  if (units.length > 1)
    return {
      daily: null,
      unit: null,
      issues: w.length,
      reason: `Goods issues in more than one unit (${units.join(", ")})`,
    };
  const total = w.reduce((s, i) => s + Math.abs(Number(i.quantity) || 0), 0);
  return { daily: round(total / DEMAND_DAYS, 4), unit: units[0] || null, issues: w.length, reason: null };
}

/**
 * Median of the last PRICE_ORDERS net prices per base unit (net price / price
 * unit) of POs in the issue unit, restricted to the latest currency.
 */
export function unitPrice(
  pos: PoRow[],
  unit: string | null,
): { unitPrice: number | null; currency: string | null; reason: string | null } {
  if (!unit) return { unitPrice: null, currency: null, reason: "No daily demand" };
  const same = pos
    .filter(
      (p) =>
        p.PurchaseOrderQuantityUnit === unit &&
        Number(p.NetPriceAmount) > 0 &&
        Number(p.NetPriceQuantity) > 0,
    )
    .sort(
      (a, b) =>
        cmp(a.PurchaseOrderDate, b.PurchaseOrderDate) ||
        cmp(a.PurchaseOrder, b.PurchaseOrder) ||
        cmp(a.PurchaseOrderItem, b.PurchaseOrderItem),
    );
  if (!same.length) return { unitPrice: null, currency: null, reason: `No order in the unit ${unit}` };
  const last = same.slice(-PRICE_ORDERS);
  const currency = last[last.length - 1].DocumentCurrency ?? null;
  const inCur = last.filter((p) => (p.DocumentCurrency ?? null) === currency);
  const per = inCur.map((p) => Number(p.NetPriceAmount) / Number(p.NetPriceQuantity));
  return { unitPrice: round(median(per), 4), currency, reason: null };
}

// ---------------------------------------------------------------- result

export interface RangeInput {
  source: string;
  n?: number | null;
  contextLevel?: string | null;
  contextRows?: number | null;
  levels?: string | null;
  ownLevels?: string | null;
  agreement?: string | null;
  modelRunID?: string | null;
  modelBackend?: string | null;
  modelTrainingRows?: number | null;
  modelFallback?: string | null;
}

export interface PlanRow {
  quantile: number;
  leadTimeDays: number;
  latestOrderDate: string;
  earliestDelivery: string;
  reachable: boolean;
  safetyDays: number;
  within: number | null;
  of: number | null;
  safetyStock: number | null;
  safetyStockValue: number | null;
}

export interface PlanResult {
  Material: string;
  Plant: string;
  Supplier: string | null;
  supplierFrom: string;
  needDate: string;
  asOf: string;
  source: string;
  n: number | null;
  plannedDays: number | null;
  plannedFrom: string;
  plannedSince: string | null;
  plannedInfoRecord: string | null;
  goodsReceiptDays: number | null;
  sapOrderDate: string | null;
  sapLateDays: number | null;
  warnings: string[];
  dailyDemand: number | null;
  unit: string | null;
  unitPrice: number | null;
  currency: string | null;
  priceP10: number | null;
  priceP50: number | null;
  priceP90: number | null;
  historicalPriceReference: number | null;
  historicalPriceCount: number | null;
  priceSource: string;
  priceReason: string | null;
  priceBackend: string | null;
  priceRunID: string | null;
  priceInputFingerprint: string | null;
  priceComputedAt: string | null;
  priceTrainingRows: number | null;
  priceContextScope: string | null;
  assumedPriceQuantity: number | null;
  assumedPriceUnit: string | null;
  assumedPriceCurrency: string | null;
  ownLevels: string | null;
  rangeAgreement: string | null;
  modelRunID: string | null;
  modelBackend: string | null;
  modelTrainingRows: number | null;
  modelFallback: string | null;
  rows: PlanRow[];
  /** false when even the fastest scenario (50% chance) can no longer meet the need date. */
  feasible: boolean;
  /** Earliest date the material can arrive if ordered today, at the default (80%) confidence. */
  earliestAchievableDate: string | null;
  masterData: MasterDataVerdict | null;
}

export function contextWarning(r: RangeInput): string | null {
  if (r.source !== "tabpfn" || !r.contextLevel || OWN_LEVELS.has(r.contextLevel)) return null;
  return `No own history for this supplier; AI estimate from similar deliveries (${r.contextLevel}, n = ${r.contextRows ?? 0})`;
}

/**
 * Verdict comparing SAP's planned delivery time with the actual (typical =
 * median, and 80%) delivery times from the range. Null when either figure is
 * missing. `direction` drives the wording on the page (SAP too short/too
 * long/plausible).
 */
export interface MasterDataVerdict {
  direction: "too_short" | "too_long" | "plausible";
  plannedDays: number;
  typicalDays: number;
  p80Days: number;
  gapDays: number;
}

export function masterDataVerdict(plannedDays: number | null, values: number[] | null): MasterDataVerdict | null {
  if (plannedDays === null || !values?.length) return null;
  const i50 = GRID.indexOf(0.5);
  const i80 = GRID.indexOf(0.8);
  const typicalDays = values[i50];
  const p80Days = values[i80];
  const gapDays = round(plannedDays - typicalDays);
  const TOLERANCE = 2; // days either side of typical count as plausible
  const direction = gapDays < -TOLERANCE ? "too_short" : gapDays > TOLERANCE ? "too_long" : "plausible";
  return { direction, plannedDays, typicalDays, p80Days, gapDays: Math.abs(gapDays) };
}

export interface PlanInput {
  Material: string;
  Plant: string;
  Supplier: string | null;
  supplierFrom: string;
  needDate: string;
  asOf: string;
  warnings: string[];
  maintained: { days: number | null; from: string; since?: string | null; infoRecord?: string | null };
  goodsReceiptDays?: number | null;
  range: RangeInput | null;
  /** own lead times (> 0 days) of the source before the as-of date */
  history: number[];
  demand: { daily: number | null; unit: string | null; reason?: string | null };
  price: {
    /** Legacy callers may provide a single historical valuation price. */
    unitPrice?: number | null; currency?: string | null;
    p10?: number | null; p50?: number | null; p90?: number | null;
    historicalReference?: number | null; historicalCount?: number | null;
    source?: string; reason?: string | null; backend?: string | null; runID?: string | null;
    inputFingerprint?: string | null; computedAt?: string | null; trainingRows?: number | null;
    contextScope?: string | null; assumedQuantity?: number | null; assumedUnit?: string | null;
    assumedCurrency?: string | null;
  };
}

/** The whole page on the grid: one row per quantile. */
export function buildPlan(p: PlanInput): PlanResult {
  const warnings = [...p.warnings];
  const base: PlanResult = {
    Material: p.Material,
    Plant: p.Plant,
    Supplier: p.Supplier,
    supplierFrom: p.supplierFrom,
    needDate: p.needDate,
    asOf: p.asOf,
    source: p.range?.source ?? "none",
    n: null,
    plannedDays: p.maintained.days,
    plannedFrom: p.maintained.from,
    plannedSince: p.maintained.since ?? null,
    plannedInfoRecord: p.maintained.infoRecord ?? null,
    goodsReceiptDays: p.goodsReceiptDays ?? null,
    sapOrderDate: null,
    sapLateDays: null,
    warnings,
    dailyDemand: p.demand.daily,
    unit: p.demand.unit,
    unitPrice: p.price.p50 ?? p.price.historicalReference ?? p.price.unitPrice ?? null,
    currency: p.price.assumedCurrency ?? p.price.currency ?? null,
    priceP10: p.price.p10 ?? null,
    priceP50: p.price.p50 ?? null,
    priceP90: p.price.p90 ?? null,
    historicalPriceReference: p.price.historicalReference ?? null,
    historicalPriceCount: p.price.historicalCount ?? null,
    priceSource: p.price.source ?? "unavailable",
    priceReason: p.price.reason ?? null,
    priceBackend: p.price.backend ?? null,
    priceRunID: p.price.runID ?? null,
    priceInputFingerprint: p.price.inputFingerprint ?? null,
    priceComputedAt: p.price.computedAt ?? null,
    priceTrainingRows: p.price.trainingRows ?? null,
    priceContextScope: p.price.contextScope ?? null,
    assumedPriceQuantity: p.price.assumedQuantity ?? null,
    assumedPriceUnit: p.price.assumedUnit ?? null,
    assumedPriceCurrency: p.price.assumedCurrency ?? null,
    ownLevels: p.range?.ownLevels ?? null,
    rangeAgreement: p.range?.agreement ?? null,
    modelRunID: p.range?.modelRunID ?? null,
    modelBackend: p.range?.modelBackend ?? null,
    modelTrainingRows: p.range?.modelTrainingRows ?? null,
    modelFallback: p.range?.modelFallback ?? null,
    rows: [],
    feasible: true,
    earliestAchievableDate: null,
    masterData: null,
  };
  const values = gridValues(p.range?.levels);
  if (!p.range || !values) {
    warnings.push("No lead-time range for this source");
    if (p.maintained.days !== null)
      base.sapOrderDate = addDays(p.needDate, -Math.ceil(p.maintained.days));
    return base;
  }
  const own = p.range.source === "empirical" && p.history.length >= EMPIRICAL_MIN;
  const c = own ? counts(p.history, values) : null;
  const i50 = GRID.indexOf(0.5);
  const i80 = GRID.indexOf(0.8);
  const latest = values.map((v) => latestOrderDate(p.needDate, v));
  const safety = safetyDays(values, values[i50]);
  const sap = sapView(p.needDate, p.maintained.days, latest[i50]);
  const coarse = contextWarning(p.range);
  if (coarse) warnings.push(coarse);
  // Feasible if even the fastest (50%) scenario can still meet the need date;
  // "earliest achievable" is what an order placed today could still deliver,
  // at the default 80% confidence.
  const feasible = latest[i50] >= p.asOf;
  const earliestAchievableDate = earliestDelivery(p.asOf, values[i80]);
  return {
    ...base,
    n: c ? c.of : p.range.source === "tabpfn" ? (p.range.contextRows ?? p.range.n ?? null) : (p.range.n ?? p.range.contextRows ?? null),
    ...sap,
    feasible,
    earliestAchievableDate,
    masterData: masterDataVerdict(p.maintained.days, values),
    rows: GRID.map((q, i) => {
      const stock = p.demand.daily === null ? null : round(p.demand.daily * safety[i]);
      return {
        quantile: q,
        leadTimeDays: values[i],
        latestOrderDate: latest[i],
        earliestDelivery: earliestDelivery(p.asOf, values[i]),
        reachable: latest[i] >= p.asOf,
        safetyDays: safety[i],
        within: c ? c.within[i] : null,
        of: c ? c.of : null,
        safetyStock: stock,
        safetyStockValue: stock === null || base.unitPrice === null || (base.assumedPriceUnit !== null && p.demand.unit !== base.assumedPriceUnit) ? null : round(stock * base.unitPrice),
      };
    }),
  };
}
