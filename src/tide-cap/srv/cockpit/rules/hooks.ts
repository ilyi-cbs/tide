// Use cases "ingest hooks" of the rules (contract §7): feeder confirmation,
// goods receipt and new PO item.
import cds from "@sap/cds";
import { upsertDetectorCase } from "../kernel/detector-writers";
import type { EventRow, HookResult, IngestEvent } from "../kernel/types";
import { addDays, confirmationsFromRows, type PriceRow } from "./domain";
import { addConfirmation, modelPriceFinding, writeRuleLines } from "./rows";
import * as store from "./store";
import type { Row } from "../kernel/model-calls";
import { reconcileDeliveryProblem } from "../kernel/problem-reconciliation";
import { assessPriceCandidates } from "./price-model";

const keysOf = (ev: IngestEvent) => {
  const out = new Map<
    string,
    { PurchaseOrder: string; PurchaseOrderItem: string }
  >();
  for (const rows of Object.values(ev.rows ?? {}))
    for (const r of rows ?? []) {
      const po = r?.PurchaseOrder ?? r?.SuplrConfRefPurchaseOrder;
      const item = r?.PurchaseOrderItem ?? r?.SuplrConfRefPurchaseOrderItem;
      if (po && item != null) {
        const k = {
          PurchaseOrder: String(po),
          PurchaseOrderItem: store.stripZeros(item),
        };
        out.set(`${k.PurchaseOrder}/${k.PurchaseOrderItem}`, k);
      }
    }
  return [...out.values()];
};

/** Feeder confirmation (already in SAP): record origin feeder, no finding to close (the confirmation findings list is gone). */
export async function onConfirmation(ev: IngestEvent): Promise<HookResult> {
  const events: Array<Partial<EventRow>> = [];
  const sets: Record<string, any[]> = {};
  for (const [k, rows] of Object.entries(ev.rows ?? {}))
    sets[k] = (rows ?? []).filter((r) => r?.origin !== "app");
  for (const c of confirmationsFromRows(sets)) {
    await addConfirmation(
      c.PurchaseOrder,
      c.PurchaseOrderItem,
      c.date,
      c.quantity,
      "feeder",
      "feeder",
    );
    await reconcileDeliveryProblem(
      c.PurchaseOrder,
      c.PurchaseOrderItem,
      "confirmation",
    );
    events.push({
      kind: "confirmation",
      at: new Date().toISOString(),
      simTime: ev.at ?? null,
      title: `Supplier confirmed PO ${c.PurchaseOrder} item ${c.PurchaseOrderItem} for ${c.date}`,
      objectKey: `${c.PurchaseOrder}/${c.PurchaseOrderItem}`,
      source: "confirmation",
      status: "recorded",
      modelCalls: 0,
      costUnits: 0,
    });
  }
  return { events };
}

/** Goods receipt: source facts decide whether the remaining obligation ended. */
export async function onGoodsReceipt(ev: IngestEvent): Promise<HookResult> {
  const events: Array<Partial<EventRow>> = [];
  for (const k of keysOf(ev)) {
    const result = await reconcileDeliveryProblem(
      k.PurchaseOrder,
      k.PurchaseOrderItem,
      "goods_receipt",
    );
    if (result.resolved)
      events.push({
        kind: "goods_receipt",
        at: new Date().toISOString(),
        simTime: ev.at ?? null,
        title: `Goods received for PO ${k.PurchaseOrder} item ${k.PurchaseOrderItem}; delivery obligation resolved`,
        objectKey: `${k.PurchaseOrder}/${k.PurchaseOrderItem}`,
        source: "rule",
        status: "closed",
        modelCalls: 0,
        costUnits: 0,
      });
    else
      events.push({
        kind: "goods_receipt",
        at: new Date().toISOString(),
        simTime: ev.at ?? null,
        title: `Partial receipt for PO ${k.PurchaseOrder} item ${k.PurchaseOrderItem}; ${result.openQuantity} remains open`,
        objectKey: `${k.PurchaseOrder}/${k.PurchaseOrderItem}`,
        source: "rule",
        status: "open",
        modelCalls: 0,
        costUnits: 0,
      });
  }
  return { events };
}

/** New PO item: the price rule on the item against earlier prices of its material and plant (1-day window). */
export async function onPoItem(ev: IngestEvent): Promise<HookResult> {
  const newItems = (ev.rows?.PurchaseOrderItem ?? []).filter(
    (r) => r?.Material && r?.Plant,
  );
  if (!newItems.length) return { events: [] };
  const want = new Set(
    newItems.map(
      (r) => `${r.PurchaseOrder}/${store.stripZeros(r.PurchaseOrderItem)}`,
    ),
  );
  const rows = (await store.priceRows(
    newItems.map((r) => ({ Material: r.Material, Plant: r.Plant })),
  )) as (PriceRow & Row)[];
  const assessed = await assessPriceCandidates(
    cds.context?.user ?? cds.User.privileged,
    // The just-ingested order is known at its posting day; use the next day as
    // the decision cutoff so it is eligible without training on itself.
    addDays(String(ev.at ?? new Date().toISOString()).slice(0, 10), 1),
    rows.filter((row) =>
      want.has(`${row.PurchaseOrder}/${row.PurchaseOrderItem}`),
    ),
  );
  const n = await store.names();
  const events: Array<Partial<EventRow>> = [];
  for (const { row, assessment } of assessed.filter(
    ({ assessment }) =>
      assessment.source === "tabpfn" &&
      assessment.alert &&
      assessment.calibrationStatus === "calibrated",
  )) {
    const key = `${row.PurchaseOrder}/${row.PurchaseOrderItem}`;
    const finding = modelPriceFinding(row, assessment, n, true, rows);
    const saved = await upsertDetectorCase({
      ...finding.row,
      arrivedAt: new Date().toISOString(),
      rank: 0,
    });
    await writeRuleLines(finding.lines, [saved.ID]);
    events.push({
      kind: "po_item",
      at: new Date().toISOString(),
      simTime: ev.at ?? null,
      title: `PO ${key}: price differs from the expected range`,
      objectKey: key,
      findingID: saved.ID,
      source: assessment.source === "fallback" ? "fallback" : "tabpfn",
      status: "open",
      modelCalls: 0,
      costUnits: 0,
    });
  }
  return { events };
}
