import cds from "@sap/cds";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  plantContextFingerprint,
  ranges,
  sourceFingerprint,
} from "../srv/cockpit/prepare/ranges";
import { materializeFacts } from "../srv/cockpit/prepare";
import { latestItem } from "../srv/cockpit/leadtimes/data";
import { preparePurchasePrices } from "../srv/cockpit/rules/price-model";
import { empiricalGrid } from "../srv/cockpit/logic";
import { upsertDetectorCase } from "../srv/cockpit/kernel/detector-writers";
import { reconcileDeliveryProblem as reconcileDeliveryProblemRaw } from "../srv/cockpit/kernel/problem-reconciliation";
import {
  registerCallGuard,
  resetCallSeams,
  withPredictionOptions,
  type Meter,
} from "../srv/cockpit/kernel/model-calls";

const app = cds.test(path.join(__dirname, ".."));
const { INSERT, SELECT, UPDATE } = cds.ql;
// Workflow commands require a trusted caller; reconciliation runs as the system.
const reconcileDeliveryProblem = (...a: Parameters<typeof reconcileDeliveryProblemRaw>) =>
  cds.tx({ user: new cds.User.Privileged() } as any, () => reconcileDeliveryProblemRaw(...a));
const S4 = "tide.s4";
const COCKPIT = "tide.cockpit";
let health: Server;
let runtimeIdentity = "receipt-tests-v1";

before(async () => {
  health = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        status: "ok",
        backend: "fake",
        identity: runtimeIdentity,
      }),
    );
  });
  await new Promise<void>((resolve) => health.listen(0, "127.0.0.1", resolve));
  (cds.env.requires as any).tabular.credentials = {
    url: `http://127.0.0.1:${(health.address() as any).port}`,
  };
  await app;
});

after(() => new Promise<void>((resolve) => health.close(() => resolve())));

test("delivery reconciliation retains missing and incomplete source obligations", async () => {
  const PurchaseOrder = "RECONSAFE";
  const PurchaseOrderItem = "10";
  const caseID = `delivery:${PurchaseOrder}/${PurchaseOrderItem}`;
  await upsertDetectorCase({
    list: "at_risk",
    objectKey: `${PurchaseOrder}/${PurchaseOrderItem}`,
    PurchaseOrder,
    PurchaseOrderItem,
    Material: "M1",
    Supplier: "S1",
    Plant: "DE11",
    PurchasingGroup: "D01",
    itemTitle: "Source reconciliation safety",
    dueDate: "2026-10-01",
    source: "rule",
    nextActionKind: "reminder",
  });
  const initialEvents = await SELECT.from(`${COCKPIT}.CaseEvents`).where({
    header_ID: caseID,
  });
  const assertOutstanding = async () => {
    const result = await reconcileDeliveryProblem(
      PurchaseOrder,
      PurchaseOrderItem,
      "recompute",
    );
    assert.equal(result.resolved, false);
    const current = await SELECT.one
      .from(`${COCKPIT}.Cases`)
      .where({ ID: caseID });
    assert.equal(current.status, "open");
    assert.equal(current.closure, null);
    assert.deepEqual(
      await SELECT.from(`${COCKPIT}.CaseEvents`).where({ header_ID: caseID }),
      initialEvents,
    );
  };
  await assertOutstanding();
  await INSERT.into(`${S4}.PurchaseOrder`).entries({
    PurchaseOrder,
    PurchaseOrderDate: "2026-09-01",
    Supplier: "S1",
  });
  await INSERT.into(`${S4}.PurchaseOrderItem`).entries({
    PurchaseOrder,
    PurchaseOrderItem,
    Material: "M1",
    Plant: "DE11",
    OrderQuantity: 10,
  });
  await assertOutstanding();
  await INSERT.into(`${S4}.PurchaseOrderScheduleLine`).entries({
    PurchaseOrder,
    PurchaseOrderItem,
    ScheduleLine: "1",
    OpenPurchaseOrderQuantity: 4,
  });
  await assertOutstanding();
  await UPDATE.entity(`${S4}.PurchaseOrderItem`)
    .where({ PurchaseOrder, PurchaseOrderItem })
    .with({ IsCompletelyDelivered: true });
  assert.equal(
    (
      await reconcileDeliveryProblem(
        PurchaseOrder,
        PurchaseOrderItem,
        "recompute",
      )
    ).resolved,
    true,
  );
  await reconcileDeliveryProblem(PurchaseOrder, PurchaseOrderItem, "recompute");
  assert.equal(
    (
      await SELECT.from(`${COCKPIT}.CaseEvents`).where({
        header_ID: caseID,
        event: "source_resolved",
      })
    ).length,
    1,
  );
});

