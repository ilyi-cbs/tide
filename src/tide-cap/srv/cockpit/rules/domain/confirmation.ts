// Pure domain of the rule lists (P-13): no CDS, no I/O, "today" is the asOf parameter.
import { fmtNumber } from "./texts";

// ---------------------------------------------------------------- confirmation entry

export interface ConfirmationTarget {
  exists: boolean;
  open: boolean;
  openQuantity: number | null;
  PurchaseOrderDate: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Why a confirmation cannot be recorded, in buyer words; null when it can. */
export function validateConfirmation(t: ConfirmationTarget, date: string | null | undefined, quantity: number | null | undefined): string | null {
  if (!t.exists) return "This purchase order item does not exist.";
  if (!t.open) return "This purchase order item is no longer open.";
  if (!date || !ISO_DATE.test(String(date).slice(0, 10))) return "Enter the confirmed delivery date.";
  if (quantity == null || !Number.isFinite(quantity) || quantity <= 0) return "Enter a confirmed quantity greater than 0.";
  if (t.openQuantity != null && quantity > t.openQuantity + 1e-9)
    return `The confirmed quantity is more than the open quantity (${fmtNumber(t.openQuantity)}).`;
  if (t.PurchaseOrderDate && String(date).slice(0, 10) < t.PurchaseOrderDate)
    return `The confirmed date is before the PO date (${t.PurchaseOrderDate}).`;
  return null;
}

/** The post-confirmation CSV row (P-15): PO, item, category AB, delivery date, quantity, received on. */
export function confirmationActionRow(po: string, item: string, date: string, quantity: number, receivedOn: string) {
  return {
    PurchaseOrder: po,
    PurchaseOrderItem: item,
    ConfirmationCategory: "AB",
    DeliveryDate: date,
    Quantity: quantity,
    ReceivedOn: receivedOn,
  };
}

// ---------------------------------------------------------------- SAP / feeder confirmations

export interface ParsedConfirmation {
  PurchaseOrder: string;
  PurchaseOrderItem: string;
  date: string;
  quantity: number | null;
  /** Creation date of the confirmation (P-0: known at asOf only when < asOf), null if unknown. */
  createdOn: string | null;
}

const stripZeros = (x: unknown) => String(x ?? "").replace(/^0+(?=\d)/, "");
const day10 = (x: unknown) => (x ? String(x).slice(0, 10) : null);

/**
 * Confirmation lines out of S/4 rows (CE_SUPPLIERCONFIRMATION_0001: header,
 * item with the PO reference, line with date and quantity; or flat rows that
 * carry all of it). Row sets are keyed by entity name; rows without a PO
 * reference or a date are skipped, as are items the supplier rejected.
 */
export function confirmationsFromRows(sets: Record<string, any[] | undefined>): ParsedConfirmation[] {
  const all = Object.values(sets).flatMap((rows) => rows ?? []);
  const poOf = (r: any) => r.SuplrConfRefPurchaseOrder ?? r.PurchaseOrder;
  const itemOf = (r: any) => r.SuplrConfRefPurchaseOrderItem ?? r.PurchaseOrderItem;
  const items = new Map<string, { po: string; item: string; rejected: boolean }>();
  const created = new Map<string, string | null>();
  for (const r of all) {
    if (r.SupplierConfirmation != null && r.CreationDate) created.set(String(r.SupplierConfirmation), day10(r.CreationDate));
    if (r.SupplierConfirmation != null && r.SupplierConfirmationItem != null && poOf(r) && itemOf(r) != null)
      items.set(`${r.SupplierConfirmation}|${stripZeros(r.SupplierConfirmationItem)}`, {
        po: String(poOf(r)),
        item: stripZeros(itemOf(r)),
        rejected: r.ItemIsRejectedBySupplier === true,
      });
  }
  const out: ParsedConfirmation[] = [];
  for (const r of all) {
    const date = day10(r.DeliveryDate ?? r.ConfirmedDeliveryDate ?? r.date);
    if (!date) continue;
    const ref =
      poOf(r) && itemOf(r) != null
        ? { po: String(poOf(r)), item: stripZeros(itemOf(r)), rejected: r.ItemIsRejectedBySupplier === true }
        : items.get(`${r.SupplierConfirmation}|${stripZeros(r.SupplierConfirmationItem)}`);
    if (!ref || ref.rejected) continue;
    const q = r.ConfirmedQuantity ?? r.quantity;
    out.push({
      PurchaseOrder: ref.po,
      PurchaseOrderItem: ref.item,
      date,
      quantity: q == null || q === "" ? null : Number(q),
      createdOn: day10(r.CreationDate) ?? (r.SupplierConfirmation != null ? (created.get(String(r.SupplierConfirmation)) ?? null) : null),
    });
  }
  return out.sort(
    (a, b) =>
      a.PurchaseOrder.localeCompare(b.PurchaseOrder) ||
      a.PurchaseOrderItem.localeCompare(b.PurchaseOrderItem, "en", { numeric: true }) ||
      (a.createdOn ?? "").localeCompare(b.createdOn ?? "") ||
      a.date.localeCompare(b.date),
  );
}
