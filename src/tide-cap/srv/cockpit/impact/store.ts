// Reads what the impact calculation needs from tide.s4 and tide.cockpit.
// Optional tables (stock, production orders, planned orders, confirmations)
// may be missing from the model or empty: they then read as no rows.
import cds from "@sap/cds";
import { NS } from "../kernel/model-calls";
import { days, parseGrid, type ImpactItem } from "./domain/impact";
import type { PlanningRows, R } from "./domain/planning";

const { SELECT } = cds.ql;
const S4 = "tide.s4";

const has = (entity: string) => !!(cds.model?.definitions as any)?.[entity];
const elementsOf = (entity: string) =>
  Object.keys((cds.model?.definitions as any)?.[entity]?.elements ?? {});

/** SELECT of the listed columns that exist on the entity; [] when the entity is missing. */
async function rows(
  entity: string,
  columns: string[],
  where?: any,
): Promise<R[]> {
  if (!has(entity)) return [];
  const present = new Set(elementsOf(entity));
  const cols = columns.filter((c) =>
    present.has(c.split(" as ")[0].split(".")[0]),
  );
  if (!cols.length) return [];
  const q = SELECT.from(entity).columns(...cols);
  if (where) q.where(where);
  return (await q) as R[];
}

/** Open PO items of the morning (legacy read model OpenItem) with their S/4 item attributes. */
export async function openItems(
  keys?: Array<{ PurchaseOrder: string; PurchaseOrderItem: string }>,
): Promise<R[]> {
  if (keys && !keys.length) return [];
  const list = await rows(
    `${NS}.OpenItem`,
    [
      "PurchaseOrder",
      "PurchaseOrderItem",
      "Material",
      "Plant",
      "PurchaseOrderDate",
      "RequestedDate",
      "OpenQuantity",
      "Supplier",
    ],
    keys ? keyWhere(keys) : undefined,
  );
  return enrich(list);
}

function keyWhere(
  keys: Array<{ PurchaseOrder: string; PurchaseOrderItem: string }>,
) {
  const xpr: any[] = [];
  keys.forEach((k, i) => {
    if (i) xpr.push("or");
    xpr.push(
      "(",
      { ref: ["PurchaseOrder"] },
      "=",
      { val: k.PurchaseOrder },
      "and",
      { ref: ["PurchaseOrderItem"] },
      "=",
      { val: k.PurchaseOrderItem },
      ")",
    );
  });
  return xpr;
}

/** Adds MaterialType, AccountAssignmentCategory and PurchaseOrderItemCategory from S/4. */
async function enrich(list: R[]): Promise<R[]> {
  if (!list.length) return list;
  const po = await rows(`${S4}.PurchaseOrderItem`, [
    "PurchaseOrder",
    "PurchaseOrderItem",
    "MaterialType",
    "OrderQuantityUnit",
    "AccountAssignmentCategory",
    "PurchaseOrderItemCategory",
  ]);
  const byKey = new Map(
    po.map((p) => [`${p.PurchaseOrder}/${p.PurchaseOrderItem}`, p]),
  );
  const products = await rows(`${S4}.Product`, ["Product", "ProductType"]);
  const typeOf = new Map(
    products.map((p) => [String(p.Product), p.ProductType]),
  );
  return list.map((o) => {
    const p = byKey.get(`${o.PurchaseOrder}/${o.PurchaseOrderItem}`);
    return {
      ...o,
      MaterialType: p?.MaterialType || typeOf.get(String(o.Material)) || null,
      OrderQuantityUnit: p?.OrderQuantityUnit ?? null,
      AccountAssignmentCategory: p?.AccountAssignmentCategory ?? null,
      PurchaseOrderItemCategory: p?.PurchaseOrderItemCategory ?? null,
    };
  });
}

