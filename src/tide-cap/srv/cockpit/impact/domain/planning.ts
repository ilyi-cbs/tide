// Builds the planning input of the impact calculation from S/4-shaped rows
// (API names as loaded into tide.s4). Pure: the caller selects the rows.
//
// Plant segment only: third-party (TAS) and make-to-order (TAK) sales order
// items, production orders of a sales order, and PO items bound to a sales
// order belong to the make-to-order chain and are left out.

import type { MaterialPlan, MrpElement, MtoLink, Planning, SalesOrderInfo } from "./impact";
import { CAT } from "./impact";

export type R = Record<string, any>;

export interface PlanningRows {
  asOf: string;
  /** Open PO items at the as-of day (OpenItem rows or equivalent). */
  openItems: R[];
  stock?: R[]; // A_MatlStkInAcctMod
  productionOrders?: R[]; // A_ProductionOrder_2
  components?: R[]; // A_ProductionOrderComponent_2
  plannedOrders?: R[]; // A_PlannedOrder (optional)
  plannedComponents?: R[]; // planned order components (optional)
  independent?: R[]; // planned independent requirements (optional)
  salesItems?: R[]; // SalesOrderItem, joined with header fields SoldToParty, SalesOrderDate if present
  customers?: R[]; // Customer / CustomerName
  assignments?: R[]; // PurchaseOrderAccountAssignment
  poItems?: R[]; // PurchaseOrderItem: AccountAssignmentCategory, PurchaseOrderItemCategory
  fx?: Map<string, number>; // currency -> EUR factor
}

const nz = (s: unknown) => String(s ?? "").replace(/^0+(?=.)/, "");
const soKey = (so: unknown, it: unknown) => `${nz(so)}/${nz(it)}`;
const d10 = (v: unknown) => (v ? String(v).slice(0, 10) : null);
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const mpKey = (m: unknown, p: unknown) => `${m}|${p}`;

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  (m.get(k) ?? m.set(k, []).get(k)!).push(v);
}

/** Sales order items that belong to the make-to-order chain, not the plant segment. */
const MTO_SO_CATEGORIES = new Set(["TAS", "TAK"]);

export interface BuiltPlanning extends Planning {
  mtoLink(po: string, item: string, material: string | null): MtoLink | null;
  mtoLinks(po: string, item: string, material: string | null): MtoLink[];
  /** Keys `material|plant` that have any plant segment element. */
  materialsOf(plant: string): string[];
}

export function eurAmount(
  value: unknown,
  currency: unknown,
  rates: ReadonlyMap<string, number>,
): number | null {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !value.trim()) ||
    typeof currency !== "string" ||
    !currency.trim()
  ) return null;
  const amount = Number(value);
  const factor = currency === "EUR" ? 1 : rates.get(currency);
  if (!Number.isFinite(amount) || factor == null || !Number.isFinite(factor) || factor <= 0) return null;
  const converted = amount * factor;
  const rounded = Math.round(converted * 100) / 100;
  return Number.isFinite(rounded) ? rounded : null;
}