test("a PO deletion indicator never proves delivery fulfillment from zero schedules", async () => {
  const PurchaseOrder = "RECONDEL";
  const PurchaseOrderItem = "10";
  const caseID = `delivery:${PurchaseOrder}/${PurchaseOrderItem}`;
  await upsertDetectorCase({
    list: "at_risk", objectKey: `${PurchaseOrder}/${PurchaseOrderItem}`,
    PurchaseOrder, PurchaseOrderItem, Material: "M1", Supplier: "S1",
    Plant: "DE11", PurchasingGroup: "D01", itemTitle: "Deletion is not delivery",
    source: "rule", nextActionKind: "reminder",
  });
  await INSERT.into(`${S4}.PurchaseOrder`).entries({ PurchaseOrder, Supplier: "S1", PurchaseOrderDate: "2026-09-01" });
  await INSERT.into(`${S4}.PurchaseOrderItem`).entries({
    PurchaseOrder, PurchaseOrderItem, Material: "M1", Plant: "DE11", OrderQuantity: 10,
    IsCompletelyDelivered: true, PurchasingDocumentDeletionCode: "L",
  });
  await INSERT.into(`${S4}.PurchaseOrderScheduleLine`).entries({
    PurchaseOrder, PurchaseOrderItem, ScheduleLine: "1", OpenPurchaseOrderQuantity: 0,
  });
  const history = await SELECT.from(`${COCKPIT}.CaseEvents`).where({ header_ID: caseID });
  for (const indicator of ["L", "S"]) {
    await UPDATE.entity(`${S4}.PurchaseOrderItem`).where({ PurchaseOrder, PurchaseOrderItem })
      .with({ PurchasingDocumentDeletionCode: indicator });
    const result = await reconcileDeliveryProblem(PurchaseOrder, PurchaseOrderItem, "recompute");
    assert.equal(result.resolved, false);
    assert.equal(result.openQuantity, null);
    const current = await SELECT.one.from(`${COCKPIT}.Cases`).where({ ID: caseID });
    assert.equal(current.status, "open");
    assert.equal(current.closure, null);
    assert.deepEqual(await SELECT.from(`${COCKPIT}.CaseEvents`).where({ header_ID: caseID }), history);
  }
});

test("canceled movements do not contribute receipt or two-step evidence", async () => {
  await INSERT.into(`${S4}.MaterialDocumentItem`).entries([
    ...["101", "107", "109"].map((movement, index) => ({
      MaterialDocumentYear: "2026",
      MaterialDocument: `CANCEL${index}`,
      MaterialDocumentItem: "1",
      PurchaseOrder: "RECEIPT1",
      PurchaseOrderItem: "10",
      PostingDate: "2026-02-02",
      GoodsMovementType: movement,
      GoodsMovementIsCancelled: true,
      QuantityInEntryUnit: 100,
    })),
    {
      MaterialDocumentYear: "2026",
      MaterialDocument: "VALID1",
      MaterialDocumentItem: "1",
      PurchaseOrder: "RECEIPT1",
      PurchaseOrderItem: "10",
      PostingDate: "2026-02-05",
      GoodsMovementType: "101",
      GoodsMovementIsCancelled: false,
      QuantityInEntryUnit: 4,
    },
  ]);

  const receipt = await SELECT.one.from(`${COCKPIT}.ItemReceipt`).where({
    PurchaseOrder: "RECEIPT1",
    PurchaseOrderItem: "10",
  });
  assert.equal(receipt.ArrivalDate, "2026-02-05");
  assert.equal(receipt.AvailableDate, "2026-02-05");
  assert.equal(receipt.ReceivedQuantity, 4);
  assert.equal(receipt.TwoStep, 0);
});

