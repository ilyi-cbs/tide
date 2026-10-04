// planOrder (P-7) through the OData service: 400 before any model call,
// default supplier, dates, own-history counts vs AI estimate, safety stock.
// leadTimeRange (leadtimes) is replaced by a stubbed handler; in mode "off"
// the stub answers 501 (like the kernel stub) and planning falls back to the
// range prepareDay stored.
import cds from "@sap/cds";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { FIXTURE_AS_OF, seedFixtures } from "./fixtures/cockpit";

const { INSERT, DELETE } = cds.ql;
const app = cds.test(path.join(__dirname, "..")) as ReturnType<typeof cds.test> & { url: string };
const AUTH = { auth: { username: "ilyesse.hettenbach@cbs-consulting.de", password: "alice" }, validateStatus: () => true };
const S4 = "tide.s4";
const AS_OF = FIXTURE_AS_OF; // 2026-10-05

let tabularCalls = 0;
let fake: Server;
const rangeCalls: any[] = [];
let rangeMode: "own" | "ai" | "off" = "ai";
const priceCalls: any[] = [];
let priceMode: "ai" | "fallback" = "ai";

/** 19 levels 0.05…0.95: 20, 22, … 56 (p50 = 38, p80 = 50). */
const LEVELS = JSON.stringify(Object.fromEntries(Array.from({ length: 19 }, (_, i) => [((i + 1) * 0.05).toFixed(2), 20 + i * 2])));

async function get(pathAndQuery: string) {
  return app.axios.get(`/odata/v4/desk/${pathAndQuery}`, AUTH);
}

function plan(p: Record<string, string | null>) {
  const args = Object.entries(p)
    .map(([k, v]) => `${k}=${v === null ? "null" : k === "needDate" ? v : `'${v}'`}`)
    .join(",");
  return get(`planOrder(${args})`);
}

function compare(p: Record<string, string>) {
  const args = Object.entries(p).map(([k, v]) => `${k}=${k === "needDate" ? v : `'${v}'`}`).join(",");
  return get(`compareSuppliers(${args})`);
}