/** Open PO items from S/4 (for items that arrived during the day and are not in OpenItem yet). */
export async function openItemsFromS4(
  keys: Array<{ PurchaseOrder: string; PurchaseOrderItem: string }>,
): Promise<R[]> {
  if (!keys.length || !has(`${S4}.PurchaseOrderItem`)) return [];
  const items = await rows(
    `${S4}.PurchaseOrderItem`,
    [
      "PurchaseOrder",
      "PurchaseOrderItem",
      "Material",
      "Plant",
      "OrderQuantity",
      "MaterialType",
      "AccountAssignmentCategory",
      "PurchaseOrderItemCategory",
      "IsCompletelyDelivered",
      "PurchasingDocumentDeletionCode",
    ],
    keyWhere(keys),
  );
  const heads = await rows(
    `${S4}.PurchaseOrder`,
    ["PurchaseOrder", "PurchaseOrderDate", "Supplier"],
    { PurchaseOrder: { in: [...new Set(keys.map((k) => k.PurchaseOrder))] } },
  );
  const lines = await rows(
    `${S4}.PurchaseOrderScheduleLine`,
    [
      "PurchaseOrder",
      "PurchaseOrderItem",
      "ScheduleLine",
      "ScheduleLineDeliveryDate",
      "OpenPurchaseOrderQuantity",
      "ScheduleLineOrderQuantity",
    ],
    keyWhere(keys),
  );
  const head = new Map(heads.map((h) => [String(h.PurchaseOrder), h]));
  return items
    .filter(
      (i) => !i.IsCompletelyDelivered && !i.PurchasingDocumentDeletionCode,
    )
    .map((i) => {
      const ls = lines.filter(
        (l) =>
          l.PurchaseOrder === i.PurchaseOrder &&
          l.PurchaseOrderItem === i.PurchaseOrderItem,
      );
      ls.sort((a, b) =>
        String(a.ScheduleLineDeliveryDate).localeCompare(
          String(b.ScheduleLineDeliveryDate),
        ),
      );
      const open = ls.reduce(
        (s, l) =>
          s +
          Number(
            l.OpenPurchaseOrderQuantity ?? l.ScheduleLineOrderQuantity ?? 0,
          ),
        0,
      );
      const h = head.get(String(i.PurchaseOrder));
      return {
        ...i,
        Supplier: h?.Supplier ?? null,
        PurchaseOrderDate: h?.PurchaseOrderDate ?? null,
        RequestedDate: ls[0]?.ScheduleLineDeliveryDate ?? null,
        OpenQuantity: ls.length ? open : Number(i.OrderQuantity ?? 0),
      };
    })
    .filter((i) => i.PurchaseOrderDate);
}

async function fx(): Promise<Map<string, number>> {
  const m = new Map<string, number>([["EUR", 1]]);
  for (const r of await rows(`${S4}.ExchangeRate`, [
    "SourceCurrency",
    "ExchangeRate",
  ]))
    m.set(String(r.SourceCurrency), Number(r.ExchangeRate));
  return m;
}

/** Everything the plant-segment projection and the make-to-order link read. */
export async function planningRows(
  asOf: string,
  open: R[],
): Promise<PlanningRows> {
  const [
    stock,
    productionOrders,
    components,
    plannedOrders,
    plannedComponents,
    independent,
    salesItems,
    salesHeads,
    customers,
    assignments,
    fxMap,
  ] = await Promise.all([
    rows(`${S4}.MatlStkInAcctMod`, [
      "Material",
      "Plant",
      "InventoryStockType",
      "InventorySpecialStockType",
      "MatlWrhsStkQtyInMatlBaseUnit",
    ]),
    rows(`${S4}.ProductionOrder`, [
      "ManufacturingOrder",
      "Material",
      "ProductionPlant",
      "TotalQuantity",
      "MfgOrderPlannedStartDate",
      "MfgOrderPlannedEndDate",
      "MfgOrderScheduledEndDate",
      "OrderIsCreated",
      "OrderIsReleased",
      "SalesOrder",
      "SalesOrderItem",
      "MfgOrderConfirmedYieldQty",
    ]),
    rows(`${S4}.ProductionOrderComponent`, [
      "Reservation",
      "ReservationItem",
      "ManufacturingOrder",
      "Material",
      "Plant",
      "MatlCompRequirementDate",
      "RequiredQuantity",
      "WithdrawnQuantity",
    ]),
    rows(`${S4}.PlannedOrder`, [
      "PlannedOrder",
      "Material",
      "Product",
      "ProductionPlant",
      "MRPPlant",
      "TotalQuantity",
      "PlndOrderPlannedEndDate",
    ]),
    rows(`${S4}.PlannedOrderComponent`, [
      "PlannedOrder",
      "ReservationItem",
      "Material",
      "Plant",
      "RequiredQuantity",
      "MatlCompRequirementDate",
    ]),
    rows(`${S4}.PlannedIndepRqmtItem`, [
      "Product",
      "Plant",
      "PlndIndepRqmtVersion",
      "PlndIndepRqmtInternalID",
      "PlannedQuantity",
      "WorkingDayDate",
    ]),
    rows(`${S4}.SalesOrderItem`, [
      "SalesOrder",
      "SalesOrderItem",
      "Product",
      "Plant",
      "RequestedDeliveryDate",
      "ConfirmedDeliveryDate",
      "RequestedQuantity",
      "ConfdDelivQtyInOrderQtyUnit",
      "NetAmount",
      "TransactionCurrency",
      "DeliveryStatus",
      "SalesOrderItemCategory",
    ]),
    rows(`${S4}.SalesOrder`, ["SalesOrder", "SoldToParty", "SalesOrderDate"]),
    rows(`${S4}.Customer`, ["Customer", "CustomerName"]),
    rows(`${S4}.PurchaseOrderAccountAssignment`, [
      "PurchaseOrder",
      "PurchaseOrderItem",
      "SalesOrder",
      "SalesOrderItem",
      "IsDeleted",
    ]),
    fx(),
  ]);
  const head = new Map(salesHeads.map((h) => [String(h.SalesOrder), h]));
  return {
    asOf,
    openItems: open,
    poItems: open.map((o) => ({
      PurchaseOrder: o.PurchaseOrder,
      PurchaseOrderItem: o.PurchaseOrderItem,
      Material: o.Material,
      AccountAssignmentCategory: o.AccountAssignmentCategory,
      PurchaseOrderItemCategory: o.PurchaseOrderItemCategory,
    })),
    stock,
    productionOrders,
    components,
    plannedOrders,
    plannedComponents,
    independent,
    salesItems: salesItems.map((s) => ({
      ...s,
      SoldToParty: head.get(String(s.SalesOrder))?.SoldToParty ?? null,
      SalesOrderDate: head.get(String(s.SalesOrder))?.SalesOrderDate ?? null,
    })),
    customers,
    assignments: assignments.filter((a) => a.SalesOrder && !a.IsDeleted),
    fx: fxMap,
  };
}