test("canceled-only movements do not establish availability", async () => {
  await INSERT.into(`${S4}.MaterialDocumentItem`).entries({
    MaterialDocumentYear: "2026",
    MaterialDocument: "CANCELONLY",
    MaterialDocumentItem: "1",
    PurchaseOrder: "RECEIPT2",
    PurchaseOrderItem: "10",
    PostingDate: "2026-02-02",
    GoodsMovementType: "109",
    GoodsMovementIsCancelled: true,
    QuantityInEntryUnit: 10,
  });

  const receipt = await SELECT.one.from(`${COCKPIT}.ItemReceipt`).where({
    PurchaseOrder: "RECEIPT2",
    PurchaseOrderItem: "10",
  });
  assert.equal(receipt.AvailableDate, null);
  assert.equal(receipt.ReceivedQuantity, 0);
});

test("first-day partial label survives later fulfillment and aggregates split postings", async () => {
  await INSERT.into(`${S4}.PurchaseOrder`).entries({
    PurchaseOrder: "PARTFIRST",
    PurchaseOrderDate: "2026-02-01",
    Supplier: "S1",
  });
  await INSERT.into(`${S4}.PurchaseOrderItem`).entries({
    PurchaseOrder: "PARTFIRST",
    PurchaseOrderItem: "10",
    Material: "FIRST",
    Plant: "P1",
    OrderQuantity: 10,
    PurchaseOrderQuantityUnit: "EA",
  });
  const receipt = (document: string, date: string, quantity: number) => ({
    MaterialDocumentYear: "2026",
    MaterialDocument: document,
    MaterialDocumentItem: "1",
    PurchaseOrder: "PARTFIRST",
    PurchaseOrderItem: "10",
    PostingDate: date,
    GoodsMovementType: "101",
    GoodsMovementIsCancelled: false,
    QuantityInEntryUnit: quantity,
    EntryUnit: "EA",
  });
  await INSERT.into(`${S4}.MaterialDocumentItem`).entries([
    receipt("FIRSTA", "2026-02-05", 2),
    receipt("FIRSTB", "2026-02-05", 2),
  ]);
  const initial = await SELECT.one.from(`${COCKPIT}.ItemFactSource`).where({
    PurchaseOrder: "PARTFIRST",
  });
  assert.equal(initial.PartialFirstReceipt, true);
  await INSERT.into(`${S4}.MaterialDocumentItem`).entries(
    receipt("LATER", "2026-02-15", 6),
  );
  const completed = await SELECT.one.from(`${COCKPIT}.ItemFactSource`).where({
    PurchaseOrder: "PARTFIRST",
  });
  assert.equal(completed.ReceivedQuantity, 10);
  assert.equal(completed.AvailableDate, "2026-02-05");
  assert.equal(completed.PartialFirstReceipt, true);
  await UPDATE.entity(`${S4}.MaterialDocumentItem`)
    .where({ MaterialDocument: "FIRSTB" })
    .with({ QuantityInEntryUnit: 8 });
  const fullFirst = await SELECT.one.from(`${COCKPIT}.ItemFactSource`).where({
    PurchaseOrder: "PARTFIRST",
  });
  assert.equal(fullFirst.PartialFirstReceipt, false);
  for (const unit of ["KG", null]) {
    await UPDATE.entity(`${S4}.MaterialDocumentItem`)
      .where({ MaterialDocument: "FIRSTB" })
      .with({ EntryUnit: unit });
    const incompatible = await SELECT.one
      .from(`${COCKPIT}.ItemFactSource`)
      .where({
        PurchaseOrder: "PARTFIRST",
      });
    assert.equal(incompatible.PartialFirstReceipt, null);
  }
});

