// Pure planning logic (P-7): no CDS, runs with `node --import tsx --test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GRID,
  NO_SOURCE_WARNING,
  PlanningInputError,
  buildPlan,
  counts,
  dailyDemand,
  defaultNeedDate,
  defaultSupplier,
  earliestDelivery,
  gridValues,
  latestOrderDate,
  maintainedDays,
  monotone,
  orderQuantity,
  safetyDays,
  sapView,
  unitPrice,
  validate,
  type PoRow,
} from "../srv/cockpit/planning/domain/logic";

const AS_OF = "2025-11-03";
const known = { plantKnown: true, materialKnown: true, materialInPlant: true, supplierKnown: true, pairHasSource: true };
const input = { Material: "M1", Plant: "1010", Supplier: "S1" };

test("validation: unknown plant, material, material not in plant, supplier are 400", () => {
  const cases: [Partial<typeof known>, RegExp][] = [
    [{ plantKnown: false }, /Unknown plant 1010/],
    [{ materialKnown: false }, /Unknown material M1/],
    [{ materialInPlant: false }, /not maintained in plant 1010/],
    [{ supplierKnown: false }, /Unknown supplier S1/],
  ];
  for (const [f, msg] of cases) {
    assert.throws(
      () => validate({ ...known, ...f }, input),
      (e: any) => e instanceof PlanningInputError && e.status === 400 && msg.test(e.message),
    );
  }
});

test("validation: known pair without PO and info record only warns; no supplier skips supplier checks", () => {
  assert.deepEqual(validate({ ...known, pairHasSource: false }, input), [NO_SOURCE_WARNING]);
  assert.deepEqual(validate(known, input), []);
  assert.deepEqual(validate({ ...known, supplierKnown: false }, { ...input, Supplier: null }), []);
});

test("default supplier: latest PO, else latest info record", () => {
  const pos = [
    { PurchaseOrder: "4500000002", PurchaseOrderDate: "2025-05-01", Supplier: "B" },
    { PurchaseOrder: "4500000001", PurchaseOrderDate: "2025-06-01", Supplier: "A" },
  ];
  assert.deepEqual(defaultSupplier(pos, [{ Supplier: "Z", PurchasingDocumentDate: "2025-10-01" }]), {
    supplier: "A",
    from: "latest order",
  });
  const irs = [
    { Supplier: "X", PurchasingDocumentDate: "2025-03-01" },
    { Supplier: "Y", PurchasingDocumentDate: null },
  ];
  assert.deepEqual(defaultSupplier([], irs), { supplier: "X", from: "latest info record" });
  assert.deepEqual(defaultSupplier([], []), { supplier: null, from: null });
});

test("maintained value: latest info record if > 0, else material master", () => {
  assert.deepEqual(
    maintainedDays([{ Supplier: "S", MaterialPlannedDeliveryDurn: 14, PurchasingDocumentDate: "2026-01-01", PurchasingInfoRecord: "5300000099" }], 30),
    {
      days: 14,
      from: "info record",
      since: "2026-01-01",
      infoRecord: "5300000099",
    },
  );
  assert.deepEqual(maintainedDays([{ Supplier: "S", MaterialPlannedDeliveryDurn: 0 }], 30), {
    days: 30,
    from: "material master",
    since: null,
    infoRecord: null,
  });
  assert.deepEqual(maintainedDays([], null), { days: null, from: "material master", since: null, infoRecord: null });
});

test("need date: requirement, else requested, else as-of + 56", () => {
  assert.equal(defaultNeedDate("2026-01-10", "2026-01-20", AS_OF), "2026-01-10");
  assert.equal(defaultNeedDate(null, "2026-01-20", AS_OF), "2026-01-20");
  assert.equal(defaultNeedDate(null, null, AS_OF), "2025-12-29");
});

test("grid: picks 11 points from the 19 levels, monotone and >= 0", () => {
  const levels: Record<string, number> = {};
  for (let i = 1; i <= 19; i++) levels[(i * 0.05).toFixed(2)] = i - 3; // negative at the bottom
  levels["0.60"] = 1; // a dip
  const g = gridValues(JSON.stringify(levels))!;
  assert.equal(g.length, GRID.length);
  assert.equal(g[0], 0);
  for (let i = 1; i < g.length; i++) assert.ok(g[i] >= g[i - 1]);
  assert.equal(g[GRID.indexOf(0.85)], 14);
  assert.equal(gridValues(null), null);
  assert.deepEqual(monotone([-3, 5, 4, 9.126]), [0, 5, 5, 9.13]);
});

