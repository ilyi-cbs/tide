import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  assess,
  compareImpact,
  itemImpact,
  MAKE_TO_ORDER_NOTE,
  NOTE,
  parseGrid,
  revenueTotal,
  SCENARIO_LEVELS,
  workingDays,
  type ImpactItem,
  type MrpElement,
  type MtoLink,
  type Planning,
  type SalesOrderInfo,
} from "../srv/cockpit/impact/domain/impact";
import { actionSummary, reminderText } from "../srv/cockpit/impact/domain/reminder";
import { buildPlanning } from "../srv/cockpit/impact/domain/planning";
import { deliveryPriority } from "../srv/cockpit/impact/domain/priority";

const D0 = "2025-12-01"; // a Monday
const d = (n: number) => addDays(D0, n);

const el = (category: string, id: string, item: string, date: string, qty: number, extra: Partial<MrpElement> = {}): MrpElement => ({
  category,
  id,
  item,
  date,
  qty,
  ...extra,
});

const so = (salesOrder: string, netAmount: number, customerDate: string): SalesOrderInfo => ({
  salesOrder,
  salesOrderItem: "10",
  customer: `C-${salesOrder}`,
  customerName: `Customer ${salesOrder}`,
  netAmount,
  currency: "EUR",
  customerDate,
});

function planning(plans: Record<string, { stock: number; elements: MrpElement[] }>, orders: SalesOrderInfo[] = []): Planning {
  return {
    asOf: D0,
    plan: (m: string) => plans[m] ?? { stock: 0, elements: [] },
    salesOrder: (s, i) => orders.find((o) => o.salesOrder === s && o.salesOrderItem === i),
  };
}

const item = (over: Partial<ImpactItem> = {}): ImpactItem => ({
  PurchaseOrder: "45",
  PurchaseOrderItem: "10",
  Material: "M1",
  Plant: "P1",
  PurchaseOrderDate: d(-20),
  RequestedDate: d(3),
  OpenQuantity: 4,
  MaterialType: "ROH",
  ...over,
});

const MTO: MtoLink = {
  assignment: "E",
  order: so("SO1", 7000, d(20)),
  productionOrder: { order: "MO1", product: "FP1", end: d(15) },
  component: { reservation: "R1", item: "1", date: d(5), qty: 4 },
};

test("make-to-order counts the delay against the component and the customer delay against the slack", () => {
  const pl = planning({});
  const cases: Array<[number, string, number, number, number]> = [
    [4, "no_impact", 0, 0, 0],
    [10, "production_affected", 5, 0, 0],
    [26, "customer_order_late", 21, 16, 7000],
  ];
  for (const [arrives, level, delay, customerDelay, revenue] of cases) {
    const r = itemImpact(pl, item({ mto: MTO }), d(arrives));
    assert.equal(r.materialKind, "make_to_order");
    assert.deepEqual([r.level, r.delayDays, r.customerDelayDays, r.revenueAtRisk], [level, delay, customerDelay, revenue]);
    assert.equal(r.chain?.slackDays, 5);
    assert.equal(r.chain?.productionOrder, "MO1");
    assert.equal(r.md04.some((x) => x.affected), delay > 0);
  }
});

test("make-to-order without a production order needs the customer date", () => {
  const link: MtoLink = { assignment: "third_party", order: so("SO7", 500, d(8)) };
  const r = itemImpact(planning({}), item({ mto: link }), d(10));
  assert.equal(r.needDate, d(8));
  assert.equal(r.level, "customer_order_late");
  assert.equal(r.revenueAtRisk, 500);
  assert.equal(r.customerDelayDays, 2);
});

test("an empty make-to-order link list falls back to the plant-segment calculation", () => {
  const r = itemImpact(trading(), hawa({ mto: [] }), d(7));
  assert.equal(r.materialKind, "trading_goods");
  assert.equal(r.level, "customer_order_late");
  assert.deepEqual(r.salesOrders.map((order) => order.salesOrder), ["SO2"]);
});

test("multiple make-to-order links aggregate affected customer revenue and production orders", () => {
  const links: MtoLink[] = [
    {
      assignment: "E",
      order: so("SO1", 7000, d(20)),
      productionOrder: { order: "MO1", product: "FP1", end: d(15) },
      component: { reservation: "R1", item: "1", date: d(5), qty: 2 },
    },
    {
      assignment: "E",
      order: so("SO2", 9000, d(18)),
      productionOrder: { order: "MO2", product: "FP2", end: d(14) },
      component: { reservation: "R2", item: "1", date: d(4), qty: 2 },
    },
  ];
  const result = itemImpact(planning({}), item({ mto: links }), d(26));
  assert.equal(result.level, "customer_order_late");
  assert.equal(result.revenueAtRisk, 16000);
  assert.deepEqual(result.salesOrders.map((order) => order.salesOrder), ["SO1", "SO2"]);
  assert.deepEqual(result.productionOrders.sort(), ["MO1", "MO2"]);
  assert.deepEqual(result.chain?.affectedSalesOrders, ["SO1/10", "SO2/10"]);
});

