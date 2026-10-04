// Pure overview logic (P-11): KPIs, "Your day" lines and charts from stored rows.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  codeStatuses,
  computeOverview,
  narrative,
  SOURCE_WORD,
  type FindingIn,
  type OverviewKpis,
} from "../srv/cockpit/overview/domain/logic";

const f = (list: string, o: Partial<FindingIn> = {}): FindingIn => ({
  list,
  status: "open",
  source: "rule",
  Plant: "1010",
  PurchasingGroup: "001",
  ...o,
});
const freetext = (statuses: string[], o: Partial<FindingIn> = {}) =>
  f("freetext", {
    source: "tabpfn",
    expert: JSON.stringify({
      proposals: statuses.map((s, i) => ({
        field: ["PurchasingGroup", "MaterialGroup", "Supplier"][i],
        status: s,
      })),
    }),
    ...o,
  });

const findings: FindingIn[] = [
  f("at_risk", {
    PurchaseOrder: "4500000001",
    PurchaseOrderItem: "10",
    revenueAtRisk: 1000,
    source: "tabpfn",
    sourceText: "AI estimate",
  }),
  f("at_risk", {
    PurchaseOrder: "4500000002",
    PurchaseOrderItem: "10",
    revenueAtRisk: 250.5,
    source: "empirical",
    Plant: "1020",
    PurchasingGroup: "002",
  }),
  f("at_risk", {
    PurchaseOrder: "4500000003",
    PurchaseOrderItem: "10",
    revenueAtRisk: 999,
    status: "closed",
  }),
  f("pdt", { source: "empirical" }),
  f("mm_pdt", { source: "tabpfn", Plant: "1020", PurchasingGroup: null }),
  freetext(["prefilled", "never_automatic"], {
    Plant: null,
    PurchasingGroup: "001",
  }),
  freetext(["review", "never_automatic", "never_automatic"], {
    Plant: null,
    PurchasingGroup: "002",
  }),
];
const impacts = [
  { PurchaseOrder: "4500000001", PurchaseOrderItem: "10", revenueAtRisk: 1000 },
  {
    PurchaseOrder: "4500000002",
    PurchaseOrderItem: "10",
    revenueAtRisk: 250.5,
  },
  { PurchaseOrder: "4500000003", PurchaseOrderItem: "10", revenueAtRisk: 999 }, // received: at_risk row closed
  // A positive impact without an open delivery finding must not inflate the
  // Morning Brief above the Fulfillment Risks list-report total.
  { PurchaseOrder: "4500000004", PurchaseOrderItem: "10", revenueAtRisk: 500 },
];

test("KPIs count open rows and revenue over visible fulfillment risks only", () => {
  const o = computeOverview({ findings, impacts, pendingApprovals: 3 });
  assert.deepEqual(o.kpis, {
    atRisk: 2,
    revenueAtRisk: 1250.5,
    openPurchaseRequisitions: 2,
    requestsToReview: 2,
    requestsAwaitingApproval: 0,
    requestsCompleted: 0,
    requestReviewPercent: 0,
    codesPrefilled: 1,
    codesTotal: 5,
    codesToReview: 4,
    pdtFindings: 2,
    preventionFindings: 2,
    pendingApprovals: 3,
    currency: "EUR",
  });
});