export function buildPlanning(rows: PlanningRows): BuiltPlanning {
  const asOf = rows.asOf;
  const fx = rows.fx ?? new Map([["EUR", 1]]);
  const customers = new Map((rows.customers ?? []).map((c) => [String(c.Customer), c.CustomerName ?? null]));

  // --- MTO links: PO item -> sales order item
  const poCat = new Map((rows.poItems ?? []).map((p) => [`${p.PurchaseOrder}/${nz(p.PurchaseOrderItem)}`, p]));
  const soOf = new Map<string, Array<{ so: string; item: string; assignment: "E" | "third_party" }>>();
  for (const a of rows.assignments ?? []) {
    if (!a.SalesOrder) continue;
    const k = `${a.PurchaseOrder}/${nz(a.PurchaseOrderItem)}`;
    const p = poCat.get(k);
    const cat = String(p?.AccountAssignmentCategory ?? a.AccountAssignmentCategory ?? "");
    const itemCat = String(p?.PurchaseOrderItemCategory ?? "");
    const assignment = cat === "E" ? "E" : itemCat === "5" ? "third_party" : null;
    if (!assignment && p) continue;
    (soOf.get(k) ?? soOf.set(k, []).get(k)!).push({ so: String(a.SalesOrder), item: String(a.SalesOrderItem), assignment: assignment ?? "E" });
  }

  // --- sales orders
  const soInfo = new Map<string, SalesOrderInfo>();
  const vcByMp = new Map<string, MrpElement[]>();
  for (const s of rows.salesItems ?? []) {
    const key = soKey(s.SalesOrder, s.SalesOrderItem);
    const customer = s.SoldToParty ?? s.Customer ?? null;
    const netAmount = eurAmount(s.NetAmount, s.TransactionCurrency ?? s.Currency, fx);
    soInfo.set(key, {
      salesOrder: String(s.SalesOrder),
      salesOrderItem: String(s.SalesOrderItem),
      customer,
      customerName: s.CustomerName ?? (customer ? (customers.get(String(customer)) ?? null) : null),
      netAmount,
      currency: netAmount == null ? null : "EUR",
      customerDate: d10(s.ConfirmedDeliveryDate) ?? d10(s.RequestedDeliveryDate),
    });
    if (s.DeliveryStatus === "C") continue;
    if (MTO_SO_CATEGORIES.has(String(s.SalesOrderItemCategory ?? ""))) continue;
    const created = d10(s.SalesOrderDate);
    if (created && created >= asOf) continue;
    const qty = num(s.ConfdDelivQtyInOrderQtyUnit) || num(s.RequestedQuantity);
    if (qty <= 0) continue;
    push(vcByMp, mpKey(s.Product ?? s.Material, s.Plant), {
      category: CAT.salesOrder,
      id: String(s.SalesOrder),
      item: String(s.SalesOrderItem),
      date: d10(s.RequestedDeliveryDate) ?? asOf,
      qty: -qty,
      salesOrder: String(s.SalesOrder),
      salesOrderItem: String(s.SalesOrderItem),
    });
  }

  // --- production orders
  const prodByOrder = new Map<string, R>();
  const prodBySo = new Map<string, R>();
  const feByMp = new Map<string, MrpElement[]>();
  for (const o of rows.productionOrders ?? []) {
    prodByOrder.set(String(o.ManufacturingOrder), o);
    if (o.SalesOrder) {
      prodBySo.set(soKey(o.SalesOrder, o.SalesOrderItem), o);
      continue;
    }
    const end = d10(o.MfgOrderPlannedEndDate ?? o.MfgOrderScheduledEndDate);
    const start = d10(o.MfgOrderPlannedStartDate);
    if (!end || end < asOf || (start && start >= asOf && o.OrderIsReleased !== "X" && o.OrderIsCreated !== "X")) continue;
    const qty = num(o.TotalQuantity) - num(o.MfgOrderConfirmedYieldQty ?? o.ActualDeliveredQuantity);
    if (qty <= 0) continue;
    push(feByMp, mpKey(o.Material, o.ProductionPlant), {
      category: CAT.productionOrder,
      id: String(o.ManufacturingOrder),
      item: "1",
      date: end,
      qty,
    });
  }

  // --- components (reservations AR). A component bought for the order's
  // own sales order (account assignment E) sits in the sales order segment.
  const matOfPo = new Map<string, string>();
  for (const p of [...(rows.poItems ?? []), ...rows.openItems]) if (p.Material) matOfPo.set(`${p.PurchaseOrder}/${nz(p.PurchaseOrderItem)}`, String(p.Material));
  const segmentE = new Set<string>();
  for (const [k, links] of soOf) for (const s of links) {
    const m = matOfPo.get(k);
    if (m) segmentE.add(`${soKey(s.so, s.item)}|${m}`);
  }
  const arByMp = new Map<string, MrpElement[]>();
  const compByOrderMat = new Map<string, R>();
  for (const c of rows.components ?? []) {
    compByOrderMat.set(`${c.ManufacturingOrder}|${c.Material}`, c);
    const po = prodByOrder.get(String(c.ManufacturingOrder));
    if (po?.SalesOrder && segmentE.has(`${soKey(po.SalesOrder, po.SalesOrderItem)}|${c.Material}`)) continue;
    const open = num(c.RequiredQuantity) - num(c.WithdrawnQuantity);
    if (open <= 0) continue;
    push(arByMp, mpKey(c.Material, c.Plant), {
      category: CAT.reservation,
      id: String(c.Reservation),
      item: String(c.ReservationItem),
      date: d10(c.MatlCompRequirementDate) ?? asOf,
      qty: -open,
      productionOrder: String(c.ManufacturingOrder),
    });
  }

  // --- planned orders and their dependent requirements (optional)
  const paByMp = new Map<string, MrpElement[]>();
  for (const p of rows.plannedOrders ?? []) {
    const qty = num(p.TotalQuantity ?? p.PlannedTotalQtyInBaseUnit);
    if (qty <= 0) continue;
    push(paByMp, mpKey(p.Material ?? p.Product, p.ProductionPlant ?? p.MRPPlant ?? p.Plant), {
      category: CAT.plannedOrder,
      id: String(p.PlannedOrder),
      item: "1",
      date: d10(p.PlndOrderPlannedEndDate ?? p.PlannedOrderEndDate) ?? asOf,
      qty,
    });
  }
  for (const c of rows.plannedComponents ?? []) {
    const qty = num(c.RequiredQuantity ?? c.RequirementQuantity);
    if (qty <= 0) continue;
    push(paByMp, mpKey(c.Material, c.Plant), {
      category: CAT.dependent,
      id: String(c.PlannedOrder),
      item: String(c.ReservationItem ?? c.BOMItem ?? "1"),
      date: d10(c.MatlCompRequirementDate ?? c.RequirementDate) ?? asOf,
      qty: -qty,
    });
  }
  for (const p of rows.independent ?? []) {
    const qty = num(p.PlannedQuantity ?? p.RequirementQuantity);
    if (qty <= 0) continue;
    push(paByMp, mpKey(p.Product ?? p.Material, p.Plant), {
      category: CAT.independent,
      id: String(p.PlndIndepRqmtVersion ?? p.RequirementPlan ?? "PIR"),
      item: String(p.PlndIndepRqmtInternalID ?? "1"),
      date: d10(p.WorkingDayDate ?? p.PeriodStartDate) ?? asOf,
      qty: -qty,
    });
  }

  // --- open PO receipts (plant segment only)
  const beByMp = new Map<string, MrpElement[]>();
  for (const o of rows.openItems) {
    const k = `${o.PurchaseOrder}/${o.PurchaseOrderItem}`;
    if (soOf.has(k) || !o.Material) continue;
    const qty = num(o.OpenQuantity);
    if (qty <= 0) continue;
    push(beByMp, mpKey(o.Material, o.Plant), {
      category: CAT.poItem,
      id: String(o.PurchaseOrder),
      item: String(o.PurchaseOrderItem),
      date: d10(o.RequestedDate ?? o.ScheduleLineDeliveryDate) ?? asOf,
      qty,
    });
  }

  // --- stock: unrestricted, no special stock
  const stock = new Map<string, number>();
  for (const s of rows.stock ?? []) {
    if (s.InventoryStockType && s.InventoryStockType !== "01") continue;
    if (s.InventorySpecialStockType) continue;
    const k = mpKey(s.Material, s.Plant);
    stock.set(k, (stock.get(k) ?? 0) + num(s.MatlWrhsStkQtyInMatlBaseUnit));
  }

  const cache = new Map<string, MaterialPlan>();
  const planOf = (material: string, plant: string): MaterialPlan => {
    const k = mpKey(material, plant);
    let p = cache.get(k);
    if (!p) {
      p = {
        stock: stock.get(k) ?? 0,
        elements: [
          ...(beByMp.get(k) ?? []),
          ...(feByMp.get(k) ?? []),
          ...(paByMp.get(k) ?? []),
          ...(arByMp.get(k) ?? []),
          ...(vcByMp.get(k) ?? []),
        ],
      };
      cache.set(k, p);
    }
    return p;
  };

  return {
    asOf,
    plan: planOf,
    salesOrder: (so, it) => soInfo.get(soKey(so, it)),
    mtoLinks(po, item, material) {
      const links = soOf.get(`${po}/${item}`) ?? [];
      const out: MtoLink[] = [];
      for (const s of links) {
        const order = soInfo.get(soKey(s.so, s.item));
        if (!order) continue;
        const prod = prodBySo.get(soKey(s.so, s.item));
        const comp = prod && material ? compByOrderMat.get(`${prod.ManufacturingOrder}|${material}`) : undefined;
        out.push({ assignment: s.assignment, order, productionOrder: prod ? { order: String(prod.ManufacturingOrder), product: prod.Material ?? null, end: d10(prod.MfgOrderPlannedEndDate ?? prod.MfgOrderScheduledEndDate) } : undefined, component: comp ? { reservation: String(comp.Reservation), item: String(comp.ReservationItem), date: d10(comp.MatlCompRequirementDate) ?? order.customerDate ?? asOf, qty: num(comp.RequiredQuantity) - num(comp.WithdrawnQuantity) || num(comp.RequiredQuantity) } : undefined });
      }
      return out;
    },
    mtoLink(po, item, material) {
      return this.mtoLinks(po, item, material)[0] ?? null;
    },
    materialsOf(p: string) {
      const out = new Set<string>();
      for (const m of [beByMp, feByMp, paByMp, arByMp, vcByMp]) for (const k of m.keys()) if (k.endsWith(`|${p}`)) out.add(k.split("|")[0]);
      return [...out];
    },
  };
}
