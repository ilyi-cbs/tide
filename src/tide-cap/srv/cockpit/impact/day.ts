// Use case "impact of the day" (P-2, A1): ItemImpact for every open PO item,
// then the impact fields of the findings of at_risk and overdue,
// and at_risk re-ranked by impact. No model call.
import cds from "@sap/cds";
import { impactText } from "../kernel/findings";
import { NS, inTx } from "../kernel/model-calls";
import { writePreparation } from "../kernel/publication";
import type { StepContext } from "../kernel/types";
import {
  assess,
  compareImpact,
  CRITICALITY,
  KIND_WORDS,
  revenueTotal,
  type Impact,
  type ImpactLevel,
} from "./domain/impact";
import { buildPlanning, type R } from "./domain/planning";
import {
  arrivalInputs,
  openItems,
  openItemsFromS4,
  planningRows,
  toImpactItem,
} from "./store";
import {
  deliveryPriority,
  deliveryWorkPriority,
  priorityFields,
  prioritySort,
  PRIORITY_ORDER,
} from "./domain/priority";

const { SELECT, INSERT, DELETE, UPDATE } = cds.ql;
const LOG = cds.log("cockpit");
export const ENTITY = `${NS}.ItemImpact`;
export const SALES_ORDER_IMPACT = `${NS}.SalesOrderImpact`;
export const PRODUCTION_ORDER_IMPACT = `${NS}.ProductionOrderImpact`;
export const FINDING = `${NS}.Finding`;
export const IMPACT_LISTS = ["at_risk", "overdue"];
const CHUNK = 500;

export type Key = { PurchaseOrder: string; PurchaseOrderItem: string };
export const keyOf = (r: {
  PurchaseOrder?: unknown;
  PurchaseOrderItem?: unknown;
}) => `${r.PurchaseOrder}/${r.PurchaseOrderItem}`;

/** ItemImpact row of one assessed item. */
export function impactRow(o: R, i: Impact, snapshotId: string | null): R {
  return {
    PurchaseOrder: String(o.PurchaseOrder),
    PurchaseOrderItem: String(o.PurchaseOrderItem),
    snapshot_ID: snapshotId,
    level: i.level,
    impactLevelText: impactText(i.level),
    rank: i.rank,
    materialKind: i.materialKind,
    impactKindText: KIND_WORDS[i.materialKind],
    kindNote: i.kindNote.slice(0, 200),
    expectedDate: i.expectedDate,
    cautiousDate: i.cautiousDate,
    confirmedDate: i.confirmedDate,
    arrivalSource: i.arrivalSource,
    needDate: i.needDate,
    delayDays: i.delayDays,
    customerDelayDays: i.customerDelayDays,
    revenueAtRisk: i.revenueAtRisk,
    revenueCautious: i.revenueCautious,
    shortageFrom: i.shortageFrom,
    shortageDays: i.shortageDays,
    coverageDays: i.coverageDays,
    stock: i.stock,
    productionOrders: i.productionOrders.length,
    salesOrders: i.salesOrders.length,
    salesOrderKeys: JSON.stringify(
      i.salesOrders.map((o) => ({
        key: `${o.salesOrder}/${o.salesOrderItem}`,
        netAmount: o.netAmount,
      })),
    ),
    note: i.note.slice(0, 300),
    scenarios: i.scenarios ? JSON.stringify(i.scenarios) : null,
    md04: JSON.stringify(i.md04),
    chain: i.chain ? JSON.stringify(i.chain) : null,
    source: "calculation",
  };
}

export function salesOrderImpactRows(o: R, i: Impact): R[] {
  const delays = i.chain?.salesOrderDelays as
    Array<{ key: string; delayDays: number }> | undefined;
  return i.salesOrders.map((order) => ({
    PurchaseOrder: String(o.PurchaseOrder),
    PurchaseOrderItem: String(o.PurchaseOrderItem),
    SalesOrder: order.salesOrder,
    SalesOrderItem: order.salesOrderItem,
    Customer: order.customer ?? null,
    CustomerName: order.customerName ?? null,
    RequiredDate: order.customerDate ?? i.needDate,
    PredictedDelayDays:
      delays?.find(
        (delay) => delay.key === `${order.salesOrder}/${order.salesOrderItem}`,
      )?.delayDays ?? i.customerDelayDays,
    RevenueAtRisk: order.netAmount,
    Currency: order.currency,
  }));
}

