// Pure domain of the rule lists (P-13): no CDS, no I/O, "today" is the asOf parameter.
import { addDays, daysBetween } from "../../kernel/calendar";
import { OVERDUE_DAYS } from "./constants";
import { fmtAmount } from "./texts";

// ---------------------------------------------------------------- overdue

export interface OpenItemRow {
  PurchaseOrder: string;
  PurchaseOrderItem: string;
  PurchaseOrderDate: string;
  /** Requested date of the item (its first schedule line). */
  RequestedDate: string | null;
  NetAmount?: number | null;
  Currency?: string | null;
  /** Received quantity so far. Partial receipts remain actionable while OpenQuantity > 0. */
  ReceivedQuantity?: number | null;
  OpenQuantity?: number | null;
}

export interface Overdue<T extends OpenItemRow = OpenItemRow> {
  row: T;
  daysOverdue: number;
  dueDate: string;
  issue: string;
  issueTechnical: string;
}

export function overdueItems<T extends OpenItemRow>(rows: T[], asOf: string, days = OVERDUE_DAYS): Overdue<T>[] {
  const limit = addDays(asOf, -days);
  return rows
    .filter((r) => r.RequestedDate && r.RequestedDate < limit && (r.OpenQuantity == null || r.OpenQuantity > 0))
    .map((r) => {
      const d = daysBetween(r.RequestedDate!, asOf);
      return {
        row: r,
        daysOverdue: d,
        dueDate: r.RequestedDate!,
        issue: (r.ReceivedQuantity ?? 0) > 0
          ? `Partially received; remaining quantity was requested ${d} days ago`
          : `No goods receipt, requested date ${d} days ago`,
        issueTechnical: `${d} days overdue; ${fmtAmount(r.NetAmount, r.Currency)} open`.replace(/; $/, ""),
      };
    })
    .sort((a, b) => b.daysOverdue - a.daysOverdue || (b.row.NetAmount ?? 0) - (a.row.NetAmount ?? 0));
}
