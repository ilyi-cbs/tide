// Pure domain of the rule lists (P-13): no CDS, no I/O, "today" is the asOf parameter.
import { addDays } from "../../kernel/calendar";
import { PRICE_BAND, PRICE_FACTORS, PRICE_MIN_PRIOR, PRICE_WINDOW_DAYS } from "./constants";
import { fmtNumber, median } from "./texts";

// ---------------------------------------------------------------- price

export interface PriceRow {
  PurchaseOrder: string;
  PurchaseOrderItem: string;
  PurchaseOrderDate: string;
  Material: string;
  MaterialGroup?: string | null;
  MaterialType?: string | null;
  Plant: string;
  OrderQuantity?: number | null;
  Supplier?: string | null;
  PurchasingOrganization?: string | null;
  Currency: string;
  OrderUnit?: string | null;
  NetPriceAmount: number | null;
  NetPriceQuantity: number | null;
}

export interface PriceHistoryPoint {
  PurchaseOrder: string;
  PurchaseOrderItem: string;
  PurchaseOrderDate: string;
  unitPrice: number;
}

export interface PriceSlip<T extends PriceRow = PriceRow> {
  row: T;
  unitPrice: number;
  priorMedian: number;
  nPrior: number;
  ratio: number;
  factor: number;
  direction: "higher" | "lower";
  issue: string;
  issueTechnical: string;
  /** Earlier prices of the key (oldest first), for the detail page. */
  history: PriceHistoryPoint[];
}

const unitPrice = (row: PriceRow): number | null => {
  const amount = Number(row.NetPriceAmount);
  const quantity = Number(row.NetPriceQuantity);
  return amount > 0 && quantity > 0 ? amount / quantity : null;
};

/** The factor (10, 100, 1,000) the ratio or its inverse lies within ± band of, else null. */
export function factorMatch(ratio: number, band = PRICE_BAND): number | null {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return null;
  const big = Math.max(ratio, 1 / ratio);
  const eps = 1e-9;
  for (const f of PRICE_FACTORS) if (big >= f * (1 - band) - eps && big <= f * (1 + band) + eps) return f;
  return null;
}

export const priceKey = (r: Pick<PriceRow, "Material" | "Plant" | "Currency" | "OrderUnit">) =>
  `${r.Material}|${r.Plant}|${r.Currency}|${r.OrderUnit ?? ""}`;

/**
 * Items ordered in the `windowDays` before `asOf` (PO date < asOf) whose unit
 * price is a factor slip against the running median of all earlier prices of
 * the same material, plant and currency (PO date, PO, item order).
 */
export function priceSlips<T extends PriceRow>(rows: T[], asOf: string, windowDays = PRICE_WINDOW_DAYS): PriceSlip<T>[] {
  const start = addDays(asOf, -windowDays);
  const valid = rows.filter(
    (r) =>
      r.Material &&
      r.PurchaseOrderDate < asOf &&
      (r.NetPriceAmount ?? 0) > 0 &&
      (r.NetPriceQuantity ?? 0) > 0,
  );
  const inWindow = new Set(valid.filter((r) => r.PurchaseOrderDate >= start).map(priceKey));
  const byKey = new Map<string, T[]>();
  for (const r of valid) {
    const k = priceKey(r);
    if (!inWindow.has(k)) continue;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r);
  }
  const out: PriceSlip<T>[] = [];
  for (const group of byKey.values()) {
    group.sort(
      (a, b) =>
        a.PurchaseOrderDate.localeCompare(b.PurchaseOrderDate) ||
        a.PurchaseOrder.localeCompare(b.PurchaseOrder) ||
        a.PurchaseOrderItem.localeCompare(b.PurchaseOrderItem),
    );
    const history: PriceHistoryPoint[] = [];
    for (const r of group) {
      const unitPrice = r.NetPriceAmount! / r.NetPriceQuantity!;
      if (r.PurchaseOrderDate >= start && history.length >= PRICE_MIN_PRIOR) {
        const priorMedian = median(history.map((h) => h.unitPrice));
        const ratio = unitPrice / priorMedian;
        const factor = factorMatch(ratio);
        if (factor) {
          const direction = ratio > 1 ? "higher" : "lower";
          out.push({
            row: r,
            unitPrice,
            priorMedian,
            nPrior: history.length,
            ratio,
            factor,
            direction,
            issue: `Net price about ${fmtNumber(factor)} times ${direction} than before`,
            issueTechnical:
              `unit price ${fmtNumber(unitPrice)} against a median of ${fmtNumber(priorMedian)} ${r.Currency} ` +
              `over ${history.length} earlier orders (ratio ${fmtNumber(ratio)})`,
            history: [...history],
          });
        }
      }
      history.push({
        PurchaseOrder: r.PurchaseOrder,
        PurchaseOrderItem: r.PurchaseOrderItem,
        PurchaseOrderDate: r.PurchaseOrderDate,
        unitPrice,
      });
    }
  }
  return out.sort(
    (a, b) =>
      b.row.PurchaseOrderDate.localeCompare(a.row.PurchaseOrderDate) ||
      a.row.PurchaseOrder.localeCompare(b.row.PurchaseOrder) ||
      a.row.PurchaseOrderItem.localeCompare(b.row.PurchaseOrderItem),
  );
}

/** Realistic recent deviations backed by a deep comparable-price history. */
export function empiricalPriceDeviations<T extends PriceRow>(rows: T[], asOf: string): PriceSlip<T>[] {
  const start = addDays(asOf, -PRICE_WINDOW_DAYS);
  const valid = rows
    .filter((row) => row.Material && row.PurchaseOrderDate < asOf && unitPrice(row) !== null)
    .sort(
      (a, b) =>
        a.PurchaseOrderDate.localeCompare(b.PurchaseOrderDate) ||
        a.PurchaseOrder.localeCompare(b.PurchaseOrder) ||
        a.PurchaseOrderItem.localeCompare(b.PurchaseOrderItem),
    );
  const history = new Map<string, PriceHistoryPoint[]>();
  const out: PriceSlip<T>[] = [];
  for (const row of valid) {
    const key = priceKey(row);
    const prior = history.get(key) ?? [];
    const actual = unitPrice(row)!;
    if (row.PurchaseOrderDate >= start && prior.length >= 20) {
      const priorMedian = median(prior.map((entry) => entry.unitPrice));
      const ratio = actual / priorMedian;
      const magnitude = Math.max(ratio, 1 / ratio);
      if (magnitude >= 1.4 && magnitude <= 2.5) {
        const direction = ratio > 1 ? "higher" : "lower";
        out.push({
          row,
          unitPrice: actual,
          priorMedian,
          nPrior: prior.length,
          ratio,
          factor: magnitude,
          direction,
          issue: `Net price materially ${direction} than comparable history`,
          issueTechnical:
            `unit price ${fmtNumber(actual)} against a median of ${fmtNumber(priorMedian)} ${row.Currency} ` +
            `over ${prior.length} earlier orders (ratio ${fmtNumber(ratio)})`,
          history: [...prior],
        });
      }
    }
    prior.push({
      PurchaseOrder: row.PurchaseOrder,
      PurchaseOrderItem: row.PurchaseOrderItem,
      PurchaseOrderDate: row.PurchaseOrderDate,
      unitPrice: actual,
    });
    history.set(key, prior);
  }
  return out.sort(
    (a, b) =>
      Math.abs(1 - b.ratio) - Math.abs(1 - a.ratio) ||
      b.row.PurchaseOrderDate.localeCompare(a.row.PurchaseOrderDate),
  );
}
