// Supplier reminder text (contract A1, H-4): states the rule reason only,
// never a model probability, a revenue figure or a customer name. The
// internal action summary may name the impact. Pure: no CDS.


export type ReminderReason =
  | { kind: "overdue"; daysOverdue: number }
  | { kind: "requested_before_po" }
  | { kind: "planned_time_not_reachable"; plannedDays?: number | null }
  | { kind: "none" };

export interface ReminderItem {
  PurchaseOrder: string;
  PurchaseOrderItem: string;
  Material?: string | null;
  MaterialText?: string | null;
  RequestedDate?: string | null;
}

export function reasonSentence(r: ReminderReason): string | null {
  switch (r.kind) {
    case "overdue":
      return `The requested date passed ${r.daysOverdue} days ago and we have not received the goods.`;
    case "requested_before_po":
      return "The requested date lies before the order date.";
    case "planned_time_not_reachable":
      return "The requested date lies before the order date plus the agreed planned delivery time.";
    default:
      return null;
  }
}

/** Subject and body of a reminder draft to the supplier. */
export function reminderText(item: ReminderItem, reason: ReminderReason): { subject: string; body: string; reason: string | null } {
  const { PurchaseOrder: po, PurchaseOrderItem: it } = item;
  const ask = "please confirm the delivery date";
  const material = item.Material ? ` (material ${item.Material}${item.MaterialText ? ` ${item.MaterialText}` : ""})` : "";
  const requested = item.RequestedDate ? `, requested delivery date ${item.RequestedDate}` : "";
  const why = reasonSentence(reason);
  const subject = `Purchase order ${po}, item ${it}: ${ask}`;
  const body = [
    "Dear Sir or Madam,",
    "",
    `for our purchase order ${po}, item ${it}${material}${requested}, ${ask}.`,
    ...(why ? [why] : []),
    "",
    "Thank you and kind regards",
    "<buyer name>",
  ].join("\n");
  return { subject, body, reason: why };
}

/**
 * Internal action summary: may name the impact (never sent to the supplier).
 * `impactText` is the kernel's buyer text of the item's impact, e.g.
 * "Customer order at risk · 12,400 EUR".
 */
export function actionSummary(item: ReminderItem, reason: ReminderReason, impactText?: string | null): string {
  const parts = [`Reminder for PO ${item.PurchaseOrder} item ${item.PurchaseOrderItem}.`];
  const why = reasonSentence(reason);
  if (why) parts.push(why);
  if (impactText) parts.push(`Impact: ${impactText}.`);
  return parts.join(" ").slice(0, 1000);
}