before(async () => {
  fake = createServer((req, res) => {
    if (req.url !== "/health") tabularCalls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", backend: "fake" }));
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  (cds.env.requires as any).tabular.credentials = { url: `http://127.0.0.1:${(fake.address() as any).port}` };
  await app;
  const srv = await cds.connect.to("PurchasingDeskService");
  srv.prepend(() =>
    srv.on("leadTimeRange", (req: any) => {
      if (rangeMode === "off") return req.reject({ status: 501, code: "NOT_IMPLEMENTED", message: "leadTimeRange is not implemented yet", notImplemented: true, notImplementedMessage: "leadTimeRange" } as any);
      rangeCalls.push({ ...req.data });
      return rangeMode === "own"
        ? { ...req.data, source: "empirical", n: 25, contextLevel: "material_supplier", contextRows: 25, levels: LEVELS }
        : { ...req.data, source: "tabpfn", n: 0, contextLevel: "supplier within plant", contextRows: 47, levels: LEVELS };
    }),
  );
  srv.prepend(() =>
    srv.on("estimatePurchasePrice", (req: any) => {
      priceCalls.push({ ...req.data });
      return priceMode === "ai" ? {
        p10: 9, p50: 11, p90: 13, historicalReference: 11, historicalCount: 3,
        source: "tabpfn", reason: null, assumedQuantity: req.data.quantity,
        assumedUnit: req.data.unit, assumedCurrency: req.data.currency,
        backend: "fake", runID: null, inputFingerprint: null, computedAt: "2026-10-05T00:00:00.000Z",
        trainingRows: 3, contextScope: "test",
      } : {
        historicalReference: 11, historicalCount: 3, source: "fallback",
        reason: "Prediction unavailable", assumedQuantity: req.data.quantity,
        assumedUnit: req.data.unit, assumedCurrency: req.data.currency,
      };
    }),
  );
});

after(() => new Promise<void>((r) => fake.close(() => r())));

beforeEach(async () => {
  for (const e of [
    "PurchaseOrder",
    "PurchaseOrderItem",
    "PurgInfoRecdOrgPlantData",
    "Product",
    "ProductPlantSupplyPlanning",
    "Supplier",
    "MaterialDocumentItem",
  ])
    await DELETE.from(`${S4}.${e}`);
  await DELETE.from("tide.cockpit.ItemFact");
  await DELETE.from("tide.cockpit.SourceRange");
  await seedFixtures(cds.db);
  tabularCalls = 0;
  rangeCalls.length = 0;
  priceCalls.length = 0;
  rangeMode = "ai";
  priceMode = "ai";

  await INSERT.into(`${S4}.Product`).entries([
    { Product: "M1", BaseUnit: "PC" },
    { Product: "M2", BaseUnit: "PC" },
    { Product: "M3", BaseUnit: "PC" },
  ]);
  await INSERT.into(`${S4}.ProductPlantSupplyPlanning`).entries([
    { Product: "M1", Plant: "1010", PlannedDeliveryDurationInDays: 2 },
    { Product: "M3", Plant: "1010", PlannedDeliveryDurationInDays: 10 },
    { Product: "M2", Plant: "2020", PlannedDeliveryDurationInDays: 7 },
  ]);
  await INSERT.into(`${S4}.Supplier`).entries([{ Supplier: "S1" }, { Supplier: "S2" }, { Supplier: "S9" }]);
  // M1 in 1010: S2 ordered earlier, S1 last; prices 10, 11, 12 then a slip of 1.2 → median 11 of the last 3.
  const pos = [
    { po: "4500000001", date: "2026-05-01", sup: "S2", price: 10 },
    { po: "4500000002", date: "2026-06-01", sup: "S2", price: 11 },
    { po: "4500000003", date: "2026-07-01", sup: "S1", price: 12 },
    { po: "4500000004", date: "2026-08-01", sup: "S1", price: 1.2 },
    { po: "4500000009", date: "2026-10-05", sup: "S2", price: 99 }, // on the as-of date: not known yet
  ];
  await INSERT.into(`${S4}.PurchaseOrder`).entries(
    pos.map((p) => ({ PurchaseOrder: p.po, PurchaseOrderDate: p.date, Supplier: p.sup, DocumentCurrency: "EUR" })),
  );
  await INSERT.into(`${S4}.PurchaseOrderItem`).entries(
    pos.map((p) => ({
      PurchaseOrder: p.po,
      PurchaseOrderItem: "10",
      Material: "M1",
      Plant: "1010",
      OrderQuantity: 5,
      PurchaseOrderQuantityUnit: "PC",
      NetPriceAmount: p.price,
      NetPriceQuantity: 1,
      DocumentCurrency: "EUR",
    })),
  );
  // Info records: S1 maintained 5 days for M1; M3 only has an info record (no PO) of S9, 0 days.
  await INSERT.into(`${S4}.PurgInfoRecdOrgPlantData`).entries([
    { PurchasingInfoRecord: "5300000001", PurchasingInfoRecordCategory: "0", PurchasingOrganization: "1010", Plant: "1010", Material: "M1", Supplier: "S1", MaterialPlannedDeliveryDurn: 5, PurchasingDocumentDate: "2026-01-01" },
    { PurchasingInfoRecord: "5300000002", PurchasingInfoRecordCategory: "0", PurchasingOrganization: "1010", Plant: "1010", Material: "M3", Supplier: "S9", MaterialPlannedDeliveryDurn: 0, PurchasingDocumentDate: "2026-02-01" },
  ]);
  // Goods issues of M1 in 1010: 365 PC in the 365 days before the as-of date → 1 PC per day.
  await INSERT.into(`${S4}.MaterialDocumentItem`).entries([
    { MaterialDocumentYear: "2026", MaterialDocument: "4900000001", MaterialDocumentItem: "1", PostingDate: "2026-03-01", GoodsMovementType: "261", GoodsMovementIsCancelled: false, Material: "M1", Plant: "1010", QuantityInBaseUnit: 200 },
    { MaterialDocumentYear: "2026", MaterialDocument: "4900000002", MaterialDocumentItem: "1", PostingDate: "2026-10-04", GoodsMovementType: "601", GoodsMovementIsCancelled: false, Material: "M1", Plant: "1010", QuantityInBaseUnit: 165 },
    { MaterialDocumentYear: "2026", MaterialDocument: "4900000003", MaterialDocumentItem: "1", PostingDate: "2026-10-05", GoodsMovementType: "261", GoodsMovementIsCancelled: false, Material: "M1", Plant: "1010", QuantityInBaseUnit: 999 },
    { MaterialDocumentYear: "2025", MaterialDocument: "4900000004", MaterialDocumentItem: "1", PostingDate: "2025-09-01", GoodsMovementType: "261", GoodsMovementIsCancelled: false, Material: "M1", Plant: "1010", QuantityInBaseUnit: 999 },
    { MaterialDocumentYear: "2026", MaterialDocument: "4900000005", MaterialDocumentItem: "1", PostingDate: "2026-06-01", GoodsMovementType: "101", GoodsMovementIsCancelled: false, Material: "M1", Plant: "1010", QuantityInBaseUnit: 999 },
  ]);
  // Own history of M1/S1/1010: 25 lead times 20, 21.5, … 56.
  await INSERT.into("tide.cockpit.ItemFact").entries(
    Array.from({ length: 25 }, (_, i) => ({
      PurchaseOrder: String(4400000000 + i),
      PurchaseOrderItem: "10",
      Material: "M1",
      Supplier: "S1",
      Plant: "1010",
      LeadTimeDays: 20 + Math.round(i * 1.5),
      AvailableDate: "2026-01-01",
    })),
  );
});

test("unknown plant, material, material not in plant, unknown supplier: 400 without any model call", async () => {
  const cases: [Record<string, string | null>, RegExp][] = [
    [{ Material: "M1", Plant: "XX99", Supplier: "S1", needDate: "2026-12-15" }, /Unknown plant XX99/],
    [{ Material: "NOPE", Plant: "1010", Supplier: "S1", needDate: "2026-12-15" }, /Unknown material NOPE/],
    [{ Material: "M2", Plant: "1010", Supplier: "S1", needDate: "2026-12-15" }, /not maintained in plant 1010/],
    [{ Material: "M1", Plant: "1010", Supplier: "Lorem", needDate: "2026-12-15" }, /Unknown supplier Lorem/],
  ];
  for (const [input, message] of cases) {
    const res = await plan(input);
    assert.equal(res.status, 400, JSON.stringify(res.data));
    assert.match(res.data.error.message, message);
  }
  assert.equal(rangeCalls.length, 0, "no range request");
  assert.equal(tabularCalls, 0, "fake tabular received no call");
});

test("known supplier without PO and info record in the plant: a warning, not an error", async () => {
  const res = await plan({ Material: "M1", Plant: "1010", Supplier: "S9", needDate: "2026-12-15" });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(res.data.warnings.some((w: string) => /No info record and no past orders/.test(w)));
});

test("default supplier: latest PO of the material in the plant, else latest info record", async () => {
  const res = await plan({ Material: "M1", Plant: "1010", Supplier: null, needDate: "2026-12-15" });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.Supplier, "S1");
  assert.equal(res.data.supplierFrom, "latest order");
  assert.deepEqual(rangeCalls.map(({ Material, Supplier, Plant }) => ({ Material, Supplier, Plant })),
    [{ Material: "M1", Supplier: "S1", Plant: "1010" }]);
  const ir = await plan({ Material: "M3", Plant: "1010", Supplier: null, needDate: "2026-12-15" });
  assert.equal(ir.status, 200, JSON.stringify(ir.data));
  assert.equal(ir.data.Supplier, "S9");
  assert.equal(ir.data.supplierFrom, "latest info record");
  // Info record 0 days → material master.
  assert.equal(ir.data.plannedDays, 10);
  assert.equal(ir.data.plannedFrom, "material master");
});

test("dates and SAP order date use the TabPFN grid without empirical counts", async () => {
  const { status, data } = await plan({ Material: "M1", Plant: "1010", Supplier: "S1", needDate: "2026-12-15" });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.asOf, AS_OF);
  assert.equal(data.source, "tabpfn");
  assert.equal(data.plannedDays, 5);
  assert.equal(data.plannedFrom, "info record");
  assert.deepEqual(
    data.rows.map((r: any) => r.quantile),
    [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95],
  );
  const at = (q: number) => data.rows.find((r: any) => r.quantile === q);
  assert.equal(at(0.5).leadTimeDays, 38);
  assert.equal(at(0.5).latestOrderDate, "2026-11-07");
  assert.equal(at(0.5).reachable, true);
  assert.equal(at(0.8).leadTimeDays, 50);
  assert.equal(at(0.8).latestOrderDate, "2026-10-26");
  assert.equal(at(0.8).earliestDelivery, "2026-11-24");
  assert.equal(at(0.95).leadTimeDays, 56);
  assert.equal(at(0.95).reachable, true, "latest order date 2026-10-20 is after the as-of date");
  // A closer need date: at p80 the latest order date lies before the as-of date.
  const near = (await plan({ Material: "M1", Plant: "1010", Supplier: "S1", needDate: "2026-11-20" })).data;
  const nearAt = (q: number) => near.rows.find((r: any) => r.quantile === q);
  assert.equal(nearAt(0.5).latestOrderDate, "2026-10-13");
  assert.equal(nearAt(0.5).reachable, true);
  assert.equal(nearAt(0.8).latestOrderDate, "2026-10-01");
  assert.equal(nearAt(0.8).reachable, false);
  // SAP: need − 5 = 2026-12-10, 33 days after the latest order date at the median.
  assert.equal(data.sapOrderDate, "2026-12-10");
  assert.equal(data.sapLateDays, 33);
  assert.equal(data.n, 47);
  assert.equal(at(0.8).of, null);
  assert.equal(at(0.8).within, null);
  assert.equal(tabularCalls, 0);
});

