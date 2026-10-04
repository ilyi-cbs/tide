// Confirmations replace an item's estimate; receipts and new PO items recompute
// open items for the same material and plant. Callers emit the returned events.
import cds from "@sap/cds";
import { impactText } from "../kernel/findings";
import { inTx } from "../kernel/model-calls";
import type {
  EventRow,
  HookResult,
  IngestEvent,
  StepContext,
} from "../kernel/types";
import { changeTitle, type ImpactLevel } from "./domain/impact";
import type { R } from "./domain/planning";
import {
  computeImpacts,
  ENTITY,
  FINDING,
  IMPACT_LISTS,
  impactRow,
  keyOf,
  refreshFindings,
  type Key,
} from "./day";
import { openItems, openItemsFromS4 } from "./store";

const { SELECT, INSERT, DELETE } = cds.ql;

function keysIn(ev: IngestEvent): Key[] {
  const seen = new Map<string, Key>();
  for (const list of Object.values(ev.rows ?? {}))
    for (const r of list ?? [])
      if (r?.PurchaseOrder && r?.PurchaseOrderItem)
        seen.set(keyOf(r), {
          PurchaseOrder: String(r.PurchaseOrder),
          PurchaseOrderItem: String(r.PurchaseOrderItem),
        });
  return [...seen.values()];
}

function materialsIn(ev: IngestEvent): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(ev.rows ?? {}))
    for (const r of list ?? [])
      if (r?.Material && r?.Plant) out.add(`${r.Material}|${r.Plant}`);
  return out;
}

/** All open items: the morning's OpenItem rows plus items that arrived later (S/4 only), minus completely delivered ones. */
async function allOpen(extra: Key[]): Promise<R[]> {
  const open = await openItems();
  const have = new Set(open.map(keyOf));
  const add = await openItemsFromS4(extra.filter((k) => !have.has(keyOf(k))));
  const merged = [...open, ...add];
  const done = await deliveredKeys(
    merged.filter((o) => extra.some((k) => keyOf(k) === keyOf(o))),
  );
  return merged.filter((o) => !done.has(keyOf(o)));
}

async function deliveredKeys(list: R[]): Promise<Set<string>> {
  if (
    !list.length ||
    !(cds.model?.definitions as any)?.["tide.s4.PurchaseOrderItem"]
  )
    return new Set();
  const rows: R[] = await SELECT.from("tide.s4.PurchaseOrderItem")
    .columns("PurchaseOrder", "PurchaseOrderItem", "IsCompletelyDelivered")
    .where({
      PurchaseOrder: {
        in: [...new Set(list.map((o) => String(o.PurchaseOrder)))],
      },
    });
  return new Set(rows.filter((r) => r.IsCompletelyDelivered).map(keyOf));
}

/** Recomputes the given items (and all open items of the given material|plant keys); returns before → after per item. */
export async function recompute(
  ctx: Pick<StepContext, "asOf" | "snapshotId">,
  keys: Key[],
  materials: Set<string> = new Set(),
) {
  const open = await allOpen(keys);
  const openKeys = new Set(open.map(keyOf));
  const only = new Set<string>(keys.map(keyOf).filter((k) => openKeys.has(k)));
  for (const o of open)
    if (materials.has(`${o.Material}|${o.Plant}`)) only.add(keyOf(o));
  const gone = keys.map(keyOf).filter((k) => !openKeys.has(k));
  const beforeRows: R[] =
    only.size || gone.length
      ? await SELECT.from(ENTITY).columns(
          "PurchaseOrder",
          "PurchaseOrderItem",
          "level",
          "expectedDate",
          "revenueAtRisk",
        )
      : [];
  const before = new Map(beforeRows.map((r) => [keyOf(r), r]));
  const res = only.size ? await computeImpacts(ctx.asOf, open, only) : [];
  await inTx(async () => {
    for (const k of [...only, ...gone]) {
      const [PurchaseOrder, PurchaseOrderItem] = k.split("/");
      await DELETE.from(ENTITY).where({ PurchaseOrder, PurchaseOrderItem });
    }
    const rows = res.map((x) =>
      impactRow(x.item, x.impact, ctx.snapshotId ?? null),
    );
    if (rows.length) await INSERT.into(ENTITY).entries(rows);
    await refreshFindings(ctx.asOf);
  });
  return res.map((x) => ({
    key: keyOf(x.item),
    before: before.get(keyOf(x.item)) ?? null,
    after: x.impact,
  }));
}