test("customer-order risk becomes high when the component need is more than three days away", () => {
  assert.equal(deliveryPriority("customer_order_late", d(3), D0, null), "Critical");
  assert.equal(deliveryPriority("customer_order_late", d(4), D0, null), "High");
  assert.equal(deliveryPriority("customer_order_late", d(7), D0, null), "Medium");
  assert.equal(deliveryPriority("customer_order_late", d(9), D0, null), "Low");
});

function trading(stock = 10) {
  return planning(
    {
      H1: {
        stock,
        elements: [
          el("BE", "47", "10", d(3), 20, { line: "1" }),
          el("VC", "SO2", "10", d(5), -15),
          el("VC", "SO3", "10", d(9), -10),
          el("PP", "PIR1", "1", d(12), -1),
        ],
      },
    },
    [so("SO2", 800, d(5)), so("SO3", 300, d(9))],
  );
}
const hawa = (over: Partial<ImpactItem> = {}) => item({ PurchaseOrder: "47", Material: "H1", MaterialType: "HAWA", OpenQuantity: 20, ...over });

test("stock shortage with a sales order short: customer order late, window from first shortage to arrival", () => {
  const r = itemImpact(trading(), hawa(), d(7));
  assert.equal(r.materialKind, "trading_goods");
  assert.equal(r.level, "customer_order_late");
  assert.equal(r.shortageFrom, d(5));
  assert.equal(r.shortageDays, workingDays(d(5), d(7)));
  assert.deepEqual(r.salesOrders.map((o) => o.salesOrder), ["SO2"]);
  assert.equal(r.revenueAtRisk, 800);
  assert.equal(r.customerDelayDays, 2);
  const own = r.md04.filter((x) => x.own);
  assert.equal(own.length, 1);
  assert.equal(own[0].date, d(7));
  assert.ok(r.md04.find((x) => x.id === "SO2/10")?.affected);
  assert.ok(!r.md04.find((x) => x.id === "SO3/10")?.affected);
});

test("only sales orders made unfulfillable by this PO item's delay contribute revenue", () => {
  const plan = planning({ H1: { stock: 5, elements: [
    el("BE", "47", "10", d(3), 20),
    el("VC", "SO2", "10", d(2), -15), // already short with the original receipt
    el("VC", "SO3", "10", d(5), -10), // would have been covered on time
  ] } }, [so("SO2", 800, d(2)), so("SO3", 300, d(5))]);
  const result = itemImpact(plan, hawa(), d(7));
  assert.deepEqual(result.salesOrders.map((o) => o.salesOrder), ["SO3"]);
  assert.equal(result.revenueAtRisk, 300);
});

test("a sales order becoming short despite an earlier shortage is attributed only when the on-time receipt covers it", () => {
  const plan = planning({ H1: { stock: 5, elements: [
    el("BE", "47", "10", d(3), 25),
    el("VC", "SO2", "10", d(2), -15),
    el("VC", "SO3", "10", d(5), -10),
    el("VC", "SO4", "10", d(6), -5),
  ] } }, [so("SO2", 800, d(2)), so("SO3", 300, d(5)), so("SO4", 400, d(6))]);
  const result = itemImpact(plan, hawa(), d(7));
  assert.deepEqual(result.salesOrders.map((o) => o.salesOrder), ["SO3", "SO4"]);
  assert.equal(result.revenueAtRisk, 700);
});

test("reservation short: production affected, production orders listed", () => {
  const pl = planning({
    R1: {
      stock: 2,
      elements: [el("BE", "45", "10", d(3), 10, { line: "1" }), el("AR", "RS1", "1", d(6), -5, { productionOrder: "MO9" })],
    },
  });
  const r = itemImpact(pl, item({ Material: "R1" }), d(9));
  assert.equal(r.level, "production_affected");
  assert.deepEqual(r.productionOrders, ["MO9"]);
  assert.equal(r.revenueAtRisk, 0);
  assert.equal(r.materialKind, "make_to_stock");
});

test("other requirement short: stock uncovered, no revenue, coverage computed", () => {
  const pl = planning({ S1: { stock: 1, elements: [el("BE", "48", "10", d(3), 5), el("PP", "PIR1", "1", d(4), -2)] } });
  const r = itemImpact(pl, item({ PurchaseOrder: "48", Material: "S1", MaterialType: "ERSA" }), d(8));
  assert.deepEqual([r.materialKind, r.level, r.revenueAtRisk], ["spare_part", "stock_uncovered", 0]);
  assert.notEqual(r.coverageDays, null);
});