test("Morning Brief exposes revenue by priority and the three most exposed suppliers", () => {
  const o = computeOverview({
    findings: [
      f("at_risk", {
        PurchaseOrder: "1",
        Supplier: "S1",
        supplierDisplay: "S1 - First",
        deliveryPriorityOrder: 0,
        revenueAtRisk: 1000,
      }),
      f("overdue", {
        PurchaseOrder: "2",
        Supplier: "S1",
        supplierDisplay: "S1 - First",
        deliveryPriorityOrder: 1,
        revenueAtRisk: 250,
      }),
      f("at_risk", {
        PurchaseOrder: "3",
        Supplier: "S2",
        deliveryPriorityOrder: 2,
        revenueAtRisk: 700,
      }),
      f("at_risk", {
        PurchaseOrder: "4",
        Supplier: "S3",
        deliveryPriorityOrder: 0,
        revenueAtRisk: 400,
      }),
      f("at_risk", {
        PurchaseOrder: "5",
        Supplier: "S4",
        deliveryPriorityOrder: 3,
        revenueAtRisk: 100,
      }),
      f("pdt", {
        Supplier: "S5",
        deliveryPriorityOrder: 0,
        revenueAtRisk: 9000,
      }),
    ],
    impacts: [],
    pendingApprovals: 0,
  });
  assert.deepEqual(o.revenueByPriority, [
    { priority: "Critical", findingCount: 2, revenueAtRisk: 1400 },
    { priority: "High", findingCount: 1, revenueAtRisk: 250 },
    { priority: "Medium", findingCount: 1, revenueAtRisk: 700 },
    { priority: "Low", findingCount: 1, revenueAtRisk: 100 },
  ]);
  assert.deepEqual(o.topSuppliers, [
    {
      supplier: "S1 - First",
      findingCount: 2,
      criticalCount: 1,
      revenueAtRisk: 1250,
      priority: "Critical",
    },
    {
      supplier: "S2",
      findingCount: 1,
      criticalCount: 0,
      revenueAtRisk: 700,
      priority: "Medium",
    },
    {
      supplier: "S3",
      findingCount: 1,
      criticalCount: 1,
      revenueAtRisk: 400,
      priority: "Critical",
    },
  ]);
});

test("Morning Brief carries a stored comparison only when one is available", () => {
  const changeSummary = {
    comparedDay: "2026-10-01",
    newCount: 3,
    noLongerDetectedCount: 2,
    escalatedCount: 1,
  };
  assert.deepEqual(
    computeOverview({
      findings: [],
      impacts: [],
      pendingApprovals: 0,
      changeSummary,
    }).changeSummary,
    changeSummary,
  );
  assert.equal(
    computeOverview({ findings: [], impacts: [], pendingApprovals: 0 })
      .changeSummary,
    null,
  );
});

test("Your day lines: four in order, each with its list", () => {
  const o = computeOverview({ findings, impacts, pendingApprovals: 0 });
  assert.deepEqual(
    o.dayLines.map((l) => [l.key, l.count, l.list]),
    [
      ["revenue", 2, "at_risk"],
      ["at_risk", 2, "at_risk"],
      ["prevention", 2, "prevention"],
      ["freetext", 2, "freetext"],
    ],
  );
  assert.equal(o.dayLines[0].amount, 1250.5);
  assert.equal(o.dayLines[0].text, "Revenue at risk · 1,251 EUR");
});

test("empty state: no lines, zero KPIs, empty charts", () => {
  const o = computeOverview({ findings: [], impacts: [], pendingApprovals: 0 });
  assert.equal(o.dayLines.length, 0);
  assert.equal(
    o.byListSource.length + o.codesByStatus.length + o.byPlant.length,
    0,
  );
  assert.equal(o.kpis.revenueAtRisk, 0);
});

test("charts use buyer words only", () => {
  const o = computeOverview({ findings, impacts, pendingApprovals: 0 });
  assert.deepEqual(
    o.byListSource.find(
      (r) => r.dim1 === "Deliveries at risk" && r.dim2 === "AI estimate",
    )?.count,
    1,
  );
  assert.deepEqual(
    o.byListSource.find(
      (r) => r.dim1 === "Deliveries at risk" && r.dim2 === "Past deliveries",
    )?.count,
    1,
  );
  assert.equal(o.byListSource[0].dim1, "Deliveries at risk");
  assert.deepEqual(
    o.codesByStatus.find((r) => r.dim1 === "Material group")?.dim2,
    "You decide",
  );
  assert.ok(!o.byPlant.some((r) => r.dim2 === "Free-text inbox"));
  const text = JSON.stringify(o);
  for (const w of [
    "tabpfn",
    "empirical",
    'at_risk"',
    'mm_pdt"',
    "never_automatic",
    "calculation",
  ])
    assert.ok(
      !JSON.stringify([o.byListSource, o.codesByStatus, o.byPlant]).includes(w),
      `${w} in ${text}`,
    );
});

