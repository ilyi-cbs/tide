// overview() (P-11) over the kernel fixtures: KPIs, "Your day" lines and
// charts from stored rows; buyer scope from the user attributes; no model call.
import cds from "@sap/cds";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import {
  registerCallGuard,
  registerCallRecorder,
} from "../srv/cockpit/kernel/model-calls";
import {
  overview,
  overviewScope,
  seedDemoPriorityHistory,
  step as overviewStep,
} from "../srv/cockpit/overview";
import { FIXTURE_AS_OF, seedFixtures } from "./fixtures/cockpit";
import { PREPARATION_POLICY } from "../srv/cockpit/kernel/publication";

const { DELETE, INSERT } = cds.ql;
const app = cds.test(path.join(__dirname, "..")) as ReturnType<
  typeof cds.test
> & { url: string };
const NS = "tide.cockpit";
const AUTH = {
  auth: { username: "ilyesse.hettenbach@cbs-consulting.de", password: "alice" },
};
let tabularHits = 0;
let seamCalls = 0;
let fake: Server;

const codes = (...s: string[]) =>
  JSON.stringify({
    proposals: s.map((status, i) => ({
      field: ["PurchasingGroup", "MaterialGroup", "Supplier"][i],
      value: "X",
      status,
    })),
  });
const item = (po: string, o: Record<string, unknown> = {}) => ({
  objectKey: `${po}/10`,
  PurchaseOrder: po,
  PurchaseOrderItem: "10",
  ...o,
});

