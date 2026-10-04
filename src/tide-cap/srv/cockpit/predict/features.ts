// P-8 features known at PO creation and labels known at a reference date (pure).
import { Item, PREDICT_FEATURES, Request, days } from "./types";

export function supplierRegion(country: string | null | undefined): string {
  const c = String(country ?? "")
    .trim()
    .toUpperCase();
  if (["DE", "AT"].includes(c)) return "domestic";
  if (["PL", "CZ", "IT", "NL", "FR", "HU"].includes(c)) return "eu";
  if (["CN", "US", "IN", "TW"].includes(c)) return "overseas";
  return "unknown";
}

/** Planned delivery time status (rule words, as the planned-time check). */
export function plannedStatus(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v) || v === 0)
    return "not maintained";
  if (v === 2) return "default";
  if ([180, 360, 999].includes(v) || v >= 180) return "placeholder";
  return "maintained";
}

const KEY = (i: Pick<Item, "Material" | "Supplier" | "Plant">) =>
  `${i.Material}|${i.Supplier}|${i.Plant}`;

/** Receipts of the same material, supplier and plant before each item's PO date. */
export function ownPastDeliveries(items: Item[]): Map<string, number> {
  const byKey = new Map<string, string[]>();
  for (const i of items)
    if (i.AvailableDate)
      (byKey.get(KEY(i)) ?? byKey.set(KEY(i), []).get(KEY(i))!).push(
        i.AvailableDate,
      );
  for (const list of byKey.values()) list.sort();
  const out = new Map<string, number>();
  for (const i of items) {
    const list = byKey.get(KEY(i)) ?? [];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < i.PurchaseOrderDate) lo = mid + 1;
      else hi = mid;
    }
    out.set(i.id, lo);
  }
  return out;
}

export type FeatureRow = Record<
  (typeof PREDICT_FEATURES)[number],
  string | number | null
>;

export function features(
  i: Item,
  past: number,
  override: Partial<Item> = {},
): FeatureRow {
  const x = { ...i, ...override };
  return {
    Plant: x.Plant,
    PurchasingGroup: x.PurchasingGroup,
    Supplier: x.Supplier,
    SupplierRegion: supplierRegion(x.SupplierCountry),
    MaterialType: x.MaterialType,
    MaterialGroup: x.MaterialGroup,
    PlannedDays: x.PlannedDays,
    PlannedStatus: plannedStatus(x.PlannedDays),
    RequestedGapDays: x.RequestedDate
      ? days(x.PurchaseOrderDate, x.RequestedDate)
      : null,
    OrderQuantity: x.OrderQuantity,
    NetAmount: x.NetAmountEUR,
    POMonth: String(Number(x.PurchaseOrderDate.slice(5, 7))),
    OwnPastDeliveries: past,
  };
}

// ------------------------------------------------------------------ labels

/** Outcome known at `ref`, else null. Only receipts before `ref` count. */
export function label(
  i: Item,
  req: Pick<Request, "target" | "lateDays">,
  ref: string,
): number | null {
  const received = !!i.AvailableDate && i.AvailableDate < ref;
  if (req.target === "late_by_days") {
    if (!i.RequestedDate) return null;
    const n = req.lateDays ?? 0;
    if (received) return days(i.RequestedDate, i.AvailableDate!) > n ? 1 : 0;
    return days(i.RequestedDate, ref) > n ? 1 : null;
  }
  if (!received) return null;
  if (req.target === "lead_time_days") {
    const lt = days(i.PurchaseOrderDate, i.AvailableDate!);
    return lt > 0 ? lt : null;
  }
  return i.PartialFirstReceipt === null || i.PartialFirstReceipt === undefined
    ? null
    : i.PartialFirstReceipt
      ? 1
      : 0;
}
