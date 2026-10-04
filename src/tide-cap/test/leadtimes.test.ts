// Lead-time feature (P-3 … P-6) against the database: context ladder and the
// one model call, pdt / mm_pdt findings, buffer simulator, change list and the
// goods receipt hook. Fake tabular only.
import cds from "@sap/cds";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  FIXTURE_AS_OF,
  FIXTURE_SNAPSHOT,
  seedFixtures,
} from "./fixtures/cockpit";
import {
  registerCallGuard,
  resetCallSeams,
  withPredictionOptions,
} from "../srv/cockpit/kernel/model-calls";
import { runHooks } from "../srv/cockpit/kernel/hooks";
import { step } from "../srv/cockpit/leadtimes";

const { INSERT, SELECT, DELETE } = cds.ql;
const app = cds.test(path.join(__dirname, "..")) as ReturnType<
  typeof cds.test
> & { url: string };
const NS = "tide.cockpit";
const AUTH = {
  auth: { username: "ilyesse.hettenbach@cbs-consulting.de", password: "alice" },
};
const calls: {
  keys: string[];
  trainRows: number;
  levels: number[];
  columns: string[];
}[] = [];
let fallback: string | null = null;
let providerBackend = "priorlabs";
let fake: Server;

const lt = (po: string, o: Record<string, any>) => ({
  PurchaseOrder: po,
  PurchaseOrderItem: "10",
  Plant: "P1",
  MaterialGroup: "G1",
  MaterialType: "HAWA",
  OrderQuantity: 1,
  NetAmountEUR: 100,
  PurchasingGroup: "001",
  IsOpen: false,
  ...o,
});
const day = (base: string, n: number) => {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

before(async () => {
  fake = createServer(async (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/health")
      return res.end(
        JSON.stringify({ status: "ok", backend: providerBackend }),
      );
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const r = JSON.parse(raw);
    if (r.mode !== "dry_run")
      calls.push({
        keys: r.keys,
        trainRows: r.x_train.length,
        levels: r.output.levels,
        columns: r.columns,
      });
    res.end(
      JSON.stringify({
        task: r.task,
        output_type: r.output.type,
        classes: null,
        levels: r.output.levels,
        // Median 30 days; level q → 10 + 40 q days.
        predictions: r.keys.map((k: string) => ({
          row_key: k,
          value: 30,
          quantiles: r.output.levels.map((q: number) =>
            r.output.levels.length === 1 ? 30 : 10 + 40 * q,
          ),
        })),
        fallback,
        dropped_columns: [],
        placeholder: r.mode === "dry_run",
        usage: {
          backend: providerBackend,
          calls: fallback ? 0 : 1,
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
  await seedFixtures(cds.db);

  // A M1/S1: 30 receipts in the last year, older 21 × 10 days, later 9 × 20 days; info record 5 days (below range).
  // S5 also supplies M1 (2 POs, no own history → model median 30).
  // B M2/S2: 3 receipts, info record 2 days (system default, rule).
  // C M3/S3: 25 receipts of 14 days, info record 14 (in line: no finding).
  // D M4/S4: info record 999 but no PO in the last 365 days (not checked).
  // E M6/S6: stock transfer (special procurement 40).
  const facts: Record<string, any>[] = [];
  for (let i = 0; i < 30; i++) {
    const date = day("2025-10-20", i * 10);
    const lead = i < 21 ? 10 : 20;
    facts.push(
      lt(`A${String(i).padStart(3, "0")}`, {
        Material: "M1",
        Supplier: "S1",
        PurchaseOrderDate: date,
        AvailableDate: day(date, lead),
        LeadTimeDays: lead,
        NetAmountEUR: 1000,
      }),
    );
  }
  facts.push(
    lt("F001", {
      Material: "M1",
      Supplier: "S5",
      PurchaseOrderDate: "2026-08-01",
    }),
  );
  facts.push(
    lt("F002", {
      Material: "M1",
      Supplier: "S5",
      PurchaseOrderDate: "2026-09-01",
    }),
  );
  for (let i = 0; i < 3; i++) {
    const date = day("2026-03-01", i * 30);
    facts.push(
      lt(`B00${i}`, {
        Material: "M2",
        Supplier: "S2",
        PurchaseOrderDate: date,
        AvailableDate: day(date, 12),
        LeadTimeDays: 12,
        NetAmountEUR: 50,
      }),
    );
  }
  for (let i = 0; i < 25; i++) {
    const date = day("2025-11-01", i * 12);
    facts.push(
      lt(`C${String(i).padStart(3, "0")}`, {
        Material: "M3",
        Supplier: "S3",
        MaterialGroup: "G3",
        PurchaseOrderDate: date,
        AvailableDate: day(date, 14),
        LeadTimeDays: 14,
      }),
    );
  }
  facts.push(
    lt("D001", {
      Material: "M4",
      Supplier: "S4",
      PurchaseOrderDate: "2024-01-10",
      AvailableDate: "2024-02-10",
      LeadTimeDays: 31,
    }),
  );
  for (let i = 0; i < 6; i++)
    facts.push(
      lt(`E00${i}`, {
        Material: "M6",
        Supplier: "S6",
        PurchaseOrderDate: day("2026-05-01", i * 7),
      }),
    );
  await INSERT.into(`${NS}.ItemFact`).entries(facts);

  const ir = (id: string, m: string, s: string, days: number) => ({
    PurchasingInfoRecord: id,
    PurchasingInfoRecordCategory: "0",
    PurchasingOrganization: "1000",
    Plant: "P1",
    Material: m,
    Supplier: s,
    PurchasingGroup: "001",
    MaterialPlannedDeliveryDurn: days,
  });
  await INSERT.into("tide.s4.PurgInfoRecdOrgPlantData").entries([
    ir("IR1", "M1", "S1", 5),
    ir("IR2", "M2", "S2", 2),
    ir("IR3", "M3", "S3", 14),
    ir("IR4", "M4", "S4", 999),
  ]);
  await INSERT.into("tide.s4.ProductPlantSupplyPlanning").entries([
    {
      Product: "M1",
      Plant: "P1",
      PlannedDeliveryDurationInDays: 2,
      MRPResponsible: "M01",
    },
    { Product: "M2", Plant: "P1", PlannedDeliveryDurationInDays: 12 },
    { Product: "M3", Plant: "P1", PlannedDeliveryDurationInDays: 14 },
    {
      Product: "M6",
      Plant: "P1",
      PlannedDeliveryDurationInDays: 3,
      ProcurementSubType: "40",
    },
  ]);
  await INSERT.into("tide.s4.Product").entries([
    { Product: "M1", ProductGroup: "G1", ProductType: "HAWA" },
    { Product: "M2", ProductGroup: "G1", ProductType: "HAWA" },
  ]);
  await INSERT.into("tide.s4.ProductDescription").entries({
    Product: "M1",
    Language: "EN",
    ProductDescription: "Bearing 6204",
  });
  await INSERT.into("tide.s4.Supplier").entries({
    Supplier: "S1",
    SupplierName: "Supplier One GmbH",
  });
});

after(() => new Promise<void>((r) => fake.close(() => r())));

const meter = () => ({
  user: new cds.User({
    id: "ilyesse.hettenbach@cbs-consulting.de",
    roles: ["user", "admin"],
  } as any),
  calls: 0,
  cost: 0,
  runs: [],
  planned: [],
  backend: null,
  failed: [],
});
const ctx = () => ({
  user: meter().user,
  snapshotId: FIXTURE_SNAPSHOT,
  asOf: FIXTURE_AS_OF,
  dryRun: false,
  meter: meter(),
});
/** Findings of one list (`list` is a CQN token: object-style where misparses). */
const ofList = (l: string) =>
  SELECT.from(`${NS}.Finding`)
    .where([{ ref: ["list"] }, "=", { val: l }] as any)
    .orderBy("rank");
const get = async (url: string) =>
  (await app.axios.get(`/odata/v4/desk/${url}`, AUTH)).data;

test(
  "forced simulation creates fresh delivery and price runs",
  { timeout: 15_000 },
  async () => {
    // Need-date scenarios read the live S4 source, not the materialized ItemFact.
    const history = await SELECT.from(`${NS}.ItemFact`).where({
      Material: "M1",
      Supplier: "S1",
    });
    const historyOrders = history.map((row: any) => row.PurchaseOrder);
    await INSERT.into("tide.s4.PurchaseOrder").entries(
      history.map((row: any) => ({
        PurchaseOrder: row.PurchaseOrder,
        PurchaseOrderDate: row.PurchaseOrderDate,
        Supplier: row.Supplier,
        PurchasingGroup: row.PurchasingGroup,
        DocumentCurrency: "EUR",
      })),
    );
    await INSERT.into("tide.s4.PurchaseOrderItem").entries(
      history.map((row: any) => ({
        PurchaseOrder: row.PurchaseOrder,
        PurchaseOrderItem: row.PurchaseOrderItem,
        Material: row.Material,
        MaterialGroup: row.MaterialGroup,
        MaterialType: row.MaterialType,
        Plant: row.Plant,
        OrderQuantity: row.OrderQuantity,
        NetAmount: row.NetAmountEUR,
        DocumentCurrency: "EUR",
      })),
    );
    await INSERT.into("tide.s4.MaterialDocumentItem").entries(
      history.map((row: any, index: number) => ({
        MaterialDocumentYear: row.AvailableDate.slice(0, 4),
        MaterialDocument: `59${String(index).padStart(8, "0")}`,
        MaterialDocumentItem: "1",
        PostingDate: row.AvailableDate,
        GoodsMovementType: "101",
        GoodsMovementIsCancelled: false,
        PurchaseOrder: row.PurchaseOrder,
        PurchaseOrderItem: row.PurchaseOrderItem,
        Material: row.Material,
        Plant: row.Plant,
        QuantityInEntryUnit: row.OrderQuantity,
      })),
    );
    try {
      const first = await get(
        "planOrder(Material='M1',Plant='P1',Supplier='S1',needDate=2026-12-01,force=false)",
      );
      const beforeForce = calls.length;
      const forced = await get(
        "planOrder(Material='M1',Plant='P1',Supplier='S1',needDate=2026-12-01,force=true)",
      );
      assert.notEqual(forced.modelRunID, first.modelRunID);
      assert.ok(calls.length > beforeForce);

      await INSERT.into("tide.s4.PurchaseOrder").entries([
        {
          PurchaseOrder: "PRICE-FORCE-1",
          PurchaseOrderDate: "2026-08-01",
          Supplier: "S1",
          DocumentCurrency: "EUR",
        },
        {
          PurchaseOrder: "PRICE-FORCE-2",
          PurchaseOrderDate: "2026-09-01",
          Supplier: "S1",
          DocumentCurrency: "EUR",
        },
        {
          PurchaseOrder: "PRICE-FORCE-3",
          PurchaseOrderDate: "2026-09-15",
          Supplier: "S1",
          DocumentCurrency: "EUR",
        },
      ]);
      await INSERT.into("tide.s4.PurchaseOrderItem").entries(
        [1, 2, 3].map((index) => ({
          PurchaseOrder: `PRICE-FORCE-${index}`,
          PurchaseOrderItem: "10",
          Material: "M1",
          Plant: "P1",
          OrderQuantity: 1,
          PurchaseOrderQuantityUnit: "PC",
          DocumentCurrency: "EUR",
          NetPriceAmount: 10 + index,
          NetPriceQuantity: 1,
        })),
      );
      const service = await cds.connect.to("PurchasingDeskService");
      const input = {
        Material: "M1",
        Plant: "P1",
        Supplier: "S1",
        quantity: 1,
        unit: "PC",
        currency: "EUR",
        asOf: FIXTURE_AS_OF,
      };
      const beforePrice = calls.length;
      const price = await withPredictionOptions(true, () =>
        cds.tx({ user: meter().user }, () =>
          service.send("estimatePurchasePrice", input),
        ),
      );
      assert.equal(price.source, "tabpfn");
      assert.ok(price.runID);
      assert.ok(calls.length > beforePrice);
      const secondPrice = await withPredictionOptions(true, () =>
        cds.tx({ user: meter().user }, () =>
          service.send("estimatePurchasePrice", input),
        ),
      );
      assert.equal(secondPrice.source, "tabpfn");
      assert.notEqual(secondPrice.runID, price.runID);
      const afterForce = calls.length;
      const cachedPrice = await cds.tx({ user: meter().user }, () =>
        service.send("estimatePurchasePrice", input),
      );
      assert.equal(cachedPrice.runID, secondPrice.runID);
      assert.equal(calls.length, afterForce);
    } finally {
      await DELETE.from("tide.s4.MaterialDocumentItem").where({
        PurchaseOrder: { in: historyOrders },
      });
      await DELETE.from("tide.s4.PurchaseOrderItem").where({
        PurchaseOrder: {
          in: [
            "PRICE-FORCE-1",
            "PRICE-FORCE-2",
            "PRICE-FORCE-3",
            ...historyOrders,
          ],
        },
      });
      await DELETE.from("tide.s4.PurchaseOrder").where({
        PurchaseOrder: {
          in: [
            "PRICE-FORCE-1",
            "PRICE-FORCE-2",
            "PRICE-FORCE-3",
            ...historyOrders,
          ],
        },
      });
    }
  },
);

test("leadTimeRange: dense own history retains evidence while model is primary", async () => {
  const r = await get("leadTimeRange(Material='M1',Supplier='S1',Plant='P1')");
  assert.equal(r.source, "tabpfn");
  assert.ok(r.modelRunID);
  assert.equal(r.n, 30);
  assert.equal(Object.keys(JSON.parse(r.levels)).length, 19);
  assert.match(r.sentence, /AI estimate from similar deliveries/);
  assert.ok(r.ownLevels);
});

test("leadTimeRange: ladder skips levels below 5 rows, one call with one test row", async () => {
  const n = calls.length;
  const r = await get("leadTimeRange(Material='M2',Supplier='S2',Plant='P1')");
  assert.equal(calls.length, n + 1);
  const c = calls[calls.length - 1];
  assert.deepEqual(c.keys, ["B002/10"]);
  assert.equal(c.levels.length, 19);
  // material+supplier 3, material 3, supplier 3 → material group G1 (M1 + M2 + S5 items with a lead time).
  assert.equal(r.contextLevel, "material group within plant");
  assert.equal(c.trainRows, 33); // G1: 30 M1/S1 + 3 M2/S2 + D001, without the predicted B002
  assert.equal(r.source, "tabpfn");
  assert.equal(r.n, 3);
  assert.equal(r.p50, 30);
  assert.match(
    r.sentence,
    /AI estimate from similar deliveries.*not a promise/,
  );
});

test("leadTimeRange: context without a varying feature is an explicit fallback", async () => {
  fallback = "context_quantiles";
  try {
    const r = await get(
      "leadTimeRange(Material='M3',Supplier='S3',Plant='P1')",
    );
    assert.equal(r.source, "fallback");
    assert.ok(!/AI estimate/.test(r.sentence));
  } finally {
    fallback = null;
  }
});

test("leadTimeRange: unseen supplier never borrows another supplier's test row", async () => {
  const before = calls.length;
  const result = await get(
    "leadTimeRange(Material='M2',Supplier='S1',Plant='P1')",
  );
  assert.equal(result.source, "none");
  assert.equal(result.p50, null);
  assert.equal(calls.length, before);
  assert.match(result.sentence, /no other supplier was substituted/);
});

test("leadTimeRange: unknown provider output is unavailable rather than a zero-day forecast", async () => {
  providerBackend = "unsupported-test-provider";
  try {
    const result = await get(
      "leadTimeRange(Material='M2',Supplier='S2',Plant='P1')",
    );
    assert.equal(result.source, "none");
    assert.equal(result.p10, null);
    assert.equal(result.p50, null);
    assert.equal(result.p90, null);
    assert.match(result.sentence, /unsupported/);
  } finally {
    providerBackend = "priorlabs";
  }
});

test("leadTimeRange: special procurement 40 is out of scope (rule)", async () => {
  const n = calls.length;
  const r = await get("leadTimeRange(Material='M6',Supplier='S6',Plant='P1')");
  assert.equal(calls.length, n);
  assert.equal(r.source, "rule");
  assert.equal(r.p50, null);
});

test("leadTimeRange: the budget guard refuses the model call", async () => {
  registerCallGuard(async () => {
    throw new (cds.error as any)({ status: 429, message: "Budget exhausted" });
  });
  try {
    await assert.rejects(
      get("leadTimeRange(Material='M2',Supplier='S2',Plant='P1')"),
      (e: any) => e.response?.status === 429,
    );
  } finally {
    resetCallSeams();
  }
});

test("bufferSimulator: older 70 % / later 30 % by receipt date, plus the current value", async () => {
  const rows = (
    await get("bufferSimulator(Material='M1',Supplier='S1',Plant='P1')")
  ).value;
  const q = rows.filter((r: any) => !r.isCurrent);
  assert.deepEqual(
    q.map((r: any) => r.quantile),
    [0.5, 0.6, 0.7, 0.8, 0.9],
  );
  // Older 21 × 10 days → every proposal 10, every later delivery (20 days) is late.
  assert.ok(
    q.every(
      (r: any) =>
        r.proposalDays === 10 &&
        r.lateShare === 1 &&
        r.nOlder === 21 &&
        r.nLater === 9 &&
        r.meanDaysLate === 10,
    ),
  );
  const cur = rows.find((r: any) => r.isCurrent);
  assert.equal(cur.proposalDays, 5);
  assert.equal(cur.lateShare, 1);
  assert.deepEqual(
    (await get("bufferSimulator(Material='M2',Supplier='S2',Plant='P1')"))
      .value,
    [],
  );
});

test("step: pdt and mm_pdt findings with buyer words, proposal, rank and sources", async () => {
  const n = calls.length;
  const c0 = ctx();
  await step.run(c0);
  // mm_pdt: one call for plant P1 (the sources below 20 own lead times: M1/S5).
  assert.equal(calls.length, n + 2);
  assert.ok(!calls[n].columns.includes("PlannedDays"));
  assert.ok(!calls[n].columns.includes("RequestedGapDays"));
  assert.deepEqual(calls[calls.length - 1].keys, ["F002/10"]);

  const pdt: any[] = await ofList("pdt");
  assert.deepEqual(
    pdt.map((f) => f.objectKey),
    ["M1|S1|P1", "M2|S2|P1"],
  );
  const [a, b] = pdt;
  assert.equal(a.ID, "pdt:M1|S1|P1");
  assert.match(
    a.issue,
    /^Info record 5 days: shorter than independent delivery predictions/,
  );
  assert.match(a.issue, /material master says 2 days/);
  assert.equal(a.source, "tabpfn");
  assert.equal(a.nextStep, "Add to the change list");
  assert.equal(a.nextActionKind, "pdt_change");
  const ea = await SELECT.one
    .from(`${NS}.PdtDetail`)
    .where({ finding_ID: a.ID });
  assert.equal(ea.proposalDays, 20); // ceil(p80) of 21 × 10, 9 × 20
  // Info record and material master differ by ≥ 2 days: signalled.
  assert.equal(
    b.issue,
    "Info record 2 days: shorter than independent delivery predictions; material master says 12 days",
  );
  assert.equal(b.source, "tabpfn");
  assert.equal(
    (await SELECT.one.from(`${NS}.PdtDetail`).where({ finding_ID: b.ID }))
      .proposalDays,
    null,
  );
  for (const f of pdt)
    assert.ok(
      !/p10|p90|empirical|quantile|TabPFN/i.test(f.issue + f.chain),
      f.issue + f.chain,
    );

  const mm: any[] = await ofList("mm_pdt");
  assert.deepEqual(
    mm.map((f) => f.objectKey),
    ["M1|P1", "M3|P1"],
  );
  const modelOnly = await SELECT.one
    .from(`${NS}.MaterialPlannedTimes`)
    .where({ header_ID: "mm_pdt:M3|P1" });
  assert.equal(modelOnly.proposedDays, 14);
  assert.equal(modelOnly.currentDays, 14);
  assert.equal(JSON.parse(modelOnly.detail).settingComparison.trigger, true);
  const m1 = mm[0];
  const e = await SELECT.one
    .from(`${NS}.MmPdtDetail`)
    .where({ finding_ID: m1.ID });
  assert.equal(e.masterFlag, "system default");
  assert.equal(m1.source, "tabpfn");
  // S1: 30 of 32 POs, median 10; S5: 2 of 32, model median 30 → ceil(11.25) = 12.
  assert.equal(e.proposalDays, 12);
  assert.deepEqual(
    (
      await SELECT.from(`${NS}.MmPdtSource`)
        .where({ finding_finding_ID: m1.ID })
        .orderBy("supplier")
    ).map((s: any) => [
      s.supplier,
      s.orders12m,
      s.source,
      s.typicalDays,
      s.pdtFindingID,
    ]),
    [
      ["S1", 30, "empirical", 10, "pdt:M1|S1|P1"],
      ["S5", 2, "tabpfn", 30, null],
    ],
  );
  assert.match(
    m1.issue,
    /^Material master 2 days: \d+(?:\.\d+)? days below independent supplier predictions$/,
  );
});

test("MaterialMasterPlannedTimeFindings exposes planned-time evidence", async () => {
  const row = await get(
    "MaterialMasterPlannedTimeFindings('mm_pdt:M1%7CP1')?$expand=mmPdtDetail($expand=sources)",
  );
  assert.equal(row.mmPdtDetail.masterDays, 2);
  assert.equal(row.mmPdtDetail.proposalDays, 12);
  assert.deepEqual(
    row.mmPdtDetail.sources.map((source: any) => [
      source.supplier,
      source.orders12m,
      source.orderShare,
      source.ownDeliveries,
      source.typicalDays,
      source.pdtFindingID,
    ]),
    [
      ["S1", 30, 0.9375, 30, 10, "pdt:M1|S1|P1"],
      ["S5", 2, 0.0625, 0, 30, null],
    ],
  );
});

test("dry run counts the planned call and writes nothing", async () => {
  const before = await SELECT.from(`${NS}.Finding`).columns("ID");
  const c = { ...ctx(), dryRun: true };
  const n = calls.length;
  await step.run(c);
  assert.equal(calls.length, n);
  assert.deepEqual(c.meter.planned, [
    "independent setting ranges P1",
    "material master P1",
  ]);
  assert.deepEqual(await SELECT.from(`${NS}.Finding`).columns("ID"), before);
});

test("legacy supplier change-list routes reject without writes; material proposals remain reviewable", async () => {
  const url = (id: string) =>
    `/odata/v4/desk/Findings('${encodeURIComponent(id)}')/PurchasingDeskService.addToChangeList`;
  const tables = ["Actions", "ActionItems", "OperationLocks", "CaseActions"];
  const before = await Promise.all(
    tables.map((table) => SELECT.from(`${NS}.${table}`)),
  );
  for (const retired of [
    url("pdt:M1|S1|P1"),
    "/odata/v4/desk/SupplierPlannedTimeFindings('pdt:M1%7CS1%7CP1')/PurchasingDeskService.addToChangeList",
  ])
    await assert.rejects(
      app.axios.post(retired, {}, AUTH),
      (error: any) => Number(error.status ?? error.response?.status) === 410,
    );
  await assert.rejects(
    app.axios.post(url("pdt:M2|S2|P1"), {}, AUTH),
    (error: any) => Number(error.status ?? error.response?.status) === 409,
  );
  assert.deepEqual(
    await Promise.all(tables.map((table) => SELECT.from(`${NS}.${table}`))),
    before,
  );
  const { data: m } = await app.axios.post(url("mm_pdt:M1|P1"), {}, AUTH);
  const mi: any[] = await SELECT.from(`${NS}.ActionItems`).where({
    action_ID: m.ID,
  });
  assert.equal(mi[0].field, "PlannedDeliveryDurationInDays");
  assert.equal(mi[0].newValue, "12");
});

test("goods receipt arrival does not trigger retired intraday prediction or publication", async () => {
  await INSERT.into("tide.s4.PurchaseOrder").entries({
    PurchaseOrder: "G001",
    PurchaseOrderDate: "2026-09-20",
    Supplier: "S1",
    PurchasingGroup: "001",
    DocumentCurrency: "EUR",
  });
  await INSERT.into("tide.s4.PurchaseOrderItem").entries({
    PurchaseOrder: "G001",
    PurchaseOrderItem: "10",
    Material: "M1",
    Plant: "P1",
    OrderQuantity: 1,
    NetAmount: 1,
    DocumentCurrency: "EUR",
  });
  const gr = {
    MaterialDocumentYear: "2026",
    MaterialDocument: "5000000001",
    MaterialDocumentItem: "1",
    PostingDate: "2026-10-10",
    GoodsMovementType: "101",
    GoodsMovementIsCancelled: false,
    PurchaseOrder: "G001",
    PurchaseOrderItem: "10",
    Material: "M1",
    Plant: "P1",
    QuantityInEntryUnit: 1,
  };
  await INSERT.into("tide.s4.MaterialDocumentItem").entries(gr);
  await DELETE.from(`${NS}.SourceRange`).where({
    Material: "M1",
    Supplier: "S1",
    Plant: "P1",
  });
  const callsBefore = calls.length;
  const findingBefore = await SELECT.one
    .from(`${NS}.Finding`)
    .where({ ID: "pdt:M1|S1|P1" });
  const events = await runHooks(
    {
      kind: "goods_receipt",
      at: "2026-10-10T09:00:00Z",
      rows: { MaterialDocumentItem: [gr] },
    },
    ctx(),
  );
  const mine = events.filter((e) => e.objectKey === "M1|S1|P1");
  assert.equal(mine.length, 0);
  assert.equal(calls.length, callsBefore);
  const range = await SELECT.one
    .from(`${NS}.SourceRange`)
    .where({ Material: "M1", Supplier: "S1", Plant: "P1" });
  assert.equal(range, undefined);
  const f = await SELECT.one
    .from(`${NS}.Finding`)
    .where({ ID: "pdt:M1|S1|P1" });
  assert.deepEqual(f, findingBefore);
});