test("buyer scope filters findings and revenue by paired plant and purchasing group", () => {
  const scoped = [
    ...findings,
    f("pdt", { Plant: "1020", PurchasingGroup: "002" }),
    freetext(["review", "never_automatic", "never_automatic"], {
      Plant: "1020",
      PurchasingGroup: "002",
    }),
  ];
  const o = computeOverview({
    findings: scoped,
    impacts,
    pendingApprovals: 0,
    scope: { PurchasingGroup: "002", Plant: "1020" },
  });
  assert.equal(o.kpis.atRisk, 1);
  assert.equal(o.kpis.revenueAtRisk, 250.5);
  assert.equal(o.kpis.codesTotal, 3);
  assert.equal(o.kpis.pdtFindings, 1);
  // A single dimension is not a grant: rows need both plant and purchasing group.
  const p = computeOverview({
    findings: scoped,
    impacts,
    pendingApprovals: 0,
    scope: { Plant: "1020" },
  });
  assert.equal(p.kpis.atRisk + p.kpis.pdtFindings + p.kpis.codesTotal, 0);
});

test("durable free-text proposals drive the request KPIs", () => {
  const o = computeOverview({
    findings: [
      f("freetext", {
        PurchaseRequisition: "PR1",
        PurchaseRequisitionItem: "10",
      }),
      f("freetext", {
        PurchaseRequisition: "PR2",
        PurchaseRequisitionItem: "10",
        status: "closed",
      }),
    ],
    impacts: [],
    pendingApprovals: 0,
    codes: [
      { key: "PR1/10", field: "PurchasingGroup", status: "prefilled" },
      { key: "PR1/10", field: "MaterialGroup", status: "review" },
      { key: "PR2/10", field: "PurchasingGroup", status: "prefilled" },
    ],
  });
  assert.equal(o.kpis.codesTotal, 2);
  assert.equal(o.kpis.codesPrefilled, 1);
  assert.equal(o.kpis.codesToReview, 1);
  assert.equal(o.kpis.openPurchaseRequisitions, 1);
});

test("code statuses: accepted shapes of the expert JSON", () => {
  assert.deepEqual(
    codeStatuses(
      JSON.stringify({
        proposals: { PurchasingGroup: { status: "prefilled" } },
      }),
    ),
    [],
  );
  assert.deepEqual(
    codeStatuses(JSON.stringify({ status: "never automatic" })),
    [],
  );
  assert.deepEqual(codeStatuses(JSON.stringify({ prefilled: true })), []);
  assert.deepEqual(codeStatuses("not json"), []);
  assert.deepEqual(codeStatuses(null), []);
});

const priorityRows: FindingIn[] = [
  f("at_risk", {
    ID: "at_risk:1",
    itemTitle: "Item 1",
    impactText: "Stock covers it",
    impactCriticality: 3,
    revenueAtRisk: 5000,
    nextStep: "Prepare a reminder",
  }),
  f("overdue", {
    ID: "overdue:2",
    itemTitle: "Item 2",
    impactText: "Customer order at risk · 900 EUR",
    impactCriticality: 1,
    revenueAtRisk: 900,
    nextStep: "Prepare a reminder",
  }),
  f("at_risk", {
    ID: "at_risk:3",
    itemTitle: "Item 3",
    impactText: "Customer order at risk · 12,000 EUR",
    impactCriticality: 1,
    revenueAtRisk: 12000,
    nextStep: "Prepare a reminder",
  }),
  f("pdt", {
    ID: "pdt:4",
    itemTitle: "Item 4",
    impactText: "",
    impactCriticality: 0,
    revenueAtRisk: 0,
    nextStep: "Add to the change list",
  }),
  f("freetext", {
    ID: "freetext:5",
    itemTitle: "Item 5",
    impactCriticality: 1,
    revenueAtRisk: 99999,
    nextStep: "Accept the confident codes",
  }),
  f("at_risk", {
    itemTitle: "No ID, must be skipped",
    impactCriticality: 1,
    revenueAtRisk: 1,
  }),
];