test("covered by stock and no requirement in the window", () => {
  assert.equal(itemImpact(trading(100), hawa(), d(7)).level, "covered_by_stock");
  assert.equal(itemImpact(trading(100), hawa(), d(3)).level, "no_impact");
});

test("non-stock kind", () => {
  const r = itemImpact(planning({}), item({ MaterialType: "NLAG" }), d(5));
  assert.equal(r.materialKind, "non_stock");
  assert.equal(r.level, "no_impact");
});

test("MD04 window: at most 30 rows, 15 before the own receipt", () => {
  const els: MrpElement[] = [];
  for (let i = 0; i < 60; i++) els.push(el("PP", `P${String(i).padStart(2, "0")}`, "1", d(i % 30), -1));
  els.push(el("BE", "45", "10", d(3), 5));
  const pl = planning({ M1: { stock: 100, elements: els } });
  const r = itemImpact(pl, item(), d(20));
  assert.equal(r.md04.length, 30);
  assert.equal(r.md04.findIndex((x) => x.own), 15);
  assert.equal(r.md04.filter((x) => x.own).length, 1);
});

const GRID = parseGrid({ "0.1": 5, "0.2": 10, "0.3": 15, "0.4": 20, "0.5": 25, "0.6": 30, "0.7": 35, "0.8": 40, "0.9": 45 })!;

test("cautious case at 0.8; a confirmation replaces the estimate and drops the cautious case", () => {
  const pl = trading();
  const r = assess(pl, hawa(), { grid: GRID });
  assert.equal(r.arrivalSource, "grid");
  assert.equal(r.expectedDate, d(5));
  assert.equal(r.cautiousDate, d(20));
  const c = assess(pl, hawa(), { grid: GRID, confirmation: { date: d(10) } });
  assert.equal(c.arrivalSource, "confirmation");
  assert.equal(c.expectedDate, d(10));
  assert.equal(c.cautiousDate, null);
  assert.equal(c.scenarios, null);
  assert.equal(c.confirmedDate, d(10));
  assert.equal(c.confirmedAfterNeed, true);
  const early = assess(pl, hawa(), { grid: GRID, confirmation: { date: d(3) } });
  assert.equal(early.level, "no_impact");
  assert.equal(c.level, "customer_order_late");
});

test("expected arrival is never before the as-of day", () => {
  const r = assess(trading(), hawa({ PurchaseOrderDate: d(-100) }), { grid: GRID });
  assert.equal(r.expectedDate, D0);
});

test("no grid and no confirmation: requested date with a note", () => {
  const r = assess(trading(), hawa(), {});
  assert.equal(r.arrivalSource, "requested");
  assert.equal(r.expectedDate, d(3));
  assert.match(r.note, /requested date/);
});

test("scenarios: 9 levels, monotone, only for make-to-order and trading goods", () => {
  const m = assess(planning({}), item({ mto: MTO }), { grid: GRID });
  const h = assess(trading(), hawa(), { grid: GRID });
  for (const res of [m, h]) {
    assert.deepEqual(res.scenarios!.map((s) => s.level), SCENARIO_LEVELS);
    const rev = res.scenarios!.map((scenario) => {
      assert.ok(scenario.revenue !== null);
      return scenario.revenue;
    });
    assert.deepEqual(rev, [...rev].sort((a, b) => a - b));
  }
  assert.deepEqual(new Set(m.scenarios!.map((s) => s.revenue)), new Set([0, 7000]));
  assert.equal(m.note, MAKE_TO_ORDER_NOTE);
  assert.equal(h.note, NOTE);
  const s = assess(planning({ M1: { stock: 0, elements: [] } }), item(), { grid: GRID });
  assert.equal(s.scenarios, null);
});

test("sort: severity, then revenue, production orders, shortage days, delay", () => {
  const rows = [
    { id: "a", rank: 3, revenueAtRisk: 0, delayDays: 9 },
    { id: "b", rank: 0, revenueAtRisk: 100 },
    { id: "c", rank: 0, revenueAtRisk: 900 },
    { id: "d", rank: 1, productionOrders: 1, shortageDays: 2 },
    { id: "e", rank: 1, productionOrders: 2, shortageDays: 1 },
    { id: "f", rank: 3, revenueAtRisk: 0, delayDays: 1 },
    { id: "g" },
  ];
  rows.sort(compareImpact);
  assert.deepEqual(rows.map((r) => r.id), ["c", "b", "e", "d", "a", "f", "g"]);
});

test("a sales order counts once in the revenue total", () => {
  const a = { salesOrders: [so("SO2", 800, d(5))] };
  const b = { salesOrders: [so("SO2", 800, d(5)), so("SO3", 300, d(9))] };
  assert.equal(revenueTotal([a, b, null]), 1100);
});