test("range fingerprints include effective open features and exclude future orders", async () => {
  await INSERT.into(`${S4}.PurchaseOrder`).entries({
    PurchaseOrder: "CACHE1",
    PurchaseOrderDate: "2026-02-01",
    Supplier: "S1",
  });
  await INSERT.into(`${S4}.PurchaseOrderItem`).entries({
    PurchaseOrder: "CACHE1",
    PurchaseOrderItem: "10",
    Material: "CACHE",
    Plant: "C1",
    OrderQuantity: 4,
  });
  const initial = await plantContextFingerprint("C1", "2026-10-05");
  await UPDATE.entity(`${S4}.PurchaseOrderItem`)
    .where({ PurchaseOrder: "CACHE1", PurchaseOrderItem: "10" })
    .with({ OrderQuantity: 8 });
  const changed = await plantContextFingerprint("C1", "2026-10-05");
  assert.notEqual(
    changed,
    initial,
    "changed effective inputs invalidate reuse",
  );
  runtimeIdentity = "receipt-tests-v2";
  assert.notEqual(await plantContextFingerprint("C1", "2026-10-05"), changed);
  runtimeIdentity = "receipt-tests-v1";

  await INSERT.into(`${S4}.PurchaseOrder`).entries({
    PurchaseOrder: "CACHE2",
    PurchaseOrderDate: "2026-11-01",
    Supplier: "S1",
  });
  await INSERT.into(`${S4}.PurchaseOrderItem`).entries({
    PurchaseOrder: "CACHE2",
    PurchaseOrderItem: "10",
    Material: "CACHE",
    Plant: "C1",
    OrderQuantity: 99,
  });
  assert.equal(
    await plantContextFingerprint("C1", "2026-10-05"),
    changed,
    "future source inputs are outside the current prediction context",
  );
});

test("forced range refresh bypasses the stored business cache before admission", async () => {
  const needed = [{ Material: "FORCE", Supplier: "S1", Plant: "F2" }];
  const asOf = "2026-10-05";
  await INSERT.into(`${COCKPIT}.ItemFact`).entries({
    PurchaseOrder: "FORCE1",
    PurchaseOrderItem: "10",
    PurchaseOrderDate: "2026-02-01",
    Material: "FORCE",
    Supplier: "S1",
    Plant: "F2",
    RequestedGapDays: 5,
  });
  await INSERT.into(`${COCKPIT}.SourceRange`).entries({
    ...needed[0],
    source: "tabpfn",
    fingerprint: sourceFingerprint(
      [],
      "FORCE1/10",
      await plantContextFingerprint("F2", asOf),
    ),
    quantiles: JSON.stringify(empiricalGrid([5, 10, 15, 20])),
  });
  const meter: Meter = {
    user: new cds.User.Privileged(),
    calls: 0,
    cost: 0,
    runs: [],
    planned: [],
    backend: null,
    failed: [],
  };
  const cached = await ranges(new Map(), needed, asOf, false, meter);
  assert.equal(cached.get("FORCE|S1|F2")?.reused, true);
  let admissions = 0;
  registerCallGuard(async () => {
    admissions++;
    throw new Error("forced admission; no provider dispatch");
  });
  try {
    await assert.rejects(
      withPredictionOptions(true, () =>
        ranges(new Map(), needed, asOf, false, meter),
      ),
      /forced admission/,
    );
    assert.equal(admissions, 1);
  } finally {
    resetCallSeams();
  }
});

test("fact replacement respects the worker transaction and source projection", async () => {
  await INSERT.into(`${S4}.PurchaseOrder`).entries({
    PurchaseOrder: "FACT1",
    PurchaseOrderDate: "2026-02-01",
    Supplier: "S1",
  });
  await INSERT.into(`${S4}.PurchaseOrderItem`).entries({
    PurchaseOrder: "FACT1",
    PurchaseOrderItem: "10",
    Material: "FACT",
    Plant: "F1",
    OrderQuantity: 8,
  });
  await INSERT.into(`${COCKPIT}.ItemFact`).entries({
    PurchaseOrder: "PRIOR",
    PurchaseOrderItem: "10",
    OrderQuantity: 9,
  });
  await assert.rejects(
    cds.tx(async () => {
      await materializeFacts();
      throw new Error("injected preparation failure");
    }),
    /injected preparation failure/,
  );
  const preserved = await SELECT.one.from(`${COCKPIT}.ItemFact`).where({
    PurchaseOrder: "PRIOR",
    PurchaseOrderItem: "10",
  });
  assert.equal(preserved.OrderQuantity, 9);

  await cds.tx(() => materializeFacts());
  assert.equal(
    await SELECT.one.from(`${COCKPIT}.ItemFact`).where({
      PurchaseOrder: "PRIOR",
      PurchaseOrderItem: "10",
    }),
    undefined,
  );
  const source = await SELECT.one.from(`${COCKPIT}.ItemFactSource`).where({
    PurchaseOrder: "FACT1",
    PurchaseOrderItem: "10",
  });
  const facts = await SELECT.one.from(`${COCKPIT}.ItemFact`).where({
    PurchaseOrder: "FACT1",
    PurchaseOrderItem: "10",
  });
  assert.deepEqual(facts, source);
});