test("AI estimate: no counts, coarse context named in a warning", async () => {
  rangeMode = "ai";
  const { status, data } = await plan({ Material: "M1", Plant: "1010", Supplier: "S1", needDate: "2026-12-15" });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.source, "tabpfn");
  assert.ok(data.rows.every((r: any) => r.within === null && r.of === null));
  assert.ok(data.warnings.some((w: string) => /n = 47/.test(w)));
});

test("daily demand, unit price and safety stock", async () => {
  const { data } = await plan({ Material: "M1", Plant: "1010", Supplier: "S1", needDate: "2026-12-15" });
  assert.equal(data.dailyDemand, 1);
  assert.equal(data.unit, "PC");
  assert.equal(data.unitPrice, 11);
  assert.equal(data.currency, "EUR");
  const p80 = data.rows.find((r: any) => r.quantile === 0.8);
  assert.equal(p80.safetyDays, 12);
  assert.equal(p80.safetyStock, 12);
  assert.equal(p80.safetyStockValue, 132);
  const p50 = data.rows.find((r: any) => r.quantile === 0.5);
  assert.equal(p50.safetyDays, 0);
  assert.equal(priceCalls.length, 1, "delivery reads one prepared price estimate");
  assert.deepEqual([data.assumedPriceQuantity, data.assumedPriceUnit, data.assumedPriceCurrency], [5, "PC", "EUR"]);
});

