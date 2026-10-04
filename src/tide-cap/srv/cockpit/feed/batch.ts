// A delta batch (rows created or changed on one working day, keyed by
// tide.s4 entity name) split into feeder entries (P-10). Pure, no CDS.
//
// Kinds:
//   po_item        PurchaseOrderItem rows of new items, with their header,
//                  schedule lines and account assignments
//   goods_receipt  MaterialDocumentItem rows with a PO reference, per PO item
//   confirmation   rows of an entity whose name contains "Confirmation", per PO item
//   freetext       purchase requisition items without a material (free text)
//   change         everything else (changed documents: open quantity, dates,
//                  status; material requisitions, sales orders, ...): upserted
//                  at the start of the day, no hooks
//
// Times: the entries of one kind on the day are spread evenly over the
// kind's slot (clock.ts), in key order; changes come at 07:00.

import { KIND_ORDER, dayOpen, spread, type EntryKind } from "./clock";
import { groupBy } from "../kernel/collections";

export type Rows = Record<string, any[]>;
export type FeedKind = EntryKind | "change";

export interface Entry {
  at: string;
  kind: FeedKind;
  /** PO/item (or PR/item) the entry is about, e.g. "4500000001/10". */
  key: string;
  rows: Rows;
}

const PO = (r: any): string | undefined =>
  r.PurchaseOrder ?? r.SuplrConfRefPurchaseOrder ?? r.PurchasingDocument ?? undefined;
const POI = (r: any): string | undefined =>
  r.PurchaseOrderItem ?? r.SuplrConfRefPurchaseOrderItem ?? r.PurchasingDocumentItem ?? undefined;
const norm = (v: unknown) => String(v ?? "").replace(/^0+(?=\d)/, "");

export const itemKey = (po: unknown, item: unknown) => `${po}/${norm(item)}`;

function isConfirmation(entity: string) {
  return /confirmation/i.test(entity);
}
function isRequisitionItem(entity: string) {
  return /^PurchaseReqnItem$|^PurchaseRequisitionItem$/.test(entity);
}
const isFreeText = (r: any) => !r.Material && !!(r.PurchaseRequisitionItemText ?? r.text);

function push(target: Rows, entity: string, row: any) {
  (target[entity] ??= []).push(row);
}

function byKey(a: Entry, b: Entry) {
  return a.at.localeCompare(b.at) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.key.localeCompare(b.key, "en", { numeric: true });
}

/** Splits one day's batch into entries in arrival order. */
export function splitBatch(date: string, batch: Rows): Entry[] {
  const groups = new Map<string, { kind: FeedKind; key: string; rows: Rows }>();
  const group = (kind: FeedKind, key: string) => {
    const id = `${kind}|${key}`;
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { kind, key, rows: {} }));
    return g;
  };
  const newItems = new Set<string>();
  const newItemsOfPo = new Map<string, string[]>();
  for (const r of batch.PurchaseOrderItem ?? []) {
    const k = itemKey(r.PurchaseOrder, r.PurchaseOrderItem);
    newItems.add(k);
    newItemsOfPo.set(String(r.PurchaseOrder), [...(newItemsOfPo.get(String(r.PurchaseOrder)) ?? []), k]);
    push(group("po_item", k).rows, "PurchaseOrderItem", r);
  }
  // Confirmation lines carry only the confirmation and its item; the item row
  // names the PO item. The header goes with the confirmation's first item.
  const confItem = new Map<string, string>();
  const confFirst = new Map<string, string>();
  for (const [entity, rows] of Object.entries(batch)) {
    if (!isConfirmation(entity)) continue;
    for (const r of rows ?? []) {
      const po = PO(r);
      const poi = POI(r);
      if (!po || poi === undefined || r.SupplierConfirmationItem === undefined) continue;
      const k = itemKey(po, poi);
      confItem.set(`${r.SupplierConfirmation}|${r.SupplierConfirmationItem}`, k);
      const prev = confFirst.get(String(r.SupplierConfirmation));
      if (!prev || k.localeCompare(prev, "en", { numeric: true }) < 0) confFirst.set(String(r.SupplierConfirmation), k);
    }
  }
  const confKey = (r: any): string | undefined =>
    r.SupplierConfirmationItem !== undefined
      ? confItem.get(`${r.SupplierConfirmation}|${r.SupplierConfirmationItem}`)
      : confFirst.get(String(r.SupplierConfirmation));
  const change: Rows = {};
  for (const [entity, rows] of Object.entries(batch)) {
    if (entity === "PurchaseOrderItem") continue;
    for (const r of rows ?? []) {
      const po = PO(r);
      const poi = POI(r);
      const k = isConfirmation(entity) ? confKey(r) : po && poi !== undefined ? itemKey(po, poi) : undefined;
      if (entity === "PurchaseOrder" && newItemsOfPo.has(String(r.PurchaseOrder))) {
        // The header travels with the PO's first new item.
        const first = [...newItemsOfPo.get(String(r.PurchaseOrder))!].sort()[0];
        push(group("po_item", first).rows, entity, r);
      } else if (k && newItems.has(k) && !isConfirmation(entity) && entity !== "MaterialDocumentItem") {
        push(group("po_item", k).rows, entity, r);
      } else if (entity === "MaterialDocumentItem" && k) {
        push(group("goods_receipt", k).rows, entity, r);
      } else if (isConfirmation(entity) && k) {
        push(group("confirmation", k).rows, entity, r);
      } else if (isRequisitionItem(entity) && isFreeText(r)) {
        push(group("freetext", itemKey(r.PurchaseRequisition, r.PurchaseRequisitionItem)).rows, entity, r);
      } else {
        push(change, entity, r);
      }
    }
  }
  const out: Entry[] = [];
  const perKind = groupBy([...groups.values()], (g) => g.kind);
  for (const [kind, gs] of perKind) {
    if (kind === "change") continue;
    gs.sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true }));
    const times = spread(date, kind as EntryKind, gs.length);
    gs.forEach((g, i) => out.push({ at: times[i], kind, key: g.key, rows: g.rows }));
  }
  if (Object.keys(change).length) out.push({ at: dayOpen(date), kind: "change", key: date, rows: change });
  return out.sort(byKey);
}

/** Orders entries of several days. */
export function ordered(entries: Entry[]): Entry[] {
  return [...entries].sort(byKey);
}

export function countRows(rows: Rows): number {
  return Object.values(rows).reduce((n, r) => n + (r?.length ?? 0), 0);
}

/** PO items touched by a set of rows (a header row touches every item of its PO via `poItems`). */
export function touchedItems(rows: Rows): { items: Array<{ PurchaseOrder: string; PurchaseOrderItem: string }>; pos: string[] } {
  const items = new Map<string, { PurchaseOrder: string; PurchaseOrderItem: string }>();
  const pos = new Set<string>();
  for (const [entity, rs] of Object.entries(rows)) {
    for (const r of rs ?? []) {
      const po = PO(r);
      const poi = POI(r);
      if (po && poi !== undefined && poi !== null && poi !== "")
        items.set(itemKey(po, poi), { PurchaseOrder: String(po), PurchaseOrderItem: norm(poi) });
      else if (po && entity === "PurchaseOrder") pos.add(String(po));
    }
  }
  return { items: [...items.values()], pos: [...pos] };
}