test("topPriorities: worst impact first, then revenue, never freetext, never a row without an ID", () => {
  const o = computeOverview({
    findings: priorityRows,
    impacts: [],
    pendingApprovals: 0,
  });
  assert.deepEqual(
    o.topPriorities.map((p) => p.ID),
    ["at_risk:3", "overdue:2", "at_risk:1", "pdt:4"],
  );
  assert.equal(o.topPriorities[0].listText, "Deliveries at risk");
  assert.equal(
    o.topPriorities[0].impactText,
    "Customer order at risk · 12,000 EUR",
  );
  assert.ok(
    !o.topPriorities.some((p) => p.list === "freetext"),
    "freetext proposals are not a priority row",
  );
});

test("arrivedToday: only trigger='arrived' rows, newest first", () => {
  const rows: FindingIn[] = [
    f("at_risk", { ID: "a", trigger: "morning", arrivedAt: null }),
    f("overdue", {
      ID: "b",
      trigger: "arrived",
      arrivedAt: "2026-10-05T09:00:00Z",
      itemTitle: "Late arrival",
    }),
    f("overdue", {
      ID: "c",
      trigger: "arrived",
      arrivedAt: "2026-10-05T14:30:00Z",
      itemTitle: "Latest arrival",
    }),
  ];
  const o = computeOverview({
    findings: rows,
    impacts: [],
    pendingApprovals: 0,
  });
  assert.deepEqual(
    o.arrivedToday.map((p) => p.ID),
    ["c", "b"],
  );
});

test("topPriorities / arrivedToday: empty when nothing qualifies, not an error", () => {
  const o = computeOverview({ findings: [], impacts: [], pendingApprovals: 0 });
  assert.deepEqual(o.topPriorities, []);
  assert.deepEqual(o.arrivedToday, []);
});

test("topPriorities and arrivedToday respect buyer scope", () => {
  const rows: FindingIn[] = [
    f("at_risk", {
      ID: "a",
      PurchasingGroup: "001",
      impactCriticality: 1,
      revenueAtRisk: 500,
    }),
    f("at_risk", {
      ID: "b",
      PurchasingGroup: "002",
      impactCriticality: 1,
      revenueAtRisk: 900,
      trigger: "arrived",
      arrivedAt: "2026-10-05T10:00:00Z",
    }),
  ];
  const o = computeOverview({
    findings: rows,
    impacts: [],
    pendingApprovals: 0,
    scope: { PurchasingGroup: "001", Plant: "1010" },
  });
  assert.deepEqual(
    o.topPriorities.map((p) => p.ID),
    ["a"],
  );
  assert.deepEqual(o.arrivedToday, []);
});

test("overview() passes the as-of date and prepared-at timestamp through unchanged", () => {
  const withDataset = computeOverview({
    findings: [],
    impacts: [],
    pendingApprovals: 0,
    asOf: "2026-10-05",
    preparedAt: "2026-10-05T06:01:00Z",
  });
  assert.equal(withDataset.asOf, "2026-10-05");
  assert.equal(withDataset.preparedAt, "2026-10-05T06:01:00Z");
  const noDataset = computeOverview({
    findings: [],
    impacts: [],
    pendingApprovals: 0,
  });
  assert.equal(noDataset.asOf, null);
  assert.equal(noDataset.preparedAt, null);
});

const kpis = (o: Partial<OverviewKpis> = {}): OverviewKpis => ({
  atRisk: 0,
  revenueAtRisk: 0,
  codesPrefilled: 0,
  codesTotal: 0,
  codesToReview: 0,
  openPurchaseRequisitions: 0,
  requestsToReview: 0,
  requestsAwaitingApproval: 0,
  requestsCompleted: 0,
  requestReviewPercent: 0,
  pdtFindings: 0,
  preventionFindings: 0,
  pendingApprovals: 0,
  currency: "EUR",
  ...o,
});