before(async () => {
  fake = createServer((req, res) => {
    tabularHits++;
    res.writeHead(500).end();
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  (cds.env.requires as any).tabular.credentials = {
    url: `http://127.0.0.1:${(fake.address() as any).port}`,
  };
  await app;
  registerCallGuard(async () => void seamCalls++);
  registerCallRecorder(async () => void seamCalls++);
});

after(() => new Promise<void>((r) => fake.close(() => r())));

beforeEach(async () => {
  for (const e of [
    "ApprovalLock",
    "ApprovalEvent",
    "ProblemEvent",
    "FindingEvidence",
    "Finding",
    "ItemImpact",
    "Event",
    "ActionItems",
    "Actions",
    "Problem",
    "PublishedCockpit",
    "ExposureObservation",
    "CaseObservation",
    "PreparationPhase",
    "Snapshot",
    "FindingsDailyPriority",
    "FindingsDailyState",
    "DeliveryPriorityDaily",
    "DeliveryPriorityDailyState",
    "FreetextReview",
  ])
    await DELETE.from(`${NS}.${e}`);
  await seedFixtures(cds.db, {
    findings: [
      item("4500000001", { source: "tabpfn", revenueAtRisk: 12400 }),
      item("4500000002", {
        source: "empirical",
        Plant: "P2",
        PurchasingGroup: "002",
        revenueAtRisk: 600,
      }),
      item("4500000003", { status: "closed", revenueAtRisk: 9999 }),
      {
        list: "pdt",
        objectKey: "M1|S1|P1",
        source: "empirical",
        PurchaseOrder: null,
        PurchaseOrderItem: null,
      },
      {
        list: "mm_pdt",
        objectKey: "M1|P2",
        source: "tabpfn",
        Plant: "P2",
        PurchaseOrder: null,
        PurchaseOrderItem: null,
      },
      { list: "price", objectKey: "4500000005/10", source: "rule" },
      {
        list: "freetext",
        objectKey: "PR1/10",
        source: "tabpfn",
        Plant: null,
        PurchaseOrder: null,
        expert: codes("prefilled", "never_automatic"),
      },
      {
        list: "freetext",
        objectKey: "PR2/10",
        source: "tabpfn",
        Plant: "P2",
        PurchaseOrder: null,
        PurchasingGroup: "002",
        expert: codes("review", "never_automatic"),
      },
    ],
    itemImpacts: [
      { PurchaseOrder: "4500000001", revenueAtRisk: 12400 },
      { PurchaseOrder: "4500000002", revenueAtRisk: 600 },
      { PurchaseOrder: "4500000003", revenueAtRisk: 9999 }, // received during the day: row closed
      { PurchaseOrder: "4500000009", revenueAtRisk: 0, level: "no_impact" },
    ],
    actions: [
      {
        ID: cds.utils.uuid(),
        kind: "reminder",
        objectKey: "4500000001/10",
        title: "r",
        status: "needs_decision",
      },
      {
        ID: cds.utils.uuid(),
        kind: "reminder",
        objectKey: "4500000002/10",
        title: "r",
        status: "waiting",
      },
    ],
    events: [{ kind: "morning" }],
  });
  tabularHits = 0;
  seamCalls = 0;
  const snapshot = await cds.ql.SELECT.one
    .from(`${NS}.Snapshot`)
    .where({ asOf: FIXTURE_AS_OF });
  await cds.ql.UPSERT.into(`${NS}.PublishedCockpit`).entries({
    ID: "current",
    snapshot_ID: snapshot.ID,
    publishedAt: snapshot.finishedAt,
  });
});

async function seedPublishedHistory(mode: "snapshot" | "daily") {
  await cds.ql.UPDATE.entity("tide.s4.DatasetInfo")
    .set({ source: "extract", name: "fixture" })
    .where({ ID: "current" });
  const snapshots: any[] =
    mode === "snapshot"
      ? await cds.ql.SELECT.from(`${NS}.Snapshot`).where({ status: "done" })
      : [
          ...new Set(
            (
              await cds.ql.SELECT.from(`${NS}.DeliveryPriorityDaily`).columns(
                "day",
              )
            ).map((row: any) => row.day),
          ),
        ].map((day) => ({
          ID: cds.utils.uuid(),
          asOf: day,
          finishedAt: `${day}T06:00:00Z`,
        }));
  for (const snapshot of snapshots) {
    if (String(snapshot.message ?? "").startsWith("dry run")) continue;
    await cds.ql.UPSERT.into(`${NS}.Snapshot`).entries({
      ...snapshot,
      datasetName: "fixture",
      status: "done",
      publishedAt: snapshot.finishedAt,
      policyVersion: PREPARATION_POLICY,
      observationType: "operational",
      source: "extract",
      completeness: "complete",
    });
    if (mode === "snapshot") {
      await INSERT.into(`${NS}.ExposureObservation`).entries({
        snapshot_ID: snapshot.ID,
        caseID: "delivery:fixture",
        SalesOrder: "SO1",
        SalesOrderItem: "10",
        revenueAtRisk: snapshot.revenueAtRiskP50 ?? 0,
        currency: "EUR",
        valuationStatus: "valued",
        Plant: "P1",
        PurchasingGroup: "001",
      });
    } else {
      let state: any[] = await cds.ql.SELECT.from(
        `${NS}.DeliveryPriorityDailyState`,
      ).where({ day: snapshot.asOf });
      if (!state.length) {
        const aggregates: any[] = await cds.ql.SELECT.from(
          `${NS}.DeliveryPriorityDaily`,
        ).where({ day: snapshot.asOf });
        state = aggregates.flatMap((row) =>
          Array.from({ length: row.count }, (_, index) => ({
            findingID: `priority:${row.priority}:${index}`,
            priority: row.priority,
            Plant: "P1",
            PurchasingGroup: "001",
          })),
        );
      }
      if (state.length)
        await INSERT.into(`${NS}.CaseObservation`).entries(
          state.map((row) => ({
            snapshot_ID: snapshot.ID,
            caseID: row.findingID,
            kind: "delivery",
            status: "open",
            listing: "listed",
            priority: row.priority,
            Plant: row.Plant,
            PurchasingGroup: row.PurchasingGroup,
            observedAt: snapshot.finishedAt,
          })),
        );
    }
  }
}

test("overview() over the fixtures: KPIs, day lines, charts", async () => {
  const { data } = await app.axios.get("/odata/v4/desk/overview()", AUTH);
  assert.deepEqual(
    { ...data.kpis },
    {
      atRisk: 2,
      revenueAtRisk: 13000,
      openPurchaseRequisitions: 1,
      requestsToReview: 1,
      requestsAwaitingApproval: 0,
      requestsCompleted: 0,
      requestReviewPercent: 0,
      codesPrefilled: 1,
      codesTotal: 4,
      codesToReview: 3,
      pdtFindings: 2,
      preventionFindings: 3,
      pendingApprovals: 1,
      currency: "EUR",
    },
  );
  assert.deepEqual(
    data.dayLines.map((l: any) => [l.key, l.count, l.list]),
    [
      ["revenue", 2, "at_risk"],
      ["at_risk", 2, "at_risk"],
      ["prevention", 3, "prevention"],
      ["freetext", 2, "freetext"],
    ],
  );
  assert.equal(data.dayLines[0].amount, 13000);
  const ls = (d1: string, d2: string) =>
    data.byListSource.find((r: any) => r.dim1 === d1 && r.dim2 === d2)?.count;
  assert.equal(ls("Deliveries at risk", "AI estimate"), 1);
  assert.equal(ls("Deliveries at risk", "Past deliveries"), 1);
  assert.deepEqual(
    data.codesByStatus.map((r: any) => [r.dim1, r.dim2, r.count]),
    [
      ["Purchasing group", "Pre-filled", 1],
      ["Purchasing group", "To check", 1],
      ["Material group", "You decide", 2],
    ],
  );
  assert.equal(
    data.byPlant.find(
      (r: any) => r.dim1 === "P2" && r.dim2 === "Deliveries at risk",
    )?.count,
    1,
  );
  assert.ok(!data.byPlant.some((r: any) => r.dim2 === "Free-text inbox"));
  assert.equal(tabularHits + seamCalls, 0, "overview() made a model call");
});

test("overview() carries the as-of date, prepared-at timestamp and a narrative sentence", async () => {
  const { data } = await app.axios.get("/odata/v4/desk/overview()", AUTH);
  assert.equal(data.asOf, FIXTURE_AS_OF);
  assert.ok(data.preparedAt, "preparedAt is set once a snapshot is done");
  assert.equal(typeof data.narrative, "string");
  assert.ok(data.narrative.length > 0, "narrative is never empty");
  assert.ok(
    data.narrative.includes("13,000 EUR"),
    `narrative should mention the revenue at risk: ${data.narrative}`,
  );
});

test("overview request KPI follows durable review lifecycle counts", async () => {
  await INSERT.into(`${NS}.FreetextReview`).entries([
    {
      PurchaseRequisition: "1000000001",
      PurchaseRequisitionItem: "00010",
      Plant: "AT21",
      routedGroup: "A01",
      lifecycleStatus: "needs_review",
    },
    {
      PurchaseRequisition: "1000000002",
      PurchaseRequisitionItem: "00010",
      Plant: "AT21",
      routedGroup: "A01",
      lifecycleStatus: "awaiting_approval",
    },
    {
      PurchaseRequisition: "1000000003",
      PurchaseRequisitionItem: "00010",
      Plant: "AT21",
      routedGroup: "A01",
      lifecycleStatus: "completed",
    },
  ]);
  const result = await cds.tx(() =>
    overview({ Plant: "AT21", PurchasingGroup: "A01" }),
  );
  assert.equal(result.kpis.requestsToReview, 1);
  assert.equal(result.kpis.requestsAwaitingApproval, 1);
  assert.equal(result.kpis.requestsCompleted, 1);
  assert.equal(result.kpis.requestReviewPercent, 67);
});

test("overview requisition KPI matches buyer assignment scope", async () => {
  await INSERT.into(`${NS}.FreetextReview`).entries([
    {
      PurchaseRequisition: "2000000001",
      PurchaseRequisitionItem: "00010",
      Plant: "AT21",
      routedGroup: "A01",
      routedBuyer: "buyerA01",
      lifecycleStatus: "needs_review",
    },
    {
      PurchaseRequisition: "2000000002",
      PurchaseRequisitionItem: "00010",
      Plant: "AT21",
      routedGroup: "A01",
      routedBuyer: "other-buyer",
      lifecycleStatus: "needs_review",
    },
    {
      PurchaseRequisition: "2000000003",
      PurchaseRequisitionItem: "00010",
      Plant: "AT21",
      routedGroup: "A01",
      routedBuyer: "buyerA01",
      lifecycleStatus: "awaiting_approval",
    },
  ]);
  const { data } = await app.axios.get("/odata/v4/desk/overview()", {
    auth: { username: "buyerA01", password: "buyerA01" },
  });
  assert.equal(data.kpis.requestsToReview, 1);
  assert.equal(data.kpis.requestsAwaitingApproval, 1);
  assert.equal(data.kpis.openPurchaseRequisitions, 2);
});

test("buyer scope from the user attributes", async () => {
  assert.deepEqual(overviewScope({ attr: {} } as any), {
    PurchasingGroup: null,
    Plant: null,
    isAdmin: false,
    grants: [],
  });
  // A purchasing group without a plant is not a grant.
  assert.deepEqual(
    overviewScope({ attr: { PurchasingGroup: ["002"] } } as any),
    { PurchasingGroup: null, Plant: null, isAdmin: false, grants: [] },
  );
  assert.deepEqual(
    overviewScope({ attr: { PurchasingGroup: "002", Plant: "P2" } } as any),
    {
      PurchasingGroup: "002",
      Plant: "P2",
      isAdmin: false,
      grants: [{ Plant: "P2", PurchasingGroup: "002" }],
    },
  );
  // An admin sees everything regardless of attr — not indistinguishable
  // from a non-admin buyer whose attrs just happen to be unset.
  assert.equal(
    overviewScope({ is: (r: string) => r === "admin", attr: {} } as any),
    undefined,
  );
  assert.equal(
    overviewScope({
      is: (r: string) => r === "admin",
      attr: { PurchasingGroup: ["002"] },
    } as any),
    undefined,
    "admin role overrides any attr, unlike a plain attr-based check",
  );
  const o = await cds.tx(() =>
    overview({ PurchasingGroup: "002", Plant: "P2" }),
  );
  assert.equal(o.kpis.atRisk, 1);
  assert.equal(o.kpis.revenueAtRisk, 600);
  assert.equal(o.kpis.codesTotal, 2);
  assert.deepEqual(
    o.dayLines.map((l: { key: string }) => l.key),
    ["revenue", "at_risk", "freetext"],
  );
});

test("empty database: zero KPIs and no lines, not an error", async () => {
  for (const e of [
    "ApprovalLock",
    "ApprovalEvent",
    "ProblemEvent",
    "FindingEvidence",
    "Finding",
    "ItemImpact",
    "ActionItems",
    "Actions",
    "Problem",
  ])
    await DELETE.from(`${NS}.${e}`);
  const { data } = await app.axios.get("/odata/v4/desk/overview()", AUTH);
  assert.equal(data.kpis.atRisk, 0);
  assert.equal(data.kpis.revenueAtRisk, 0);
  assert.deepEqual(data.dayLines, []);
  assert.deepEqual(data.byListSource, []);
});

test("topPriorities and arrivedToday over the OData endpoint", async () => {
  for (const e of ["Finding", "ItemImpact"]) await DELETE.from(`${NS}.${e}`);
  await seedFixtures(cds.db, {
    asOf: false,
    findings: [
      item("4500000010", {
        ID: "at_risk:4500000010/10",
        itemTitle: "4500000010/10 · Worst item",
        impactCriticality: 1,
        impactText: "Customer order at risk · 9,000 EUR",
        revenueAtRisk: 9000,
        nextStep: "Prepare a reminder",
      }),
      item("4500000011", {
        ID: "overdue:4500000011/10",
        list: "overdue",
        itemTitle: "4500000011/10 · Second worst",
        impactCriticality: 1,
        impactText: "Customer order at risk · 500 EUR",
        revenueAtRisk: 500,
        nextStep: "Prepare a reminder",
      }),
      item("4500000012", {
        ID: "overdue:4500000012/10",
        list: "overdue",
        itemTitle: "4500000012/10 · Arrived this afternoon",
        trigger: "arrived",
        arrivedAt: "2026-10-05T13:00:00Z",
        nextStep: "Prepare a reminder",
      }),
    ],
  });
  const { data } = await app.axios.get("/odata/v4/desk/overview()", AUTH);
  assert.deepEqual(
    data.topPriorities.map((p: any) => p.ID),
    ["at_risk:4500000010/10", "overdue:4500000011/10", "overdue:4500000012/10"],
  );
  assert.equal(data.topPriorities[0].listText, "Deliveries at risk");
  assert.deepEqual(
    data.arrivedToday.map((p: any) => p.ID),
    ["overdue:4500000012/10"],
  );
});

test("runtime demo helper does not fabricate post-morning arrivals", async () => {
  await cds.db.run(
    cds.ql.UPDATE.entity("tide.s4.DatasetInfo")
      .set({ source: "synthetic", asOf: "2026-10-05" })
      .where({ ID: "current" }),
  );
  await seedFixtures(cds.db, {
    asOf: false,
    findings: [
      {
        ...item("4500000013"),
        ID: "pdt:10000158|19000001|DE11",
        list: "pdt",
        objectKey: "10000158|19000001|DE11",
        trigger: "morning",
      },
      {
        ...item("4500000014"),
        ID: "pdt:20000527|19000001|AT21",
        list: "pdt",
        objectKey: "20000527|19000001|AT21",
        trigger: "morning",
      },
    ],
  });
  const { seedDemoArrivals } = await import("../srv/cockpit/overview/index.js");
  await seedDemoArrivals();
  const { data } = await app.axios.get("/odata/v4/desk/overview()", AUTH);
  assert.deepEqual(
    data.arrivedToday.map((row: any) => row.ID),
    [],
  );
});

test("topPriorities / arrivedToday rows carry identifying fields and a coloured source tag over OData", async () => {
  for (const e of ["Finding", "ItemImpact"]) await DELETE.from(`${NS}.${e}`);
  await seedFixtures(cds.db, {
    asOf: false,
    findings: [
      item("4500000020", {
        ID: "at_risk:4500000020/10",
        itemTitle: "4500000020/10 · Gear motor",
        itemSubtitle: "Supplier 0007 GmbH · Plant 1010",
        dueDate: "2026-10-12",
        impactCriticality: 1,
        revenueAtRisk: 4200,
        nextStep: "Prepare a reminder",
        source: "tabpfn",
        sourceText: "AI estimate",
      }),
    ],
  });
  const { data } = await app.axios.get("/odata/v4/desk/overview()", AUTH);
  assert.deepEqual(data.topPriorities[0], {
    ID: "at_risk:4500000020/10",
    itemTitle: "4500000020/10 · Gear motor",
    itemSubtitle: "Supplier 0007 GmbH · Plant 1010",
    impactText: "",
    listText: "Deliveries at risk",
    list: "at_risk",
    nextStep: "Prepare a reminder",
    dueDate: "2026-10-12",
    sourceText: "AI estimate",
    sourceTag: "ai",
  });
});

test("trend: one point per real snapshot day, dry runs and same-day reruns excluded, oldest first", async () => {
  await DELETE.from(`${NS}.Snapshot`); // drop the beforeEach fixture snapshot: it would collide on the 2026-10-05 point below
  await seedFixtures(cds.db, {
    asOf: false,
    snapshots: [
      // Same as-of date, two runs: the later one (by finishedAt) wins.
      {
        ID: cds.utils.uuid(),
        asOf: "2026-10-01",
        finishedAt: "2026-10-01T06:00:00Z",
        revenueAtRiskP50: 5000,
      },
      {
        ID: cds.utils.uuid(),
        asOf: "2026-10-01",
        finishedAt: "2026-10-01T09:00:00Z",
        revenueAtRiskP50: 6000,
      },
      // A dry run on 2026-10-03: excluded entirely, even though it is "done".
      {
        ID: cds.utils.uuid(),
        asOf: "2026-10-03",
        finishedAt: "2026-10-03T06:00:00Z",
        revenueAtRiskP50: 999999,
        message: "dry run: planned",
      },
      {
        ID: cds.utils.uuid(),
        asOf: "2026-10-05",
        finishedAt: "2026-10-05T06:01:00Z",
        revenueAtRiskP50: 13000,
      },
    ],
  });
  await seedPublishedHistory("snapshot");
  const { data } = await app.axios.get("/odata/v4/desk/overview()", AUTH);
  assert.deepEqual(data.trend, [
    { asOf: "2026-10-01", revenueAtRisk: 6000 },
    { asOf: "2026-10-05", revenueAtRisk: 13000 },
  ]);
});

test("trend: only the most recent 7 days are kept", async () => {
  await cds.db.run(
    cds.ql.UPSERT.into("tide.s4.DatasetInfo").entries({
      ID: "current",
      name: "fixture",
      asOf: "2026-10-10",
    }),
  );
  await seedFixtures(cds.db, {
    asOf: false,
    snapshots: Array.from({ length: 10 }, (_, i) => ({
      ID: cds.utils.uuid(),
      asOf: `2026-10-${String(i + 1).padStart(2, "0")}`,
      finishedAt: `2026-10-${String(i + 1).padStart(2, "0")}T06:00:00Z`,
      revenueAtRiskP50: i * 1000,
    })),
  });
  await seedPublishedHistory("snapshot");
  const { data } = await app.axios.get("/odata/v4/desk/overview()", AUTH);
  assert.equal(data.trend.length, 7);
  assert.deepEqual(data.trend[0], { asOf: "2026-10-04", revenueAtRisk: 3000 });
  assert.deepEqual(data.trend[6], { asOf: "2026-10-10", revenueAtRisk: 9000 });
});

test("trends exclude history after the loaded dataset as-of date", async () => {
  await cds.db.run(
    cds.ql.UPSERT.into("tide.s4.DatasetInfo").entries({
      ID: "current",
      name: "fixture",
      asOf: "2026-10-04",
    }),
  );
  await cds.db.run(
    cds.ql.UPSERT.into(`${NS}.Snapshot`).entries({
      ID: cds.utils.uuid(),
      asOf: "2026-10-05",
      status: "done",
      finishedAt: "2026-10-05T06:00:00Z",
      revenueAtRiskP50: 999999,
    }),
  );
  await cds.db.run(
    cds.ql.UPSERT.into(`${NS}.DeliveryPriorityDaily`).entries({
      day: "2026-10-05",
      priority: 0,
      count: 99,
    }),
  );
  const { data } = await app.axios.get("/odata/v4/desk/overview()", AUTH);
  assert.equal(
    data.trend.some((point: any) => point.asOf > "2026-10-04"),
    false,
  );
  assert.equal(
    data.priorityTrend.some((point: any) => point.day > "2026-10-04"),
    false,
  );
});

test("legacy seeded aggregates are not completed-run history", async () => {
  await cds.db.run(
    cds.ql.UPSERT.into("tide.s4.DatasetInfo").entries({
      ID: "current",
      name: "fixture",
      asOf: "2026-10-05",
    }),
  );
  await cds.db.run(
    cds.ql.UPSERT.into(`${NS}.DeliveryPriorityDaily`).entries([
      { day: "2026-09-24", priority: 0, count: 3 },
      { day: "2026-09-24", priority: 1, count: 5 },
      { day: "2026-09-24", priority: 2, count: 8 },
      { day: "2026-09-24", priority: 3, count: 4 },
      { day: "2026-09-25", priority: 0, count: 1 },
      { day: "2026-09-25", priority: 1, count: 0 },
      { day: "2026-09-25", priority: 2, count: 2 },
      { day: "2026-09-25", priority: 3, count: 3 },
      { day: "2026-09-28", priority: 0, count: 6 },
      { day: "2026-09-28", priority: 1, count: 8 },
      { day: "2026-09-28", priority: 2, count: 10 },
      { day: "2026-09-28", priority: 3, count: 5 },
      { day: "2026-09-29", priority: 0, count: 0 },
      { day: "2026-09-29", priority: 1, count: 1 },
      { day: "2026-09-29", priority: 2, count: 3 },
      { day: "2026-09-29", priority: 3, count: 2 },
      { day: "2026-09-30", priority: 0, count: 4 },
      { day: "2026-09-30", priority: 1, count: 6 },
      { day: "2026-09-30", priority: 2, count: 9 },
      { day: "2026-09-30", priority: 3, count: 7 },
      { day: "2026-10-01", priority: 0, count: 1 },
      { day: "2026-10-01", priority: 1, count: 2 },
      { day: "2026-10-01", priority: 2, count: 4 },
      { day: "2026-10-01", priority: 3, count: 1 },
      { day: "2026-10-02", priority: 0, count: 7 },
      { day: "2026-10-02", priority: 1, count: 9 },
      { day: "2026-10-02", priority: 2, count: 12 },
      { day: "2026-10-02", priority: 3, count: 5 },
      { day: "2026-10-05", priority: 0, count: 2 },
      { day: "2026-10-05", priority: 1, count: 4 },
      { day: "2026-10-05", priority: 2, count: 7 },
      { day: "2026-10-05", priority: 3, count: 3 },
    ]),
  );

  const { data } = await app.axios.get("/odata/v4/desk/overview()", AUTH);
  assert.deepEqual(data.priorityTrend, []);
  assert.deepEqual(data.trend, []);
});

test("delivery priority trend is oldest first and fills missing urgency buckets with zero", async () => {
  await cds.db.run(
    cds.ql.UPSERT.into(`${NS}.DeliveryPriorityDaily`).entries([
      { day: "2026-10-01", priority: 0, count: 4 },
      { day: "2026-10-01", priority: 1, count: 6 },
      { day: "2026-10-02", priority: 2, count: 8 },
      { day: "2026-10-02", priority: 3, count: 2 },
    ]),
  );
  await seedPublishedHistory("daily");
  const { data } = await app.axios.get("/odata/v4/desk/overview()", AUTH);
  assert.deepEqual(data.priorityTrend, [
    { day: "2026-10-01", critical: 4, high: 6, medium: 0, low: 0, total: 10 },
    { day: "2026-10-02", critical: 0, high: 0, medium: 8, low: 2, total: 10 },
  ]);
});

test("Morning Brief exposes a change summary from stored finding state", async () => {
  await cds.db.run(
    cds.ql.UPSERT.into(`${NS}.DeliveryPriorityDaily`).entries([
      { day: "2026-10-02", priority: 0, count: 2 },
      { day: FIXTURE_AS_OF, priority: 0, count: 2 },
    ]),
  );
  await cds.db.run(
    cds.ql.UPSERT.into(`${NS}.DeliveryPriorityDailyState`).entries([
      {
        day: "2026-10-02",
        findingID: "resolved",
        problemKey: "resolved",
        priority: 0,
        Plant: "P1",
        PurchasingGroup: "001",
      },
      {
        day: "2026-10-02",
        findingID: "escalated",
        problemKey: "escalated",
        priority: 2,
        Plant: "P1",
        PurchasingGroup: "001",
      },
      {
        day: FIXTURE_AS_OF,
        findingID: "escalated",
        problemKey: "escalated",
        priority: 1,
        Plant: "P1",
        PurchasingGroup: "001",
      },
      {
        day: FIXTURE_AS_OF,
        findingID: "new",
        problemKey: "new",
        priority: 2,
        Plant: "P1",
        PurchasingGroup: "001",
      },
    ]),
  );
  await seedPublishedHistory("daily");
  const { data } = await app.axios.get("/odata/v4/desk/overview()", AUTH);
  assert.deepEqual(data.changeSummary, {
    comparedDay: "2026-10-02",
    newCount: 1,
    noLongerDetectedCount: 1,
    escalatedCount: 1,
  });
});

test("buyer change summaries use only that buyer's retained finding state", async () => {
  await cds.db.run(
    cds.ql.UPSERT.into(`${NS}.DeliveryPriorityDaily`).entries([
      { day: "2026-10-02", priority: 0, count: 2 },
      { day: FIXTURE_AS_OF, priority: 0, count: 2 },
    ]),
  );
  await cds.db.run(
    cds.ql.UPSERT.into(`${NS}.DeliveryPriorityDailyState`).entries([
      {
        day: "2026-10-02",
        findingID: "buyer-a",
        problemKey: "buyer-a",
        priority: 2,
        Plant: "P1",
        PurchasingGroup: "001",
      },
      {
        day: "2026-10-02",
        findingID: "buyer-b",
        problemKey: "buyer-b",
        priority: 2,
        Plant: "P2",
        PurchasingGroup: "002",
      },
      {
        day: FIXTURE_AS_OF,
        findingID: "buyer-a",
        problemKey: "buyer-a",
        priority: 1,
        Plant: "P1",
        PurchasingGroup: "001",
      },
      {
        day: FIXTURE_AS_OF,
        findingID: "buyer-b",
        problemKey: "buyer-b",
        priority: 1,
        Plant: "P2",
        PurchasingGroup: "002",
      },
    ]),
  );
  await seedPublishedHistory("daily");
  const result = await cds.tx(() =>
    overview({ Plant: "P1", PurchasingGroup: "001" }),
  );
  assert.deepEqual(result.changeSummary, {
    comparedDay: "2026-10-02",
    newCount: 0,
    noLongerDetectedCount: 0,
    escalatedCount: 1,
  });
});

test("buyer priority trends are derived from the scoped daily finding state", async () => {
  await cds.db.run(
    cds.ql.UPSERT.into(`${NS}.DeliveryPriorityDaily`).entries([
      { day: "2026-10-02", priority: 0, count: 2 },
    ]),
  );
  await cds.db.run(
    cds.ql.UPSERT.into(`${NS}.DeliveryPriorityDailyState`).entries([
      {
        day: "2026-10-02",
        findingID: "a-critical",
        problemKey: "a-critical",
        priority: 0,
        Plant: "P1",
        PurchasingGroup: "001",
      },
      {
        day: "2026-10-02",
        findingID: "a-high",
        problemKey: "a-high",
        priority: 1,
        Plant: "P1",
        PurchasingGroup: "001",
      },
      {
        day: "2026-10-02",
        findingID: "b-critical",
        problemKey: "b-critical",
        priority: 0,
        Plant: "P2",
        PurchasingGroup: "002",
      },
    ]),
  );
  await seedPublishedHistory("daily");
  const result = await cds.tx(() =>
    overview({ Plant: "P1", PurchasingGroup: "001" }),
  );
  assert.deepEqual(result.priorityTrend, [
    { day: "2026-10-02", critical: 1, high: 1, medium: 0, low: 0, total: 2 },
  ]);
});

test("overview phase cannot publish history independently of completed preparation", async () => {
  await cds.db.run(
    cds.ql.UPSERT.into("tide.s4.DatasetInfo").entries({
      ID: "current",
      source: "raw",
      asOf: FIXTURE_AS_OF,
    }),
  );
  await overviewStep.run({ dryRun: true, asOf: FIXTURE_AS_OF } as any);
  let rows = await cds.db.run(
    cds.ql.SELECT.from(`${NS}.DeliveryPriorityDailyState`).where({
      day: FIXTURE_AS_OF,
    }),
  );
  assert.equal(rows.length, 0, "dry runs must not create history");

  await cds.db.run(
    cds.ql.UPDATE.entity(`${NS}.Finding`).set({ deliveryPriorityOrder: 2 })
      .where`status = 'open' and list = 'at_risk'`,
  );
  await overviewStep.run({ dryRun: false, asOf: FIXTURE_AS_OF } as any);
  rows = await cds.db.run(
    cds.ql.SELECT.from(`${NS}.DeliveryPriorityDailyState`).where({
      day: FIXTURE_AS_OF,
    }),
  );
  assert.equal(
    rows.length,
    0,
    "only the final preparation publisher owns history",
  );
  const aggregates = await cds.db.run(
    cds.ql.SELECT.from(`${NS}.DeliveryPriorityDaily`)
      .where({ day: FIXTURE_AS_OF })
      .orderBy("priority"),
  );
  assert.deepEqual(
    aggregates.map((row: any) => row.count),
    [],
    "a standalone overview phase cannot claim completion",
  );
});

test("synthetic 5 October preparation retains a loaded curated priority trend", async () => {
  await cds.db.run(
    cds.ql.UPSERT.into("tide.s4.DatasetInfo").entries({
      ID: "current",
      source: "synthetic",
      asOf: "2026-10-05",
    }),
  );
  await cds.db.run(
    cds.ql.UPSERT.into(`${NS}.DeliveryPriorityDaily`).entries([
      { day: "2026-10-05", priority: 0, count: 2 },
      { day: "2026-10-05", priority: 1, count: 4 },
      { day: "2026-10-05", priority: 2, count: 7 },
      { day: "2026-10-05", priority: 3, count: 3 },
    ]),
  );
  await cds.db.run(
    cds.ql.UPDATE.entity(`${NS}.Finding`).set({ deliveryPriorityOrder: 2 })
      .where`status = 'open' and list = 'at_risk'`,
  );
  await overviewStep.run({ dryRun: false, asOf: "2026-10-05" } as any);

  const rows = await cds.db.run(
    cds.ql.SELECT.from(`${NS}.DeliveryPriorityDaily`)
      .where({ day: "2026-10-05" })
      .orderBy("priority"),
  );
  assert.deepEqual(
    rows.map((row: any) => row.count),
    [2, 4, 7, 3],
  );
  const state = await cds.db.run(
    cds.ql.SELECT.from(`${NS}.DeliveryPriorityDailyState`).where({
      day: "2026-10-05",
    }),
  );
  assert.equal(state.length, 0, "curated aggregates are not a published run");
});

test("synthetic overview phase does not invent a preparation", async () => {
  await cds.db.run(
    cds.ql.UPSERT.into("tide.s4.DatasetInfo").entries({
      ID: "current",
      source: "synthetic",
      asOf: "2026-10-05",
    }),
  );
  await cds.db.run(
    cds.ql.UPDATE.entity(`${NS}.Finding`).set({ deliveryPriorityOrder: 2 })
      .where`status = 'open' and list = 'at_risk'`,
  );

  await overviewStep.run({ dryRun: false, asOf: "2026-10-05" } as any);

  const rows = await cds.db.run(
    cds.ql.SELECT.from(`${NS}.DeliveryPriorityDaily`)
      .where({ day: "2026-10-05" })
      .orderBy("priority"),
  );
  assert.deepEqual(
    rows.map((row: any) => row.count),
    [],
  );
});

test("retired demo helper neither fabricates nor replaces retained history", async () => {
  await cds.db.run(
    cds.ql.UPSERT.into("tide.s4.DatasetInfo").entries({
      ID: "current",
      name: "fixture",
      asOf: "2026-10-05",
    }),
  );
  await cds.db.run(
    cds.ql.UPSERT.into(`${NS}.DeliveryPriorityDaily`).entries({
      day: "2026-10-02",
      priority: 0,
      count: 99,
    }),
  );
  await seedDemoPriorityHistory(true);
  const first = await cds.db.run(
    cds.ql.SELECT.from(`${NS}.DeliveryPriorityDaily`).orderBy(
      "day",
      "priority",
    ),
  );
  assert.equal(first.length, 1);
  assert.equal(
    first.some((row: any) => row.day === "2026-10-05"),
    false,
  );
  assert.equal(
    first.find((row: any) => row.day === "2026-10-02" && row.priority === 0)
      ?.count,
    99,
  );
  assert.deepEqual(
    first
      .filter((row: any) => row.day === "2026-10-01")
      .map((row: any) => row.count),
    [],
    "runtime helpers cannot fabricate missing days",
  );
  await seedDemoPriorityHistory(true);
  const second = await cds.db.run(
    cds.ql.SELECT.from(`${NS}.DeliveryPriorityDaily`).orderBy(
      "day",
      "priority",
    ),
  );
  assert.deepEqual(second, first);
});

test("history scopes before demand deduplication, preserves calendar gaps and retains same-day revisions", async () => {
  await cds.ql.UPDATE.entity("tide.s4.DatasetInfo")
    .set({ source: "extract", name: "fixture" })
    .where({ ID: "current" });
  const first = cds.utils.uuid();
  const second = cds.utils.uuid();
  const old = cds.utils.uuid();
  await INSERT.into(`${NS}.Snapshot`).entries([
    {
      ID: first,
      asOf: "2026-10-05",
      datasetName: "fixture",
      status: "done",
      publishedAt: "2026-10-05T07:00:00Z",
      policyVersion: PREPARATION_POLICY,
      observationType: "operational",
    },
    {
      ID: second,
      asOf: "2026-10-05",
      datasetName: "fixture",
      status: "done",
      publishedAt: "2026-10-05T08:00:00Z",
      policyVersion: PREPARATION_POLICY,
      observationType: "operational",
    },
    {
      ID: old,
      asOf: "2026-09-20",
      datasetName: "fixture",
      status: "done",
      publishedAt: "2026-09-20T08:00:00Z",
      policyVersion: PREPARATION_POLICY,
      observationType: "operational",
    },
  ]);
  await INSERT.into(`${NS}.CaseObservation`).entries([
    {
      snapshot_ID: second,
      caseID: "a",
      kind: "delivery",
      status: "open",
      listing: "listed",
      priority: 0,
      Plant: "P1",
      PurchasingGroup: "001",
    },
    {
      snapshot_ID: second,
      caseID: "b",
      kind: "delivery",
      status: "open",
      listing: "listed",
      priority: 1,
      Plant: "P1",
      PurchasingGroup: "001",
    },
    {
      snapshot_ID: second,
      caseID: "c",
      kind: "delivery",
      status: "open",
      listing: "listed",
      priority: 0,
      Plant: "P2",
      PurchasingGroup: "002",
    },
  ]);
  await INSERT.into(`${NS}.ExposureObservation`).entries([
    {
      snapshot_ID: first,
      caseID: "a",
      SalesOrder: "SO1",
      SalesOrderItem: "10",
      revenueAtRisk: 999,
      currency: "EUR",
      valuationStatus: "valued",
      Plant: "P1",
      PurchasingGroup: "001",
    },
    ...["a", "b"].map((caseID) => ({
      snapshot_ID: second,
      caseID,
      SalesOrder: "SO1",
      SalesOrderItem: "10",
      revenueAtRisk: 100,
      currency: "EUR",
      valuationStatus: "valued",
      Plant: "P1",
      PurchasingGroup: "001",
    })),
    {
      snapshot_ID: second,
      caseID: "c",
      SalesOrder: "SO2",
      SalesOrderItem: "10",
      revenueAtRisk: 500,
      currency: "EUR",
      valuationStatus: "valued",
      Plant: "P2",
      PurchasingGroup: "002",
    },
  ]);
  const scoped = await overview({ Plant: "P1", PurchasingGroup: "001" });
  assert.deepEqual(scoped.trend, [{ asOf: "2026-10-05", revenueAtRisk: 100 }]);
  assert.deepEqual(scoped.priorityTrend, [
    { day: "2026-10-05", critical: 1, high: 1, medium: 0, low: 0, total: 2 },
  ]);
  const global = await overview();
  assert.deepEqual(global.trend, [{ asOf: "2026-10-05", revenueAtRisk: 600 }]);
  assert.equal(
    (
      await cds.ql.SELECT.from(`${NS}.ExposureObservation`).where({
        snapshot_ID: first,
      })
    ).length,
    1,
    "same-day reruns retain old evidence",
  );
  const response = await app.axios.get(
    "/odata/v4/desk/publicationHistory(windowDays=30)",
    AUTH,
  );
  assert.deepEqual(
    response.data.priorityTrend.map((point: any) => point.day),
    ["2026-09-20", "2026-10-05"],
  );
  assert.equal(response.data.coveredDays, 2);
  assert.equal(response.data.source, "operational");
  const invalid = await app.axios.get(
    "/odata/v4/desk/publicationHistory(windowDays=100)",
    { ...AUTH, validateStatus: () => true },
  );
  assert.equal(invalid.status, 400);
  assert.equal(tabularHits + seamCalls, 0);
});