export function productionOrderImpactRows(o: R, i: Impact): R[] {
  const requirements = i.chain?.productionRequirements as
    | Array<{
        productionOrder: string;
        finishedProduct: string | null;
        requiredDate: string;
        shortageDays: number;
        affectedQuantity: number | null;
      }>
    | undefined;
  return i.productionOrders.map((productionOrder) => {
    const requirement = requirements?.find(
      (row) => row.productionOrder === productionOrder,
    );
    return {
      PurchaseOrder: String(o.PurchaseOrder),
      PurchaseOrderItem: String(o.PurchaseOrderItem),
      ProductionOrder: productionOrder,
      FinishedProduct: requirement?.finishedProduct ?? null,
      RequiredDate: requirement?.requiredDate ?? i.needDate,
      PredictedShortageDays: requirement?.shortageDays ?? i.shortageDays,
      AffectedQuantity: requirement?.affectedQuantity ?? null,
      Unit: o.OrderQuantityUnit ?? null,
    };
  });
}

/**
 * Assesses the open items; `only` restricts which items are assessed (all
 * open items still form the plant-segment projection).
 */
export async function computeImpacts(
  asOf: string,
  open: R[],
  only?: Set<string>,
) {
  const pl = buildPlanning(await planningRows(asOf, open));
  const targets = only ? open.filter((o) => only.has(keyOf(o))) : open;
  const arr = await arrivalInputs(targets);
  const out: Array<{ item: R; impact: Impact }> = [];
  for (const o of targets) {
    if (!o.PurchaseOrderDate || !o.Plant) continue;
    const it = toImpactItem(o);
    it.mto = pl.mtoLinks(it.PurchaseOrder, it.PurchaseOrderItem, it.Material);
    const k = keyOf(o);
    const g = arr.grid.get(k);
    try {
      out.push({
        item: o,
        impact: assess(pl, it, {
          grid: g?.grid ?? null,
          gridSource: g?.source ?? null,
          confirmation: arr.confirmation.get(k) ?? null,
        }),
      });
    } catch (e) {
      LOG.error(`impact of ${k} failed`, e);
      throw e;
    }
  }
  return out;
}

/** Revenue-at-risk KPI over all stored impacts; a sales order hit twice counts once (P-2). */
async function storeKpi(
  snapshotId: string | null,
  impacts: Array<{ impact: Impact }>,
) {
  if (!snapshotId) return;
  const total = revenueTotal(impacts.map((x) => x.impact));
  await UPDATE.entity(`${NS}.Snapshot`, snapshotId).with({
    impactRevenueAtRisk: total,
  });
}