test("narrative: a quiet day still gets a reassuring sentence", () => {
  assert.equal(narrative(kpis()), "No deliveries are currently at risk.");
});

test("narrative: names revenue at risk and free-text work awaiting a buyer", () => {
  const text = narrative(
    kpis({
      atRisk: 3,
      revenueAtRisk: 12400,
      pendingApprovals: 1,
      pdtFindings: 5,
      codesToReview: 2,
    }),
  );
  assert.equal(
    text,
    "3 deliveries at risk of arriving late, exposing 12,400 EUR in customer revenue. " +
      "1 action awaiting your decision, and 2 free-text requests to code.",
  );
});

test("narrative: singular wording for a count of one, and only the categories that are non-zero", () => {
  const text = narrative(kpis({ atRisk: 1, pendingApprovals: 1 }));
  assert.equal(
    text,
    "1 delivery at risk of arriving late. 1 action awaiting your decision.",
  );
});

test("topPriorities / arrivedToday rows carry every identifying field and a coloured source tag", () => {
  const rows: FindingIn[] = [
    f("at_risk", {
      ID: "at_risk:1",
      itemTitle: "4500000010/10 · Gear motor",
      itemSubtitle: "Supplier 0001 GmbH · Plant 1010",
      impactCriticality: 1,
      revenueAtRisk: 9000,
      dueDate: "2026-10-12",
      nextStep: "Prepare a reminder",
      source: "tabpfn",
      sourceText: "AI estimate",
    }),
  ];
  const o = computeOverview({
    findings: rows,
    impacts: [],
    pendingApprovals: 0,
  });
  assert.deepEqual(o.topPriorities[0], {
    ID: "at_risk:1",
    itemTitle: "4500000010/10 · Gear motor",
    itemSubtitle: "Supplier 0001 GmbH · Plant 1010",
    impactText: "",
    listText: "Deliveries at risk",
    list: "at_risk",
    nextStep: "Prepare a reminder",
    dueDate: "2026-10-12",
    sourceText: "AI estimate",
    sourceTag: "ai",
  });
});

test("source tag: the 8 source values collapse to ai | rule | history, none falls back to unknown", () => {
  const tagOf = (source: string) =>
    computeOverview({
      findings: [f("at_risk", { ID: "x", source })],
      impacts: [],
      pendingApprovals: 0,
    }).topPriorities[0].sourceTag;
  assert.equal(tagOf("tabpfn"), "ai");
  assert.equal(tagOf("rule"), "rule");
  assert.equal(tagOf("calculation"), "rule");
  assert.equal(tagOf("lookup"), "rule");
  assert.equal(tagOf("empirical"), "history");
  assert.equal(tagOf("fallback"), "history");
  assert.equal(tagOf("confirmation"), "history");
  assert.equal(tagOf("none"), "unknown");
});

test("topPriorities / arrivedToday rows default missing subtitle, due date and source to safe values", () => {
  const o = computeOverview({
    findings: [f("at_risk", { ID: "x" })],
    impacts: [],
    pendingApprovals: 0,
  });
  const row = o.topPriorities[0];
  assert.equal(row.itemSubtitle, "");
  assert.equal(row.dueDate, null);
  assert.equal(row.sourceText, SOURCE_WORD.rule); // the shared fixture builder f() defaults source to "rule"
  assert.equal(row.sourceTag, "rule");
});

test("trend: passed through unchanged, defaults to an empty array", () => {
  const trend = [
    { asOf: "2026-10-01", revenueAtRisk: 10000 },
    { asOf: "2026-10-05", revenueAtRisk: 27992 },
  ];
  const withTrend = computeOverview({
    findings: [],
    impacts: [],
    pendingApprovals: 0,
    trend,
  });
  assert.deepEqual(withTrend.trend, trend);
  const noTrend = computeOverview({
    findings: [],
    impacts: [],
    pendingApprovals: 0,
  });
  assert.deepEqual(noTrend.trend, []);
});