export interface ArrivalInputs {
  grid: Map<string, { grid: Array<[number, number]>; source: string | null }>;
  confirmation: Map<string, { date: string; quantity: number | null }>;
}

/**
 * The line grid stores forecast arrival dates as well as lead-time days. Prefer
 * those dates when present: they remain the current forecast if an order date
 * was corrected after the grid was created.
 */
function datedGrid(row: R, item: R) {
  const poDate = item.PurchaseOrderDate
    ? String(item.PurchaseOrderDate).slice(0, 10)
    : null;
  if (poDate) {
    const points = [
      [0.1, row.arrivalP10],
      [0.5, row.arrivalP50],
      [0.8, row.arrivalP80],
      [0.9, row.arrivalP90],
    ]
      .map(
        ([level, date]) =>
          [level, date ? days(poDate, String(date).slice(0, 10)) : NaN] as [
            number,
            number,
          ],
      )
      .filter(([, leadTime]) => Number.isFinite(leadTime));
    if (points.length) return points;
  }
  return parseGrid(row.openLevels) ?? parseGrid(row.levels);
}

/** Grid per item (LineGrid conditioned on "still open", else its plain grid, else SourceRange of the key) and the latest confirmation line. */
export async function arrivalInputs(open: R[]): Promise<ArrivalInputs> {
  const grid = new Map<
    string,
    { grid: Array<[number, number]>; source: string | null }
  >();
  const lg = await rows(`${NS}.LineGrid`, [
    "PurchaseOrder",
    "PurchaseOrderItem",
    "levels",
    "source",
    "openLevels",
    "openSource",
    "arrivalP10",
    "arrivalP50",
    "arrivalP80",
    "arrivalP90",
  ]);
  const openByKey = new Map(
    open.map((item) => [
      `${item.PurchaseOrder}/${item.PurchaseOrderItem}`,
      item,
    ]),
  );
  for (const g of lg) {
    const item = openByKey.get(`${g.PurchaseOrder}/${g.PurchaseOrderItem}`);
    const pts = item
      ? datedGrid(g, item)
      : (parseGrid(g.openLevels) ?? parseGrid(g.levels));
    if (pts)
      grid.set(`${g.PurchaseOrder}/${g.PurchaseOrderItem}`, {
        grid: pts,
        source: (g.openLevels ? g.openSource : g.source) ?? null,
      });
  }
  const missing = open.filter(
    (o) => !grid.has(`${o.PurchaseOrder}/${o.PurchaseOrderItem}`),
  );
  if (missing.length) {
    const sr = await rows(`${NS}.SourceRange`, [
      "Material",
      "Supplier",
      "Plant",
      "quantiles",
      "source",
    ]);
    const byKey = new Map(
      sr.map((r) => [`${r.Material}|${r.Supplier}|${r.Plant}`, r]),
    );
    for (const o of missing) {
      const r = byKey.get(`${o.Material}|${o.Supplier}|${o.Plant}`);
      const pts = parseGrid(r?.quantiles);
      if (pts)
        grid.set(`${o.PurchaseOrder}/${o.PurchaseOrderItem}`, {
          grid: pts,
          source: r?.source ?? null,
        });
    }
  }
  const confirmation = new Map<
    string,
    { date: string; quantity: number | null }
  >();
  const conf = await rows(`${NS}.Confirmation`, [
    "PurchaseOrder",
    "PurchaseOrderItem",
    "line",
    "date",
    "quantity",
  ]);
  conf.sort((a, b) => Number(a.line) - Number(b.line));
  for (const c of conf)
    if (c.date)
      confirmation.set(`${c.PurchaseOrder}/${c.PurchaseOrderItem}`, {
        date: String(c.date).slice(0, 10),
        quantity: c.quantity ?? null,
      });
  return { grid, confirmation };
}

export function toImpactItem(o: R): ImpactItem {
  return {
    PurchaseOrder: String(o.PurchaseOrder),
    PurchaseOrderItem: String(o.PurchaseOrderItem),
    Material: o.Material ?? null,
    Plant: String(o.Plant ?? ""),
    PurchaseOrderDate: String(o.PurchaseOrderDate).slice(0, 10),
    RequestedDate: o.RequestedDate
      ? String(o.RequestedDate).slice(0, 10)
      : null,
    OpenQuantity: o.OpenQuantity ?? null,
    MaterialType: o.MaterialType ?? null,
  };
}