test("working days skip weekends", () => {
  assert.equal(workingDays(D0, d(7)), 5);
  assert.equal(workingDays(d(5), d(7)), 0); // Sat -> Mon
});

test("reminder text states the rule reason only, no revenue, no customer, no probability", () => {
  const it = { PurchaseOrder: "4500000001", PurchaseOrderItem: "10", Material: "M1", RequestedDate: "2026-10-01" };
  const r = reminderText(it, { kind: "overdue", daysOverdue: 12 });
  assert.match(r.body, /passed 12 days ago/);
  assert.doesNotMatch(r.body + r.subject, /EUR|revenue|customer|%|probab|likely/i);
  assert.match(actionSummary(it, { kind: "overdue", daysOverdue: 12 }, "Customer order at risk · 12,400 EUR"), /Customer order at risk · 12,400 EUR/);
});

test("planning from S/4 rows: plant segment only, MTO link via account assignment and production order", () => {
  const asOf = D0;
  const pl = buildPlanning({
    asOf,
    openItems: [
      { PurchaseOrder: "45", PurchaseOrderItem: "10", Material: "M1", Plant: "P1", OpenQuantity: 4, RequestedDate: d(3) },
      { PurchaseOrder: "46", PurchaseOrderItem: "10", Material: "M1", Plant: "P1", OpenQuantity: 10, RequestedDate: d(2) },
    ],
    poItems: [
      { PurchaseOrder: "45", PurchaseOrderItem: "10", AccountAssignmentCategory: "E", PurchaseOrderItemCategory: "0" },
      { PurchaseOrder: "46", PurchaseOrderItem: "10", AccountAssignmentCategory: "", PurchaseOrderItemCategory: "0" },
    ],
    assignments: [{ PurchaseOrder: "45", PurchaseOrderItem: "10", SalesOrder: "SO1", SalesOrderItem: "000010" }],
    salesItems: [
      { SalesOrder: "SO1", SalesOrderItem: "10", Product: "FP1", Plant: "P1", RequestedDeliveryDate: d(20), NetAmount: 7000, TransactionCurrency: "EUR", SalesOrderItemCategory: "TAK", DeliveryStatus: "A", RequestedQuantity: 1 },
      { SalesOrder: "SO2", SalesOrderItem: "10", Product: "M1", Plant: "P1", RequestedDeliveryDate: d(4), NetAmount: 100, TransactionCurrency: "USD", SalesOrderItemCategory: "TAN", DeliveryStatus: "A", RequestedQuantity: 3 },
    ],
    productionOrders: [
      { ManufacturingOrder: "MO1", Material: "FP1", ProductionPlant: "P1", MfgOrderPlannedEndDate: d(15), TotalQuantity: 1, SalesOrder: "SO1", SalesOrderItem: "000010" },
      { ManufacturingOrder: "MO9", Material: "FP2", ProductionPlant: "P1", MfgOrderPlannedEndDate: d(11), TotalQuantity: 2, SalesOrder: "", OrderIsReleased: "X" },
    ],
    components: [
      { Reservation: "R1", ReservationItem: "1", Material: "M1", Plant: "P1", ManufacturingOrder: "MO1", MatlCompRequirementDate: d(5), RequiredQuantity: 4, WithdrawnQuantity: 0 },
      { Reservation: "R9", ReservationItem: "1", Material: "M1", Plant: "P1", ManufacturingOrder: "MO9", MatlCompRequirementDate: d(6), RequiredQuantity: 10, WithdrawnQuantity: 0 },
    ],
    stock: [
      { Material: "M1", Plant: "P1", InventoryStockType: "01", InventorySpecialStockType: "", MatlWrhsStkQtyInMatlBaseUnit: 2 },
      { Material: "M1", Plant: "P1", InventoryStockType: "02", InventorySpecialStockType: "", MatlWrhsStkQtyInMatlBaseUnit: 50 },
    ],
    fx: new Map([["EUR", 1], ["USD", 0.5]]),
  });
  const plan = pl.plan("M1", "P1");
  assert.equal(plan.stock, 2);
  assert.deepEqual(plan.elements.map((e) => `${e.category}:${e.id}`).sort(), ["AR:R9", "BE:46", "VC:SO2"]);
  assert.equal(pl.salesOrder("SO2", "10")?.netAmount, 50);
  const link = pl.mtoLink("45", "10", "M1")!;
  assert.equal(link.assignment, "E");
  assert.equal(link.productionOrder?.order, "MO1");
  assert.equal(link.component?.date, d(5));
  assert.equal(pl.mtoLink("46", "10", "M1"), null);
  const mts = itemImpact(pl, item({ PurchaseOrder: "46", RequestedDate: d(2), OpenQuantity: 10 }), d(9));
  assert.equal(mts.level, "customer_order_late"); // SO2 short on d4 (stock 2 - 3 < 0)
  assert.equal(mts.revenueAtRisk, 50);
});