test("dates: latest order = need - ceil(q), earliest = as-of + ceil(q)", () => {
  assert.equal(latestOrderDate("2026-01-26", 17.2), "2026-01-08");
  assert.equal(earliestDelivery(AS_OF, 17), "2025-11-20");
});

test("SAP view: days too late against the median date", () => {
  const latest50 = latestOrderDate("2026-01-26", 30);
  assert.deepEqual(sapView("2026-01-26", 2, latest50), { sapOrderDate: "2026-01-24", sapLateDays: 28 });
  assert.equal(sapView("2026-01-26", 45, latest50).sapLateDays, 0);
  assert.deepEqual(sapView("2026-01-26", null, latest50), { sapOrderDate: null, sapLateDays: null });
});

test("buffer days and counts", () => {
  assert.deepEqual(safetyDays([10, 17, 24], 17), [0, 0, 7]);
  assert.deepEqual(counts([5, 10, 10, 20, 40], [10, 20]), { of: 5, within: [3, 4] });
});

const issue = (PostingDate: string, quantity: number, type = "261", unit = "PC") => ({
  PostingDate,
  GoodsMovementType: type,
  quantity,
  unit,
});

test("daily demand: goods issues of the 365 days before as-of, one unit", () => {
  const d = dailyDemand(
    [issue("2024-10-01", 999), issue("2025-01-15", 200), issue("2025-11-02", 165, "601"), issue("2025-11-03", 999), issue("2025-05-01", 500, "101")],
    AS_OF,
  );
  assert.equal(d.daily, 1);
  assert.equal(d.unit, "PC");
  assert.equal(d.issues, 2);
  assert.equal(dailyDemand([], AS_OF).daily, null);
  assert.equal(dailyDemand([issue("2025-05-01", 1), issue("2025-05-02", 1, "201", "KG")], AS_OF).daily, null);
});

const po = (i: number, amount: number, per = 1, unit = "PC", cur = "EUR"): PoRow => ({
  PurchaseOrder: String(4500000000 + i),
  PurchaseOrderItem: "10",
  PurchaseOrderDate: `2025-0${i + 1}-01`,
  Supplier: "S",
  PurchaseOrderQuantityUnit: unit,
  NetPriceAmount: amount,
  NetPriceQuantity: per,
  DocumentCurrency: cur,
  OrderQuantity: 10 * (i + 1),
});

test("unit price: median of the last 3 in the unit, latest currency", () => {
  assert.deepEqual(unitPrice([po(0, 10), po(1, 11), po(2, 12), po(3, 1.2)], "PC"), {
    unitPrice: 11,
    currency: "EUR",
    reason: null,
  });
  assert.equal(unitPrice([po(0, 50, 100)], "PC").unitPrice, 0.5);
  assert.equal(unitPrice([po(0, 10, 1, "PAK")], "PC").unitPrice, null);
  const mixed = unitPrice([po(0, 10), po(1, 20, 1, "PC", "USD"), po(2, 30, 1, "PC", "CHF")], "PC");
  assert.deepEqual([mixed.unitPrice, mixed.currency], [30, "CHF"]);
  assert.equal(orderQuantity([po(0, 1), po(1, 1), po(2, 1)]), 20);
  assert.equal(orderQuantity([]), 1);
});

function levels(values: number[]) {
  return JSON.stringify(Object.fromEntries(values.map((v, i) => [((i + 1) * 0.05).toFixed(2), v])));
}

const base = {
  Material: "M1",
  Plant: "1010",
  Supplier: "S1",
  supplierFrom: "entered",
  needDate: "2025-12-15",
  asOf: AS_OF,
  warnings: [],
  maintained: { days: 5, from: "info record" },
  demand: { daily: 2, unit: "PC" },
  price: { unitPrice: 3, currency: "EUR" },
};
const nineteen = Array.from({ length: 19 }, (_, i) => 20 + i * 2); // p50 = 38