/** Fills impact fields of the findings of the impact lists and re-ranks at_risk by impact. */
export async function refreshFindings(asOf: string) {
  const imp: R[] = await SELECT.from(ENTITY).columns(
    "PurchaseOrder",
    "PurchaseOrderItem",
    "level",
    "rank",
    "needDate",
    "expectedDate",
    "arrivalSource",
    "revenueAtRisk",
    "productionOrders",
    "shortageDays",
    "delayDays",
  );
  const byKey = new Map(imp.map((i) => [keyOf(i), i]));
  const rows: R[] = [];
  for (const list of IMPACT_LISTS)
    rows.push(
      ...(await SELECT.from(FINDING).columns(
        "ID",
        "list",
        "PurchaseOrder",
        "PurchaseOrderItem",
        "rank",
        "impactLevel",
        "revenueAtRisk",
        "dueDate",
      ).where`list = ${list}`),
    );
  const overdue: R[] = await SELECT.from(`${NS}.OverdueDetail`).columns(
    "finding_ID",
    "daysOverdue",
  );
  const overdueDays = new Map(
    overdue.map((row) => [row.finding_ID, row.daysOverdue]),
  );
  const sortKey = (r: R) => {
    const impact = byKey.get(keyOf(r));
    return {
      deliveryPriorityOrder:
        PRIORITY_ORDER[
          deliveryWorkPriority({
            phase: r.list,
            forecastDelayDays: impact?.delayDays ?? null,
            daysOverdue:
              r.list === "overdue" ? (overdueDays.get(r.ID) ?? null) : null,
            impactLevel: impact?.level ?? null,
            needDate: impact?.needDate ?? null,
            asOf,
          })
        ],
      revenueAtRisk: impact?.revenueAtRisk,
    };
  };
  const atRisk = rows.filter((r) => r.list === "at_risk");
  atRisk.sort((a, b) => {
    return (
      prioritySort(sortKey(a), sortKey(b)) ||
      compareImpact(byKey.get(keyOf(a)), byKey.get(keyOf(b))) ||
      (a.rank ?? 1e9) - (b.rank ?? 1e9) ||
      String(a.ID).localeCompare(String(b.ID))
    );
  });
  const newRank = new Map(atRisk.map((r, n) => [r.ID, n + 1]));
  // One UPDATE per distinct set of values (the impact fields repeat across items).
  const groups = new Map<string, { set: R; ids: string[] }>();
  for (const r of rows) {
    const i = byKey.get(keyOf(r));
    const level = (i?.level ?? null) as ImpactLevel | null;
    const set: R = {
      impactLevel: level,
      impactCriticality: level ? CRITICALITY[level] : 0,
      impactText: level ? impactText(level, i?.revenueAtRisk) : null,
      revenueAtRisk: i?.revenueAtRisk ?? null,
      ...priorityFields(
        level,
        i?.needDate ?? null,
        asOf,
        r.list === "overdue" ? (overdueDays.get(r.ID) ?? null) : null,
      ),
      predictedArrival: i?.expectedDate ?? null,
      arrivalSource: i?.arrivalSource ?? null,
    };
    if (newRank.has(r.ID)) set.rank = newRank.get(r.ID);
    const k = JSON.stringify(set);
    (groups.get(k) ?? groups.set(k, { set, ids: [] }).get(k)!).ids.push(r.ID);
  }
  for (const { set, ids } of groups.values())
    for (let n = 0; n < ids.length; n += CHUNK)
      await UPDATE.entity(FINDING)
        .set(set)
        .where({ ID: { in: ids.slice(n, n + CHUNK) } });
  // Delivery-case priority is canonical; keep the legacy Finding rank aligned.
  for (const row of rows) {
    const impact = byKey.get(keyOf(row));
    const priority =
      PRIORITY_ORDER[
        deliveryWorkPriority({
          phase: row.list,
          forecastDelayDays: impact?.delayDays ?? null,
          daysOverdue:
            row.list === "overdue" ? (overdueDays.get(row.ID) ?? null) : null,
          impactLevel: impact?.level ?? null,
          needDate: impact?.needDate ?? null,
          asOf,
        })
      ];
    const header_ID = `delivery:${row.PurchaseOrder}/${row.PurchaseOrderItem}`;
    await UPDATE.entity(`${NS}.Cases`)
      .set({ priority })
      .where({ ID: header_ID });
    // DeliveryRisks is the typed UI root. Keep its visible forecast and impact
    // facts in lockstep with the ItemImpact calculation, not the legacy Finding.
    await UPDATE.entity(`${NS}.DeliveryRisks`)
      .set({
        predictedArrival: impact?.expectedDate ?? null,
        arrivalSource: impact?.arrivalSource ?? null,
        revenueAtRisk: impact?.revenueAtRisk ?? null,
      })
      .where({ header_ID });
  }
  return rows.length;
}

/** Morning step: ItemImpact for every open PO item (no model call; nothing in dry run). */
export async function runImpact(
  ctx: Pick<StepContext, "asOf" | "snapshotId" | "dryRun" | "publication">,
) {
  if (ctx.dryRun) return 0;
  let assessed = 0;
  await writePreparation(ctx, async () => {
    const open = await openItems();
    const res = await computeImpacts(ctx.asOf, open);
    const rows = res.map((x) => impactRow(x.item, x.impact, ctx.snapshotId));
    const salesRows = res.flatMap((x) =>
      salesOrderImpactRows(x.item, x.impact),
    );
    const productionRows = res.flatMap((x) =>
      productionOrderImpactRows(x.item, x.impact),
    );
    await DELETE.from(SALES_ORDER_IMPACT);
    await DELETE.from(PRODUCTION_ORDER_IMPACT);
    await DELETE.from(ENTITY);
    for (let offset = 0; offset < rows.length; offset += CHUNK)
      await INSERT.into(ENTITY).entries(rows.slice(offset, offset + CHUNK));
    for (let offset = 0; offset < salesRows.length; offset += CHUNK)
      await INSERT.into(SALES_ORDER_IMPACT).entries(
        salesRows.slice(offset, offset + CHUNK),
      );
    for (let offset = 0; offset < productionRows.length; offset += CHUNK)
      await INSERT.into(PRODUCTION_ORDER_IMPACT).entries(
        productionRows.slice(offset, offset + CHUNK),
      );
    await storeKpi(ctx.snapshotId, res);
    await refreshFindings(ctx.asOf);
    LOG.info(`impact: ${rows.length} open items assessed`);
    assessed = rows.length;
  });
  return assessed;
}
