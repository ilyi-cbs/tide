// OpenItems.recompute(): one item's range (TabPFN for a sparse source), status
// and customer impact are recomputed from the current facts and persisted.
import cds from "@sap/cds";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";

const { INSERT, SELECT, UPDATE } = cds.ql;
const app = cds.test(path.join(__dirname, "..")) as ReturnType<
  typeof cds.test
> & { url: string };
const NS = "tide.cockpit";
const AS_OF = "2026-10-05";
const AUTH = {
  auth: { username: "ilyesse.hettenbach@cbs-consulting.de", password: "alice" },
};
const calls: { mode: string; keys: string[] }[] = [];
/** Lead time (days) the fake answers for every level offset: p10 = base, p95 = base + 9. */
let base = 10;
let fake: Server;

before(async () => {
  fake = createServer(async (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/health")
      return res.end(JSON.stringify({ status: "ok", backend: "fake" }));
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const r = JSON.parse(raw);
    calls.push({ mode: r.mode, keys: r.keys });
    res.end(
      JSON.stringify({
        task: r.task,
        output_type: r.output.type,
        classes: null,
        levels: r.output.levels,
        predictions: r.keys.map((k: string) => ({
          row_key: k,
          value: base + 4,
          quantiles: r.output.levels.map((_: number, j: number) => base + j),
        })),
        fallback: null,
        dropped_columns: [],
        placeholder: r.mode === "dry_run",
        usage: {
          backend: "fake",
          calls: 1,
          context_cells: 10,
          predicted_cells: 1,
          cost_units: 0.5,
          effective_feature_count: r.columns.length,
        },
        train_rows: r.x_train.length,
        elapsed_ms: 1,
      }),
    );
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  (cds.env.requires as any).tabular.credentials = {
    url: `http://127.0.0.1:${(fake.address() as any).port}`,
  };

  await app;
  const s4 = "tide.s4";
  await INSERT.into(`${s4}.DatasetInfo`).entries({
    ID: "current",
    name: "t",
    asOf: AS_OF,
    containsCustomerData: false,
  });
  // One sparse source (M1/S1/P1): 3 received PO items and one open third-party
  // item (PO 4, ordered 2026-09-01, requested 2026-10-25) that serves
  // sales order SO1 (promised 2026-10-16).
  const orders = [
    { po: "1", date: "2026-02-01", req: "2026-02-20", gr: "2026-02-15" },
    { po: "2", date: "2026-04-01", req: "2026-04-20", gr: "2026-04-15" },
    { po: "3", date: "2026-06-01", req: "2026-06-20", gr: "2026-06-15" },
    { po: "4", date: "2026-09-01", req: "2026-10-25", gr: null },
    // A second open item of the same source without customer demand.
    { po: "5", date: "2026-09-15", req: "2026-12-31", gr: null },
  ];
  await INSERT.into(`${s4}.PurchaseOrder`).entries(
    orders.map((o) => ({
      PurchaseOrder: o.po,
      PurchaseOrderDate: o.date,
      Supplier: "S1",
      DocumentCurrency: "EUR",
    })),
  );
  await INSERT.into(`${s4}.PurchaseOrderItem`).entries(
    orders.map((o) => ({
      PurchaseOrder: o.po,
      PurchaseOrderItem: "10",
      Material: "M1",
      Plant: "P1",
      OrderQuantity: 1,
      NetAmount: 10,
      DocumentCurrency: "EUR",
      PurchaseOrderItemCategory: "5",
    })),
  );
  await INSERT.into(`${s4}.PurchaseOrderScheduleLine`).entries(
    orders.map((o) => ({
      PurchaseOrder: o.po,
      PurchaseOrderItem: "10",
      ScheduleLine: "1",
      ScheduleLineDeliveryDate: o.req,
      OpenPurchaseOrderQuantity: o.gr ? 0 : 1,
    })),
  );
  await INSERT.into(`${s4}.MaterialDocumentItem`).entries(
    orders
      .filter((o) => o.gr)
      .map((o) => ({
        MaterialDocumentYear: "2026",
        MaterialDocument: o.po,
        MaterialDocumentItem: "1",
        PostingDate: o.gr,
        GoodsMovementType: "101",
        GoodsMovementIsCancelled: false,
        PurchaseOrder: o.po,
        PurchaseOrderItem: "10",
        QuantityInEntryUnit: 1,
      })),
  );
  await INSERT.into(`${s4}.PurchaseOrderAccountAssignment`).entries({
    PurchaseOrder: "4",
    PurchaseOrderItem: "10",
    AccountAssignmentNumber: "01",
    SalesOrder: "SO1",
    SalesOrderItem: "10",
  });
  // Info record of the source: 20 days planned. Short range (p10 10, p90 18):
  // above range; long range (p10 40): below range.
  await INSERT.into(`${s4}.PurgInfoRecdOrgPlantData`).entries({
    PurchasingInfoRecord: "IR1",
    PurchasingInfoRecordCategory: "0",
    PurchasingOrganization: "1000",
    Plant: "P1",
    Material: "M1",
    Supplier: "S1",
    MaterialPlannedDeliveryDurn: 20,
  });
  await INSERT.into(`${s4}.Customer`).entries({
    Customer: "C1",
    CustomerName: "Customer One",
  });
  await INSERT.into(`${s4}.SalesOrder`).entries({
    SalesOrder: "SO1",
    SoldToParty: "C1",
    TransactionCurrency: "EUR",
  });
  await INSERT.into(`${s4}.SalesOrderItem`).entries({
    SalesOrder: "SO1",
    SalesOrderItem: "10",
    Product: "M1",
    Plant: "P1",
    RequestedDeliveryDate: "2026-10-16",
    NetAmount: 1000,
    TransactionCurrency: "EUR",
    DeliveryStatus: "A",
  });
});

after(() => new Promise<void>((r) => fake.close(() => r())));

async function prepare() {
  const { data } = await app.axios.post(
    "/odata/v4/desk/prepareDay",
    { dryRun: false },
    AUTH,
  );
  for (let i = 0; i < 100; i++) {
    const s = await SELECT.one.from(`${NS}.Snapshot`).where({ ID: data.ID });
    if (s.status !== "running") return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("prepareDay did not finish");
}

const ITEM =
  "/odata/v4/desk/OpenItems(PurchaseOrder='4',PurchaseOrderItem='10')";

test("recompute publishes a new generation with refreshed range, status and customer impact", async () => {
  // prepareDay with a short range: p50 = 14 days -> expected 2026-10-05 (as-of), on time.
  const snap = await prepare();
  assert.equal(snap.status, "done", snap.message);
  const before = await SELECT.one
    .from(`${NS}.OpenItem`)
    .where({ PurchaseOrder: "4" });
  assert.equal(before.status, "on_time");
  assert.equal(before.revenueAtRiskP80, 0);
  const findingBefore = await SELECT.one
    .from(`${NS}.SourceFinding`)
    .where({ Material: "M1", Supplier: "S1", Plant: "P1" });
  assert.equal(findingBefore.verdict, "above_range");
  assert.equal(findingBefore.p50, 14);

  // Next day, new facts: the requested date moved earlier and the model now
  // says 40+ days. (Same day and same spec would reuse the cached run.)
  await UPDATE.entity("tide.s4.DatasetInfo")
    .where({ ID: "current" })
    .with({ asOf: "2026-10-06" });
  await UPDATE.entity("tide.s4.PurchaseOrderScheduleLine")
    .where({ PurchaseOrder: "4" })
    .with({ ScheduleLineDeliveryDate: "2026-10-10" });
  // Source ranges use a representative order. Change a selected model feature,
  // not only the date/filter, to exercise invalidation of the actual inputs.
  await UPDATE.entity("tide.s4.PurchaseOrderItem").set({ OrderQuantity: 2 });
  base = 40;
  calls.length = 0;

  const { data: item } = await app.axios.post(`${ITEM}/recompute`, {}, AUTH);
  assert.ok(calls.length > 0, "the new generation recalculates model evidence");
  assert.ok(calls.every((call) => call.mode === "predict"));
  assert.notEqual(item.snapshot_ID, snap.ID);
  const published = await SELECT.one.from(`${NS}.PublishedCockpit`).where({ ID: "current" });
  assert.equal(published.snapshot_ID, item.snapshot_ID);
  const next = await SELECT.one.from(`${NS}.Snapshot`).where({ ID: item.snapshot_ID });
  assert.equal(next.status, "done");
  assert.equal(next.asOf, "2026-10-06");
  assert.deepEqual(await SELECT.one.from(`${NS}.Snapshot`).where({ ID: snap.ID }), snap, "the prior published run is immutable");
  assert.equal(item.PurchaseOrder, "4");
  assert.equal(item.ItemKey, "4/10");
  assert.equal(item.source, "fake");
  assert.equal(item.RequestedDate, "2026-10-10");
  // PO date 2026-09-01 + p50 44 days = 2026-10-15, after the requested 2026-10-10.
  assert.equal(item.expectedP50, "2026-10-15");
  assert.equal(item.status, "late");
  assert.equal(item.revenueAtRiskP80, 1000);
  // Promised 2026-10-16: p50 (10-15) is in time, p80 (10-18) is not.
  assert.equal(item.revenueAtRiskP50, 0);

  const range = await SELECT.one
    .from(`${NS}.SourceRange`)
    .where({ Material: "M1", Supplier: "S1", Plant: "P1" });
  assert.equal(range.p50, 44);
  const impact = await SELECT.one
    .from(`${NS}.CustomerImpact`)
    .where({ PurchaseOrder: "4", SalesOrder: "SO1" });
  assert.equal(impact.atRiskP80, true);
  const risk = await SELECT.one
    .from(`${NS}.CustomerRisk`)
    .where({ Customer: "C1" });
  assert.equal(risk.revenueAtRiskP80, 1000);
  const kpis = (await app.axios.get("/odata/v4/desk/kpis()", AUTH)).data;
  assert.equal(kpis.late, 1);
  assert.equal(kpis.revenueAtRiskP80, 1000);

  // The source page matches: finding rebuilt from the new range and open risk.
  const finding = await SELECT.one
    .from(`${NS}.SourceFinding`)
    .where({ Material: "M1", Supplier: "S1", Plant: "P1" });
  assert.equal(finding.verdict, "below_range");
  assert.equal(finding.p50, 44);
  assert.equal(finding.p10, 40);
  assert.equal(finding.proposalDays, 47);
  assert.equal(finding.openItems, 2);
  assert.equal(finding.openRevenueAtRiskP80, 1000);
  assert.equal(finding.priority, 1);
  // The other open item of the source reuses the new range (no extra call).
  const sibling = await SELECT.one
    .from(`${NS}.OpenItem`)
    .where({ PurchaseOrder: "5" });
  assert.equal(sibling.expectedP50, "2026-10-29");
  assert.equal(sibling.source, "fake");

  // plan() reports the as-of date it planned from.
  const plan = (
    await app.axios.get(
      "/odata/v4/desk/plan(Material='M1',Supplier='S1',Plant='P1',needDate=2026-12-01)",
      AUTH,
    )
  ).data;
  assert.equal(plan.asOf, "2026-10-06");
});

test("recompute of an unknown item is 404", async () => {
  const res = await app.axios.post(
    "/odata/v4/desk/OpenItems(PurchaseOrder='9',PurchaseOrderItem='10')/recompute",
    {},
    { ...AUTH, validateStatus: () => true },
  );
  assert.equal(res.status, 404);
});
