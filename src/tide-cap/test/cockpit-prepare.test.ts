// prepareDay dry run: plans the model calls through tabular's dry_run mode
// and leaves prediction runs and the read model untouched.
import cds from "@sap/cds";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  estimatePurchasePrice,
  assessPriceCandidates,
  preparePurchasePrices,
  syncPriceModelRows,
} from "../srv/cockpit/rules/price-model";
import {
  withPredictionOptions,
  type Meter,
} from "../srv/cockpit/kernel/model-calls";
import { buildRequest } from "../srv/core/dataset-builder";
import { feedRegistry, normalizeSpec } from "../srv/core/feeds";
import { runRules } from "../srv/cockpit/rules/morning";
import { prepareDay } from "../srv/cockpit/prepare";
import { runSteps, steps } from "../srv/cockpit/kernel/steps";
import { observePublication } from "../srv/cockpit/kernel/publication";
import { customerRisks } from "../srv/cockpit/prepare/customer-risk";
import type { StepContext } from "../srv/cockpit/kernel/types";

const { INSERT, SELECT, UPDATE } = cds.ql;
const app = cds.test(path.join(__dirname, "..")) as ReturnType<
  typeof cds.test
> & { url: string };
const NS = "tide.cockpit";
const AS_OF = "2026-10-05";
const modes: string[] = [];
const priceRequests: any[] = [];
let fake: Server;

