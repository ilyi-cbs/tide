// Event log (contract §5): emit() is the only writer of tide.cockpit.Event.
import cds from "@sap/cds";
import { NS, inTx } from "./model-calls";
import type { EventRow } from "./types";

const { SELECT, INSERT } = cds.ql;
const ENTITY = `${NS}.Event`;

export type EventInput = Omit<Partial<EventRow>, "seq"> & Pick<EventRow, "kind" | "title">;

/** Appends one event; seq = max(seq) + 1 in the same transaction. Returns the stored row. */
export async function emit(ev: EventInput): Promise<EventRow> {
  return inTx(async () => {
    let scope: { PurchasingGroup?: string | null; Plant?: string | null } = {};
    if (ev.findingID) {
      // Cases.ID unifies at_risk/overdue under "delivery:"; every other list keeps "<list>:<objectKey>".
      const caseID = ev.findingID.replace(/^(at_risk|overdue):/, "delivery:");
      scope = await SELECT.one.from(`${NS}.Cases`).columns("PurchasingGroup", "Plant").where({ ID: caseID }) ?? {};
    } else if (ev.objectKey && ev.kind !== "freetext") {
      const [PurchaseOrder, PurchaseOrderItem] = ev.objectKey.split("/");
      if (PurchaseOrderItem) scope = await SELECT.one.from(`${NS}.OpenItem`).columns("PurchasingGroup", "Plant").where({ PurchaseOrder, PurchaseOrderItem }) ?? {};
    }
    const top = await SELECT.one.from(ENTITY).columns("max(seq) as seq");
    const row: EventRow = {
      at: new Date().toISOString(),
      ...scope,
      ...ev,
      title: String(ev.title ?? "").slice(0, 300),
      seq: Number(top?.seq ?? 0) + 1,
    } as EventRow;
    await INSERT.into(ENTITY).entries(row);
    return row;
  });
}