const at = (ev: IngestEvent) => ev.at ?? new Date().toISOString();

async function findingOf(key: string): Promise<string | null> {
  const [PurchaseOrder, PurchaseOrderItem] = key.split("/");
  const rows: R[] = await SELECT.from(FINDING)
    .columns("ID", "list")
    .where({ PurchaseOrder, PurchaseOrderItem });
  rows.sort(
    (a, b) => IMPACT_LISTS.indexOf(a.list) - IMPACT_LISTS.indexOf(b.list),
  );
  return rows.find((r) => IMPACT_LISTS.includes(r.list))?.ID ?? null;
}

/** Confirmation: the confirmed date replaces the estimate; one event per item with impact before → after. */
export async function onConfirmation(
  ev: IngestEvent,
  ctx: StepContext,
): Promise<HookResult> {
  const keys = keysIn(ev);
  const changes = await recompute(ctx, keys);
  const events: Array<Partial<EventRow>> = [];
  for (const c of changes) {
    const [po, item] = c.key.split("/");
    const b = c.before
      ? {
          level: c.before.level as ImpactLevel,
          expectedDate: String(c.before.expectedDate ?? "").slice(0, 10),
        }
      : null;
    events.push({
      kind: "confirmation",
      at: at(ev),
      simTime: ev.at ?? null,
      title: changeTitle(
        po,
        item,
        c.after.confirmedDate ?? c.after.expectedDate,
        b,
        { level: c.after.level, expectedDate: c.after.expectedDate },
        (l) => impactText(l),
      ),
      objectKey: c.key,
      findingID: await findingOf(c.key),
      source: "confirmation",
      status: "recorded",
      modelCalls: 0,
      costUnits: 0,
    });
  }
  return { events };
}

/** Goods receipt or new PO item: recompute every open item of the same material and plant. */
export async function onSupplyChange(
  ev: IngestEvent,
  ctx: StepContext,
): Promise<HookResult> {
  const keys = keysIn(ev);
  const materials = materialsIn(ev);
  if (!materials.size && keys.length) {
    const rows: R[] = (cds.model?.definitions as any)?.[
      "tide.s4.PurchaseOrderItem"
    ]
      ? await SELECT.from("tide.s4.PurchaseOrderItem")
          .columns("PurchaseOrder", "PurchaseOrderItem", "Material", "Plant")
          .where({
            PurchaseOrder: {
              in: [...new Set(keys.map((k) => k.PurchaseOrder))],
            },
          })
      : [];
    for (const r of rows)
      if (r.Material && keys.some((k) => keyOf(k) === keyOf(r)))
        materials.add(`${r.Material}|${r.Plant}`);
  }
  const changes = await recompute(ctx, keys, materials);
  const moved = changes.filter(
    (c) => c.before && c.before.level !== c.after.level,
  );
  if (!moved.length) return { events: [] };
  return {
    events: [
      {
        kind: ev.kind,
        at: at(ev),
        simTime: ev.at ?? null,
        title:
          `Impact recomputed for ${changes.length} open item(s) of the same material; ${moved.length} changed`.slice(
            0,
            300,
          ),
        objectKey: moved[0].key,
        findingID: await findingOf(moved[0].key),
        source: "calculation",
        status: "recomputed",
        modelCalls: 0,
        costUnits: 0,
      },
    ],
  };
}