test("plan: own history has counts; dates, reachable, safety stock", () => {
  const history = Array.from({ length: 25 }, (_, i) => 20 + i * 1.5);
  const r = buildPlan({ ...base, range: { source: "empirical", n: 25, levels: levels(nineteen) }, history });
  assert.equal(r.rows.length, GRID.length);
  const p50 = r.rows[GRID.indexOf(0.5)];
  const p80 = r.rows[GRID.indexOf(0.8)];
  assert.equal(p50.leadTimeDays, 38);
  assert.equal(p50.latestOrderDate, "2025-11-07");
  assert.equal(p50.reachable, true);
  assert.equal(p80.leadTimeDays, 50);
  assert.equal(p80.latestOrderDate, "2025-10-26");
  assert.equal(p80.earliestDelivery, "2025-12-23");
  assert.equal(p80.reachable, false);
  assert.equal(p80.safetyDays, 12);
  assert.equal(p80.safetyStock, 24);
  assert.equal(p80.safetyStockValue, 72);
  assert.equal(p80.of, 25);
  assert.equal(p80.within, history.filter((h) => h <= 50).length);
  assert.equal(r.sapOrderDate, "2025-12-10");
  assert.equal(r.sapLateDays, 33);
  assert.equal(r.n, 25);
});

test("plan: AI estimate has no counts and names a coarse context", () => {
  const r = buildPlan({
    ...base,
    range: { source: "tabpfn", contextLevel: "supplier within plant", contextRows: 47, levels: levels(nineteen) },
    history: [10, 12],
    demand: { daily: null, unit: null },
    price: { unitPrice: null, currency: null },
  });
  assert.ok(r.rows.every((x) => x.within === null && x.of === null && x.safetyStock === null));
  assert.match(r.warnings.join(), /n = 47/);
  assert.equal(r.n, 47);
});

test("plan: price estimate remains available without consumption history", () => {
  const r = buildPlan({
    ...base,
    range: { source: "tabpfn", contextRows: 20, levels: levels(nineteen) },
    history: [], demand: { daily: null, unit: null },
    price: { p10: 8, p50: 10, p90: 13, historicalReference: 9, historicalCount: 6, source: "tabpfn", assumedQuantity: 20, assumedUnit: "PC", assumedCurrency: "EUR" },
  });
  assert.deepEqual([r.priceP10, r.priceP50, r.priceP90, r.unitPrice, r.priceSource], [8, 10, 13, 10, "tabpfn"]);
  assert.equal(r.rows[GRID.indexOf(0.8)].safetyStockValue, null);
});

test("plan: safety-stock valuation requires a price assumption in the demand unit", () => {
  const r = buildPlan({
    ...base,
    range: { source: "empirical", n: 25, levels: levels(nineteen) }, history: [],
    price: { p50: 10, source: "tabpfn", assumedUnit: "BOX", assumedCurrency: "EUR" },
  });
  assert.equal(r.rows[GRID.indexOf(0.8)].safetyStockValue, null);
});

test("plan: no range gives no rows and a warning", () => {
  const r = buildPlan({ ...base, range: null, history: [] });
  assert.deepEqual(r.rows, []);
  assert.equal(r.sapOrderDate, "2025-12-10");
  assert.equal(r.warnings.length, 1);
});

test("plan: feasible when even the 50% scenario still meets the need date", () => {
  const r = buildPlan({ ...base, range: { source: "empirical", n: 25, levels: levels(nineteen) }, history: [] });
  // needDate 2025-12-15, p50 lead time 38 days -> latest order 2025-11-07, after as-of (2025-11-03): feasible.
  assert.equal(r.feasible, true);
  const values = gridValues(levels(nineteen))!;
  const expected = earliestDelivery(AS_OF, values[GRID.indexOf(0.8)]);
  assert.equal(r.earliestAchievableDate, expected);
});

test("plan: not feasible when the 50% scenario's order date is already in the past", () => {
  const r = buildPlan({
    ...base,
    needDate: "2025-11-05", // only 2 days from as-of; p50 lead time is 38 days
    range: { source: "empirical", n: 25, levels: levels(nineteen) },
    history: [],
  });
  assert.equal(r.feasible, false);
});

test("plan: master-data verdict flags SAP's planned delivery time as too short", () => {
  // base.maintained.days = 5; the range's typical (p50) lead time is 38 days.
  const r = buildPlan({ ...base, range: { source: "empirical", n: 25, levels: levels(nineteen) }, history: [] });
  assert.ok(r.masterData);
  assert.equal(r.masterData!.direction, "too_short");
  assert.equal(r.masterData!.typicalDays, 38);
  assert.equal(r.masterData!.gapDays, 33);
});

test("plan: master-data verdict is plausible within tolerance, null without a range", () => {
  const close = buildPlan({
    ...base,
    maintained: { days: 37, from: "material master" },
    range: { source: "empirical", n: 25, levels: levels(nineteen) },
    history: [],
  });
  assert.equal(close.masterData!.direction, "plausible");
  const noRange = buildPlan({ ...base, range: null, history: [] });
  assert.equal(noRange.masterData, null);
});