test("range representatives exclude purchase orders after the as-of cutoff", async () => {
  await INSERT.into(`${COCKPIT}.ItemFact`).entries([
    {
      PurchaseOrder: "REP1",
      PurchaseOrderItem: "10",
      PurchaseOrderDate: "2026-02-01",
      Material: "REP",
      Supplier: "S1",
      Plant: "R1",
    },
    {
      PurchaseOrder: "REP2",
      PurchaseOrderItem: "10",
      PurchaseOrderDate: "2026-11-01",
      Material: "REP",
      Supplier: "S1",
      Plant: "R1",
    },
  ]);
  const selected = await latestItem(
    { Material: "REP", Supplier: "S1", Plant: "R1" },
    "2026-10-05",
  );
  assert.equal(selected?.PurchaseOrder, "REP1");
  const missing = await latestItem(
    { Material: "REP", Supplier: "S1", Plant: "R1" },
    "2026-01-01",
  );
  assert.equal(
    missing,
    undefined,
    "no historical representative stays unavailable",
  );
});

test("overlapping price refreshes own separate staging and scoped cleanup", async () => {
  const row = {
    PurchaseOrder: "PRICEOWN",
    PurchaseOrderItem: "10",
    PurchaseOrderDate: "2026-02-01",
    Material: "PRICEOWN",
    Plant: "C1",
    Supplier: "S1",
    OrderQuantity: 1,
    OrderUnit: "EA",
    Currency: "EUR",
    NetPriceAmount: 10,
    NetPriceQuantity: 1,
  };
  const scope = {
    Material: row.Material,
    Plant: row.Plant,
    Supplier: row.Supplier,
    quantity: row.OrderQuantity,
    unit: row.OrderUnit,
    currency: row.Currency,
    asOf: "2026-10-05",
  };
  let releaseFirst!: () => void;
  let announceFirst!: () => void;
  const firstReady = new Promise<void>((resolve) => {
    announceFirst = resolve;
  });
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let admissions = 0;
  let overlappingKeys: string[] = [];
  registerCallGuard(async () => {
    admissions++;
    if (admissions === 1) {
      announceFirst();
      await firstBlocked;
    } else {
      const rows = await SELECT.from(`${COCKPIT}.PriceModelRow`)
        .columns("id")
        .where({ rowKind: "estimate" });
      overlappingKeys = rows.map((entry: { id: string }) => entry.id);
    }
    throw new Error("injected admission failure; no provider dispatch");
  });
  const user = new cds.User.Privileged();
  const first = preparePurchasePrices(
    user,
    scope.asOf,
    [row],
    undefined,
    scope,
  );
  await firstReady;
  try {
    await preparePurchasePrices(user, scope.asOf, [row], undefined, scope);
    assert.equal(
      new Set(overlappingKeys).size,
      2,
      "identical inputs have independent staging keys",
    );
    const remaining = await SELECT.from(`${COCKPIT}.PriceModelRow`).where({
      rowKind: "estimate",
    });
    assert.equal(
      remaining.length,
      1,
      "second cleanup preserves the unfinished first batch",
    );
  } finally {
    releaseFirst();
    await first;
    resetCallSeams();
  }
  assert.equal(
    (
      await SELECT.from(`${COCKPIT}.PriceModelRow`).where({
        rowKind: "estimate",
      })
    ).length,
    0,
    "each batch cleans only its own staging after failure",
  );
});