test("delivery returns prepared prices even without goods issues", async () => {
  await DELETE.from(`${S4}.MaterialDocumentItem`);
  const { status, data } = await plan({ Material: "M1", Plant: "1010", Supplier: "S1", needDate: "2026-12-15" });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.dailyDemand, null);
  assert.deepEqual([data.priceP10, data.priceP50, data.priceP90, data.priceSource], [9, 11, 13, "tabpfn"]);
  assert.equal(data.unitPrice, 11);
  assert.ok(data.rows.length > 0);
  assert.equal(priceCalls.length, 1);
  const price = await get(`estimatePurchasePrice(Material='${data.Material}',Plant='${data.Plant}',Supplier='${data.Supplier}',quantity=${data.assumedPriceQuantity},unit='${data.assumedPriceUnit}',currency='${data.assumedPriceCurrency}',asOf=${data.asOf})`);
  assert.equal(price.status, 200, JSON.stringify(price.data));
  assert.deepEqual([price.data.p10, price.data.p50, price.data.p90, price.data.source], [9, 11, 13, "tabpfn"]);
  assert.deepEqual(priceCalls[1], {
    Material: "M1", Plant: "1010", Supplier: "S1", quantity: 5, unit: "PC", currency: "EUR", asOf: AS_OF,
  });
});

test("supplier comparison returns delivery thresholds and TabPFN price estimates together", async () => {
  const { status, data } = await compare({ Material: "M1", Plant: "1010", needDate: "2026-12-15" });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.asOf, AS_OF);
  assert.equal(data.needDate, "2026-12-15");
  const option = data.options.find((row: any) => row.Supplier === "S1");
  assert.ok(option, JSON.stringify(data));
  assert.deepEqual([option.p50Date, option.p80Date, option.p90Date], ["2026-11-12", "2026-11-24", "2026-11-28"]);
  assert.deepEqual([option.priceP10, option.priceP50, option.priceP90, option.priceSource], [9, 11, 13, "tabpfn"]);
  assert.equal(option.p80Reachable, true);
});

test("simulation rejects a stored historical range when TabPFN is unavailable", async () => {
  rangeMode = "off";
  await INSERT.into("tide.cockpit.SourceRange").entries({
    Material: "M1",
    Supplier: "S1",
    Plant: "1010",
    source: "empirical",
    nOwn: 25,
    quantiles: JSON.stringify({ "0.1": 22, "0.2": 26, "0.3": 30, "0.4": 34, "0.5": 38, "0.6": 42, "0.7": 46, "0.8": 50, "0.9": 54, "0.95": 56 }),
  });
  const { status, data } = await plan({ Material: "M1", Plant: "1010", Supplier: "S1", needDate: "2026-12-15" });
  assert.equal(status, 424, JSON.stringify(data));
  assert.match(data.error.message, /TabPFN delivery forecast unavailable/);
});

test("no need date: as-of + 56 days; the source comes with its buyer word", async () => {
  const { status, data } = await plan({ Material: "M1", Plant: "1010", Supplier: "S1", needDate: null });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.needDate, "2026-11-30");
  assert.equal(data.sourceText, "AI estimate");
});

test("simulation does not expose a historical price fallback as a forecast", async () => {
  priceMode = "fallback";
  const { status, data } = await plan({ Material: "M1", Plant: "1010", Supplier: "S1", needDate: "2026-12-15" });
  assert.equal(status, 200, JSON.stringify(data));
  assert.deepEqual([data.priceP10, data.priceP50, data.priceP90, data.priceSource], [null, null, null, "unavailable"]);
  assert.equal(data.historicalPriceReference, null);
  assert.match(data.priceReason, /Prediction unavailable/);
});