before(async () => {
  fake = createServer(async (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/health")
      return res.end(JSON.stringify({ status: "ok", backend: "fake" }));
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const r = JSON.parse(raw);
    modes.push(r.mode);
    priceRequests.push(r);
    res.end(
      JSON.stringify({
        task: r.task,
        output_type: r.output.type,
        classes: null,
        levels: r.output.levels,
        predictions: r.keys.map((k: string) => ({
          row_key: k,
          value: 10 + r.output.levels.indexOf(0.5),
          quantiles: r.output.levels.map((_: number, j: number) => 10 + j),
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
  // One source (M1/S1/P1): 5 received PO items and one open item.
  const pos = ["1", "2", "3", "4", "5", "6"];
  const date = (n: number) => `2026-0${n}-01`;
  await INSERT.into(`${s4}.PurchaseOrder`).entries(
    pos.map((p, i) => ({
      PurchaseOrder: p,
      PurchaseOrderDate: date(i + 2),
      Supplier: "S1",
      DocumentCurrency: "EUR",
    })),
  );
  await INSERT.into(`${s4}.PurchaseOrderItem`).entries(
    pos.map((p) => ({
      PurchaseOrder: p,
      PurchaseOrderItem: "10",
      Material: "M1",
      Plant: "P1",
      OrderQuantity: 1,
      NetAmount: 10,
      DocumentCurrency: "EUR",
    })),
  );
  await INSERT.into(`${s4}.PurchaseOrderScheduleLine`).entries(
    pos.map((p, i) => ({
      PurchaseOrder: p,
      PurchaseOrderItem: "10",
      ScheduleLine: "1",
      ScheduleLineDeliveryDate: date(i + 3),
      OpenPurchaseOrderQuantity: p === "6" ? 1 : 0,
    })),
  );
  await INSERT.into(`${s4}.MaterialDocumentItem`).entries(
    pos.slice(0, 5).map((p, i) => ({
      MaterialDocumentYear: "2026",
      MaterialDocument: p,
      MaterialDocumentItem: "1",
      // The last receipt falls after the proof cutoff, so the proof has an item to evaluate.
      PostingDate: i === 4 ? "2026-09-01" : `2026-0${i + 3}-15`,
      GoodsMovementType: "101",
      GoodsMovementIsCancelled: false,
      PurchaseOrder: p,
      PurchaseOrderItem: "10",
      QuantityInEntryUnit: 1,
    })),
  );
});

after(() => new Promise<void>((r) => fake.close(() => r())));

async function prepare(dryRun: boolean) {
  const { data } = await app.axios.post(
    "/odata/v4/desk/prepareDay",
    { dryRun },
    {
      auth: {
        username: "ilyesse.hettenbach@cbs-consulting.de",
        password: "alice",
      },
    },
  );
  for (let i = 0; i < 100; i++) {
    const s = await SELECT.one.from(`${NS}.Snapshot`).where({ ID: data.ID });
    if (s.status !== "running") return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("prepareDay did not finish");
}

test("dry run plans model calls and cost without runs or read-model writes", async () => {
  const factsBefore = await SELECT.from(`${NS}.ItemFact`);
  const dry = await prepare(true);
  assert.equal(dry.status, "done", dry.message);
  assert.deepEqual([...new Set(modes)], ["dry_run"]);
  assert.equal(dry.modelCalls, modes.length);
  assert.equal(dry.costUnits, 0.5 * modes.length);
  assert.match(dry.message, /^dry run: \d+ predictions planned/);
  assert.doesNotMatch(dry.message, /price batches: dry-run unavailable/);
  assert.equal((await SELECT.from("tide.core.PredictionRun")).length, 0);
  assert.equal((await SELECT.from(`${NS}.OpenItem`)).length, 0);
  assert.deepEqual(
    await SELECT.from(`${NS}.ItemFact`),
    factsBefore,
    "dry runs do not materialize source facts",
  );
  const kpis = (
    await app.axios.get("/odata/v4/desk/kpis()", {
      auth: {
        username: "ilyesse.hettenbach@cbs-consulting.de",
        password: "alice",
      },
    })
  ).data;
  assert.equal(kpis.preparedAt, null, "kpis ignore dry-run snapshots");
});

test("real preparation publishes fresh rows and reuses only matching completed snapshots", async () => {
  modes.length = 0;
  const real = await prepare(false);
  assert.equal(real.status, "done", real.message);
  assert.deepEqual([...new Set(modes)], ["predict"]);
  const runs = await SELECT.from("tide.core.PredictionRun");
  assert.ok(runs.length > 0);
  assert.equal((await SELECT.from(`${NS}.OpenItem`)).length, 1);
  const proofRows = await SELECT.from(`${NS}.ProofResult`);
  assert.ok(proofRows.length > 0, "baseline proof metrics remain available");
  assert.ok(
    proofRows.every((row: any) => row.method !== "tabpfn"),
    "fake backend is not model-quality evidence",
  );
  // Real runs record calls and cost like the dry run (tabular's cost model per run).
  assert.equal(real.modelCalls, runs.length);
  const expected = runs.reduce(
    (sum: number, r: any) => sum + Number(r.costUnits),
    0,
  );
  assert.ok(real.costUnits > 0);
  assert.ok(
    Math.abs(real.costUnits - expected) < 1e-6,
    `${real.costUnits} vs ${expected}`,
  );

  // A completed snapshot for this exact dataset is returned without rerunning
  // the preparation pipeline.
  modes.length = 0;
  const snapshotsBeforeReuse = (await SELECT.from(`${NS}.Snapshot`)).length;
  const reused = await prepare(false);
  assert.equal(reused.status, "done", reused.message);
  assert.equal(reused.ID, real.ID);
  assert.deepEqual(modes, []);
  assert.equal(
    (await SELECT.from(`${NS}.Snapshot`)).length,
    snapshotsBeforeReuse,
  );

  const newDatasetLoad = randomUUID();
  await UPDATE.entity("tide.s4.DatasetInfo")
    .where({ ID: "current" })
    .with({ loadId: newDatasetLoad });
  modes.length = 0;
  const refreshed = await prepare(false);
  assert.equal(refreshed.status, "done", refreshed.message);
  assert.notEqual(refreshed.ID, real.ID);
  assert.equal(
    refreshed.loadId,
    newDatasetLoad,
    "the fresh snapshot records the dataset load",
  );
  assert.equal(
    modes.length,
    0,
    "unchanged model inputs reuse predictions across dataset reloads",
  );

  // A feature change on the plant changes the test input fingerprint and
  // invalidates the saved prediction even when own delivery history is same.
  await INSERT.into("tide.s4.PurchaseOrder").entries({
    PurchaseOrder: "7",
    PurchaseOrderDate: "2026-09-15",
    Supplier: "S1",
    DocumentCurrency: "EUR",
  });
  await INSERT.into("tide.s4.PurchaseOrderItem").entries({
    PurchaseOrder: "7",
    PurchaseOrderItem: "10",
    Material: "M1",
    Plant: "P1",
    OrderQuantity: 1,
    NetAmount: 10,
    DocumentCurrency: "EUR",
  });
  await INSERT.into("tide.s4.PurchaseOrderScheduleLine").entries({
    PurchaseOrder: "7",
    PurchaseOrderItem: "10",
    ScheduleLine: "1",
    ScheduleLineDeliveryDate: "2026-09-30",
    OpenPurchaseOrderQuantity: 0,
  });
  // A loader refresh is a new input dataset even when asOf is unchanged.
  await UPDATE.entity("tide.s4.DatasetInfo")
    .where({ ID: "current" })
    .with({ loadId: randomUUID() });
  modes.length = 0;
  const invalidated = await prepare(false);
  assert.equal(invalidated.status, "done", invalidated.message);
  assert.notEqual(invalidated.ID, refreshed.ID);
  assert.ok(
    modes.length > 0,
    "changed representative inputs invalidate the model cache",
  );
  assert.ok(invalidated.rangesComputed > 0);
});

test("publication rolls back all staged business rows and its pointer on a final writer failure", async () => {
  const user = new cds.User.Privileged();
  const info = await SELECT.one
    .from("tide.s4.DatasetInfo")
    .where({ ID: "current" });
  const ID = cds.utils.uuid();
  await INSERT.into(`${NS}.Snapshot`).entries({
    ID,
    asOf: AS_OF,
    loadId: info.loadId,
    status: "running",
    startedAt: new Date().toISOString(),
  });
  const entities = [
    "OpenItem",
    "Cases",
    "Finding",
    "Actions",
    "PublishedCockpit",
    "CaseObservation",
    "ExposureObservation",
    "DeliveryPriorityDaily",
  ];
  const state = () =>
    Promise.all(entities.map((entity) => SELECT.from(`${NS}.${entity}`)));
  const before = await state();
  const phase = steps().find((step) => step.name === "overview")!;
  const original = phase.run;
  phase.run = async (ctx) => {
    ctx.publication!.writes.push(async () => {
      throw new Error("injected final publication failure");
    });
  };
  try {
    await assert.rejects(
      prepareDay(user, ID, AS_OF),
      /injected final publication failure/,
    );
  } finally {
    phase.run = original;
  }
  assert.deepEqual(await state(), before);
  const failed = await SELECT.one.from(`${NS}.Snapshot`).where({ ID });
  assert.equal(failed.status, "failed");
  assert.equal(failed.publishedAt, null);
  assert.ok(failed.workerToken);
  assert.equal(
    (
      await SELECT.from(`${NS}.PreparationPhase`).where({
        snapshot_ID: ID,
        status: "succeeded",
      })
    ).length,
    0,
  );
});

test("source identity changing during preparation fences publication without replacing current rows", async () => {
  const user = new cds.User.Privileged();
  const info = await SELECT.one
    .from("tide.s4.DatasetInfo")
    .where({ ID: "current" });
  const ID = cds.utils.uuid();
  await INSERT.into(`${NS}.Snapshot`).entries({
    ID,
    asOf: AS_OF,
    loadId: info.loadId,
    status: "running",
    startedAt: new Date().toISOString(),
  });
  const before = await SELECT.from(`${NS}.OpenItem`);
  const pointer = await SELECT.from(`${NS}.PublishedCockpit`);
  const phase = steps().find((step) => step.name === "overview")!;
  const original = phase.run;
  phase.run = async () => {
    await cds.tx(() =>
      UPDATE.entity("tide.s4.DatasetInfo")
        .set({ loadId: cds.utils.uuid() })
        .where({ ID: "current" }),
    );
  };
  try {
    await assert.rejects(
      prepareDay(user, ID, AS_OF),
      /source changed during preparation/,
    );
  } finally {
    phase.run = original;
    await UPDATE.entity("tide.s4.DatasetInfo")
      .set({ loadId: info.loadId })
      .where({ ID: "current" });
  }
  assert.deepEqual(await SELECT.from(`${NS}.OpenItem`), before);
  assert.deepEqual(await SELECT.from(`${NS}.PublishedCockpit`), pointer);
});

for (const fence of ["buyer", "worker", "pointer"] as const) {
  test(`${fence} changes during preparation prevent stale publication`, async () => {
    const user = new cds.User.Privileged();
    const info = await SELECT.one
      .from("tide.s4.DatasetInfo")
      .where({ ID: "current" });
    const ID = cds.utils.uuid();
    const caseID = `fence:${ID}`;
    const replacementWorker = cds.utils.uuid();
    await INSERT.into(`${NS}.Snapshot`).entries({
      ID,
      asOf: AS_OF,
      loadId: info.loadId,
      status: "running",
      startedAt: new Date().toISOString(),
    });
    const before = await SELECT.from(`${NS}.OpenItem`);
    const pointer = await SELECT.one
      .from(`${NS}.PublishedCockpit`)
      .where({ ID: "current" });
    const phase = steps().find((step) => step.name === "overview")!;
    const original = phase.run;
    phase.run = async () => {
      await cds.tx(async () => {
        if (fence === "buyer")
          await INSERT.into(`${NS}.Cases`).entries({
            ID: caseID,
            kind: "delivery",
            status: "open",
            listing: "unlisted",
            priority: 3,
          });
        if (fence === "worker")
          await UPDATE.entity(`${NS}.Snapshot`)
            .where({ ID })
            .set({ workerToken: replacementWorker });
        if (fence === "pointer")
          await cds.ql.UPSERT.into(`${NS}.PublishedCockpit`).entries({
            ID: "current",
            snapshot_ID: ID,
          });
      });
    };
    try {
      await assert.rejects(
        prepareDay(user, ID, AS_OF),
        fence === "buyer"
          ? /Buyer work changed/
          : fence === "worker"
            ? /ownership was lost/
            : /Another preparation was published/,
      );
      assert.deepEqual(await SELECT.from(`${NS}.OpenItem`), before);
      const failed = await SELECT.one.from(`${NS}.Snapshot`).where({ ID });
      assert.equal(failed.publishedAt, null);
      assert.equal(
        failed.workerToken === replacementWorker,
        fence === "worker",
        "failure cannot overwrite a replacement worker",
      );
      assert.equal(
        (await SELECT.from(`${NS}.CaseObservation`).where({ snapshot_ID: ID }))
          .length,
        0,
      );
      if (fence !== "pointer")
        assert.deepEqual(
          await SELECT.one
            .from(`${NS}.PublishedCockpit`)
            .where({ ID: "current" }),
          pointer,
        );
    } finally {
      phase.run = original;
      await cds.ql.DELETE.from(`${NS}.Cases`).where({ ID: caseID });
      if (fence === "pointer") {
        if (pointer)
          await cds.ql.UPSERT.into(`${NS}.PublishedCockpit`).entries(pointer);
        else
          await cds.ql.DELETE.from(`${NS}.PublishedCockpit`).where({
            ID: "current",
          });
      }
      await UPDATE.entity(`${NS}.Snapshot`)
        .where({ ID })
        .set({ status: "failed" });
    }
  });
}

test("required phases abort while optional evidence failure remains explicit", async () => {
  const ID = cds.utils.uuid();
  await INSERT.into(`${NS}.Snapshot`).entries({
    ID,
    asOf: AS_OF,
    status: "running",
  });
  const ctx: StepContext = {
    user: new cds.User.Privileged(),
    snapshotId: ID,
    asOf: AS_OF,
    dryRun: false,
    meter: {
      user: new cds.User.Privileged(),
      calls: 0,
      cost: 0,
      runs: [],
      planned: [],
      backend: null,
      failed: [],
    },
    publication: { writes: [] },
  };
  let later = false;
  const errors = await runSteps(ctx, [
    {
      name: "optional-proof",
      required: false,
      run: async () => {
        ctx.publication!.writes.push(async () => undefined);
        throw new Error("quality unavailable");
      },
    },
    {
      name: "required-source",
      run: async () => {
        later = true;
      },
    },
  ]);
  assert.equal(later, true);
  assert.equal(ctx.publication!.writes.length, 0);
  assert.match(errors[0], /quality unavailable/);
  assert.equal(
    (
      await SELECT.one
        .from(`${NS}.PreparationPhase`)
        .where({ snapshot_ID: ID, name: "optional-proof" })
    ).status,
    "failed",
  );
  await assert.rejects(
    runSteps(ctx, [
      {
        name: "required-failure",
        run: async () => {
          throw new Error("source unavailable");
        },
      },
    ]),
    /source unavailable/,
  );
  await UPDATE.entity(`${NS}.Snapshot`).set({ status: "failed" }).where({ ID });
});

test("run observations and daily projections roll back together and do not overwrite earlier evidence", async () => {
  const ID = cds.utils.uuid();
  await INSERT.into(`${NS}.Snapshot`).entries({
    ID,
    asOf: AS_OF,
    status: "running",
  });
  const before = await SELECT.from(`${NS}.DeliveryPriorityDaily`);
  await assert.rejects(
    cds.tx(async () => {
      await observePublication(ID, AS_OF, new Date().toISOString(), true);
      throw new Error("observation rollback");
    }),
    /observation rollback/,
  );
  assert.deepEqual(await SELECT.from(`${NS}.DeliveryPriorityDaily`), before);
  assert.equal(
    (await SELECT.from(`${NS}.CaseObservation`).where({ snapshot_ID: ID }))
      .length,
    0,
  );
  await UPDATE.entity(`${NS}.Snapshot`).set({ status: "failed" }).where({ ID });
});

test("publication values linked demand once and reports distinct unvalued demand", async () => {
  await assert.rejects(
    cds.tx(async () => {
      await UPDATE.entity(`${NS}.Cases`).set({ listing: "unlisted" });
      const snapshotID = cds.utils.uuid();
      await INSERT.into(`${NS}.Snapshot`).entries({
        ID: snapshotID,
        asOf: AS_OF,
        status: "running",
      });
      await INSERT.into(`${NS}.Cases`).entries(
        ["PUB1", "PUB2", "PUB3", "PUB4"].map((ID, index) => ({
          ID,
          kind: "delivery",
          status: index === 3 ? "closed" : "open",
          listing: index === 2 ? "unlisted" : "listed",
          priority: 1,
          Plant: "P1",
          PurchasingGroup: "A01",
        })),
      );
      await INSERT.into(`${NS}.DeliveryRisks`).entries(
        ["PUB1", "PUB2", "PUB3", "PUB4"].map((header_ID, index) => ({
          header_ID,
          PurchaseOrder: header_ID,
          PurchaseOrderItem: "10",
          phase: index === 1 ? "overdue" : "at_risk",
        })),
      );
      await INSERT.into(`${NS}.SalesOrderImpact`).entries([
        {
          PurchaseOrder: "PUB1",
          PurchaseOrderItem: "10",
          SalesOrder: "VALUE",
          SalesOrderItem: "10",
          RevenueAtRisk: 100,
          Currency: "EUR",
        },
        {
          PurchaseOrder: "PUB2",
          PurchaseOrderItem: "10",
          SalesOrder: "VALUE",
          SalesOrderItem: "10",
          RevenueAtRisk: 120,
          Currency: "EUR",
        },
        {
          PurchaseOrder: "PUB1",
          PurchaseOrderItem: "10",
          SalesOrder: "NULL",
          SalesOrderItem: "10",
          RevenueAtRisk: null,
          Currency: "EUR",
        },
        {
          PurchaseOrder: "PUB2",
          PurchaseOrderItem: "10",
          SalesOrder: "NULL",
          SalesOrderItem: "10",
          RevenueAtRisk: null,
          Currency: "EUR",
        },
        {
          PurchaseOrder: "PUB1",
          PurchaseOrderItem: "10",
          SalesOrder: "USD",
          SalesOrderItem: "10",
          RevenueAtRisk: 50,
          Currency: "USD",
        },
        {
          PurchaseOrder: "PUB3",
          PurchaseOrderItem: "10",
          SalesOrder: "HIDDEN",
          SalesOrderItem: "10",
          RevenueAtRisk: 900,
          Currency: "EUR",
        },
        {
          PurchaseOrder: "PUB4",
          PurchaseOrderItem: "10",
          SalesOrder: "CLOSED",
          SalesOrderItem: "10",
          RevenueAtRisk: 900,
          Currency: "EUR",
        },
      ]);
      const totals = await observePublication(
        snapshotID,
        AS_OF,
        new Date().toISOString(),
        true,
      );
      assert.equal(totals.revenueAtRisk, 120);
      assert.equal(totals.unvaluedDemands, 2);
      assert.equal(totals.overdue, 1);
      const exposures = await SELECT.from(`${NS}.ExposureObservation`).where({
        snapshot_ID: snapshotID,
      });
      assert.equal(exposures.length, 5);
      assert.equal(
        exposures.filter((row: any) => row.valuationStatus === "unvalued")
          .length,
        3,
      );
      assert.ok(
        exposures.every(
          (row: any) => row.Plant === "P1" && row.PurchasingGroup === "A01",
        ),
      );
      const nextID = cds.utils.uuid();
      await INSERT.into(`${NS}.Snapshot`).entries({
        ID: nextID,
        asOf: AS_OF,
        status: "running",
      });
      assert.deepEqual(
        await observePublication(nextID, AS_OF, new Date().toISOString(), true),
        totals,
      );
      assert.deepEqual(
        await SELECT.from(`${NS}.ExposureObservation`).where({
          snapshot_ID: snapshotID,
        }),
        exposures,
      );
      const transientID = cds.utils.uuid();
      assert.deepEqual(
        await observePublication(
          transientID,
          AS_OF,
          new Date().toISOString(),
          false,
        ),
        totals,
      );
      assert.equal(
        (
          await SELECT.from(`${NS}.ExposureObservation`).where({
            snapshot_ID: transientID,
          })
        ).length,
        0,
      );
      await UPDATE.entity(`${NS}.SalesOrderImpact`)
        .where({ PurchaseOrder: { in: ["PUB1", "PUB2"] } })
        .set({ RevenueAtRisk: 0, Currency: "EUR" });
      assert.equal(
        (
          await observePublication(
            transientID,
            AS_OF,
            new Date().toISOString(),
            false,
          )
        ).unvaluedDemands,
        0,
      );
      await UPDATE.entity(`${NS}.Cases`)
        .where({ ID: { in: ["PUB1", "PUB2"] } })
        .set({ listing: "unlisted" });
      const absent = await observePublication(
        transientID,
        AS_OF,
        new Date().toISOString(),
        false,
      );
      assert.equal(absent.revenueAtRisk, 0);
      assert.equal(absent.unvaluedDemands, 0);
      throw new Error("publication fixture rollback");
    }),
    /publication fixture rollback/,
  );
});

test("customer quantile exposure deduplicates linked demand independently at P50 and P80", () => {
  const demand = {
    Customer: "C1",
    CustomerName: "Customer",
    SalesOrder: "SO1",
    SalesOrderItem: "10",
    PurchaseOrderItem: "10",
  };
  const result = customerRisks(
    [
      {
        ...demand,
        PurchaseOrder: "PO1",
        openAmount: 100,
        atRiskP50: false,
        atRiskP80: true,
        link: "upper_bound",
      },
      {
        ...demand,
        PurchaseOrder: "PO2",
        openAmount: 120,
        atRiskP50: false,
        atRiskP80: true,
        link: "direct",
      },
      {
        ...demand,
        PurchaseOrder: "PO2",
        SalesOrderItem: "20",
        openAmount: 30,
        atRiskP50: true,
        atRiskP80: true,
        link: "direct",
      },
    ],
    [
      { PurchaseOrder: "PO1", PurchaseOrderItem: "10", delayP80Days: 2 },
      { PurchaseOrder: "PO2", PurchaseOrderItem: "10", delayP80Days: 4 },
    ],
    "run",
  );
  assert.deepEqual(result, [
    {
      Customer: "C1",
      CustomerName: "Customer",
      snapshot_ID: "run",
      revenueAtRiskP50: 30,
      revenueAtRiskP80: 150,
      openAmount: 150,
      items: 2,
      salesItems: 2,
      worstDelayDays: 4,
      directShare: 1,
    },
  ]);
});

test("purchase prices are prepared in a batch and interactive lookups never call the model", async () => {
  await INSERT.into("tide.s4.PurchaseOrder").entries([
    {
      PurchaseOrder: "PRICE1",
      PurchaseOrderDate: "2026-08-01",
      Supplier: "S1",
      DocumentCurrency: "EUR",
    },
    {
      PurchaseOrder: "PRICE2",
      PurchaseOrderDate: "2026-09-01",
      Supplier: "S1",
      DocumentCurrency: "EUR",
    },
  ]);
  await INSERT.into("tide.s4.PurchaseOrderItem").entries([
    {
      PurchaseOrder: "PRICE1",
      PurchaseOrderItem: "10",
      Material: "PM1",
      Plant: "P1",
      OrderQuantity: 5,
      PurchaseOrderQuantityUnit: "PC",
      NetPriceAmount: 10,
      NetPriceQuantity: 1,
      DocumentCurrency: "EUR",
    },
    {
      PurchaseOrder: "PRICE2",
      PurchaseOrderItem: "10",
      Material: "PM2",
      Plant: "P1",
      OrderQuantity: 5,
      PurchaseOrderQuantityUnit: "PC",
      NetPriceAmount: 12,
      NetPriceQuantity: 1,
      DocumentCurrency: "EUR",
    },
  ]);
  const user = new cds.User.Privileged();
  const rows = await syncPriceModelRows();
  modes.length = 0;
  await preparePurchasePrices(user, AS_OF, rows);
  assert.equal(modes.length, 1, "one currency/unit batch for both sources");
  const stored = await SELECT.from(`${NS}.PurchasePriceEstimate`);
  assert.equal(stored.length, 2);
  assert.equal(
    (await SELECT.from(`${NS}.PriceModelRow`).where({ rowKind: "estimate" }))
      .length,
    0,
  );
  modes.length = 0;
  const input = {
    Material: "PM1",
    Plant: "P1",
    Supplier: "S1",
    quantity: 5,
    unit: "PC",
    currency: "EUR",
    asOf: AS_OF,
  };
  const price = await estimatePurchasePrice(input, user);
  assert.equal(
    price.source,
    "fake",
    JSON.stringify({
      price,
      runs: await SELECT.from("tide.core.PredictionRun"),
    }),
  );
  assert.ok(price.p50 > 0);
  assert.equal(price.historicalReference, 10);
  assert.deepEqual(await estimatePurchasePrice(input, user), price);
  assert.equal(
    (await estimatePurchasePrice({ ...input, quantity: 6 }, user)).source,
    "unavailable",
  );
  assert.equal(
    (await estimatePurchasePrice({ ...input, asOf: "2026-10-06" }, user))
      .source,
    "unavailable",
  );
  assert.deepEqual(
    modes,
    [],
    "cache hits and misses must never invoke tabular",
  );
  priceRequests.length = 0;
  const changed = await withPredictionOptions(true, () =>
    estimatePurchasePrice({ ...input, quantity: 6 }, user),
  );
  assert.ok(changed.p50 > 0);
  assert.equal(changed.assumedQuantity, 6);
  const request = priceRequests.at(-1)!;
  const quantityColumn = request.columns.findIndex(
    (column: any) => column.name === "OrderQuantity",
  );
  assert.equal(request.x_test[0][quantityColumn], 6);
  for (const unsupported of [{ unit: "BOX" }, { currency: "USD" }]) {
    priceRequests.length = 0;
    const result = await withPredictionOptions(true, () =>
      estimatePurchasePrice({ ...input, ...unsupported }, user),
    );
    assert.equal(result.source, "unavailable");
    assert.equal(priceRequests.length, 0);
  }
});

test("rules dry-run plans purchase prices and recent assessments without publication", async () => {
  await INSERT.into("tide.s4.PurchaseOrder").entries({
    PurchaseOrder: "DAILYPRICE",
    PurchaseOrderDate: "2026-09-25",
    Supplier: "S1",
    DocumentCurrency: "EUR",
  });
  await INSERT.into("tide.s4.PurchaseOrderItem").entries({
    PurchaseOrder: "DAILYPRICE",
    PurchaseOrderItem: "10",
    Material: "PM1",
    Plant: "P1",
    OrderQuantity: 5,
    PurchaseOrderQuantityUnit: "PC",
    NetPriceAmount: 15,
    NetPriceQuantity: 1,
    DocumentCurrency: "EUR",
  });
  const user = new cds.User.Privileged();
  const meter: Meter = {
    user,
    calls: 0,
    cost: 0,
    runs: [],
    planned: [],
    backend: null,
    failed: [],
  };
  const tables = [
    "PriceModelRow",
    "PurchasePriceEstimate",
    "PriceAssessment",
    "PriceModelValidation",
    "Cases",
    "Finding",
  ];
  const state = async () =>
    Promise.all([
      ...tables.map((table) => SELECT.from(`${NS}.${table}`)),
      SELECT.from("tide.core.PredictionRun"),
    ]);
  const before = await state();
  priceRequests.length = 0;
  await runRules({
    user,
    meter,
    asOf: AS_OF,
    dryRun: true,
    snapshotId: "price-dry-run",
  });
  assert.equal(priceRequests.length, 2);
  assert.ok(priceRequests.every((request) => request.mode === "dry_run"));
  assert.deepEqual(meter.failed, []);
  assert.deepEqual(meter.planned, [
    "purchase prices EUR/PC",
    "price assessment 2026-09-25 EUR/PC",
  ]);
  assert.deepEqual(await state(), before);
});

test("price dry-run plans the exact execution matrices without staging, runs or business writes", async () => {
  const user = new cds.User.Privileged();
  const rows = await syncPriceModelRows();
  const tables = [
    "PriceModelRow",
    "PurchasePriceEstimate",
    "PriceAssessment",
    "PriceModelValidation",
  ];
  const state = async () =>
    Promise.all([
      ...tables.map((table) => SELECT.from(`${NS}.${table}`)),
      SELECT.from("tide.core.PredictionRun"),
    ]);
  const before = await state();
  const meter: Meter = {
    user,
    calls: 0,
    cost: 0,
    runs: [],
    planned: [],
    backend: null,
    failed: [],
  };
  const input = {
    Material: "PM1",
    Plant: "P1",
    Supplier: "S1",
    quantity: 6,
    unit: "PC",
    currency: "EUR",
    asOf: AS_OF,
  };
  const candidates = rows.filter((row) => row.PurchaseOrder === "PRICE2");
  priceRequests.length = 0;
  await preparePurchasePrices(user, AS_OF, rows, meter, input, true);
  await assessPriceCandidates(user, AS_OF, candidates, meter, rows, true, true);
  const planned = [...priceRequests];
  assert.equal(planned.length, 2);
  assert.ok(planned.every((request) => request.mode === "dry_run"));
  assert.deepEqual(meter.failed, []);
  assert.equal(meter.calls, planned.length);
  assert.deepEqual(await state(), before);
  priceRequests.length = 0;
  await withPredictionOptions(true, async () => {
    await preparePurchasePrices(user, AS_OF, rows, undefined, input);
    await assessPriceCandidates(user, AS_OF, candidates, undefined, rows, true);
  });
  const executed = [...priceRequests];
  const comparable = (request: any) => ({
    ...request,
    mode: undefined,
    keys: request.keys.map((key: string) =>
      key.startsWith("estimate:") ? "estimate" : key,
    ),
  });
  assert.deepEqual(executed.map(comparable), planned.map(comparable));
  const quantityColumn = planned[0].columns.findIndex(
    (column: any) => column.name === "OrderQuantity",
  );
  assert.equal(planned[0].x_test[0][quantityColumn], 6);
  assert.equal(
    (await SELECT.from(`${NS}.PriceModelRow`).where({ rowKind: "estimate" }))
      .length,
    0,
  );
});

test("read-only price rows use the same selection, scope and sampling as persisted rows", async () => {
  const model = cds.model;
  assert.ok(model);
  const { feed, spec } = normalizeSpec(
    {
      feed: "CockpitPriceFeed",
      target: "LogUnitPrice",
      task: "regression",
      features: ["Material", "Plant", "OrderQuantity"],
      train: {
        filter: [
          { col: "Currency", op: "=", value: "EUR" },
          { col: "OrderUnit", op: "in", values: ["PC"] },
          { col: "PurchaseOrderDate", op: "<", value: "2026-09-01" },
        ],
        exclude: [{ col: "PurchaseOrder", values: ["PRICE2"] }],
      },
      predict: { keys: ["PRICE2/10"] },
      output: { type: "quantiles", levels: [0.1, 0.5, 0.9] },
    },
    feedRegistry(model),
  );
  const rows = await SELECT.from(feed.entity);
  const limits = { maxContextRows: 1, maxClasses: 160, seed: "price-parity" };
  // Callers without a user see no rows; parity is checked unscoped.
  const build = (...args: Parameters<typeof buildRequest>) =>
    cds.tx({ user: cds.User.privileged }, () => buildRequest(...args));
  const persisted = await build(feed, spec, limits);
  assert.deepEqual(await build(feed, spec, limits, rows), persisted);
  assert.equal(persisted.y_train.length, 1);
  for (const clause of [
    { col: "Currency", op: "!=", value: "USD" },
    { col: "OrderQuantity", op: "<", value: 6 },
    { col: "OrderQuantity", op: "<=", value: 5 },
    { col: "OrderQuantity", op: ">", value: 4 },
    { col: "OrderQuantity", op: ">=", value: 5 },
    { col: "MaterialGroup", op: "isNull", value: null },
  ]) {
    const filtered = {
      ...spec,
      train: { ...spec.train, filter: [...spec.train.filter, clause] },
    };
    const selected = await build(feed, filtered, limits);
    assert.equal(selected.y_train.length, 1, clause.op);
    assert.deepEqual(
      await build(feed, filtered, limits, rows),
      selected,
      clause.op,
    );
  }
  const user = new cds.User({
    id: "other-plant",
    roles: ["user"],
    attr: { Plant: "P2" },
  });
  for (const sourceRows of [undefined, rows]) {
    await assert.rejects(
      cds.tx({ user }, () => buildRequest(feed, spec, limits, sourceRows)),
      (error: any) => error.code === "NO_TRAINING_DATA",
    );
  }
});
