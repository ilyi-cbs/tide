// Pure logic of deliveries at risk (P-1): no CDS.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEVELS,
  empiricalGrid,
  gridFrom,
  parseGrid,
  inWindow,
  isAtRisk,
  lateRates,
  morningList,
  pExceedEmpirical,
  pExceedFromQuantiles,
  pdtFlag,
  plantSample,
  rateFor,
  riskRank,
  sourceFor,
  verdictForItem,
  type RateRow,
  type Scored,
} from "../srv/cockpit/atrisk/domain/rules";
import {
  chainText,
  expertJson,
  issueText,
  rangeSentence,
  rangeWords,
  technicalChainText,
} from "../srv/cockpit/atrisk/domain/texts";
import { findingRow } from "../srv/cockpit/atrisk/finding";

test("fake grids retain test-provider attribution in findings and explanations", () => {
  const row = findingRow(
    {
      PurchaseOrder: "PO",
      PurchaseOrderItem: "10",
      PurchasingGroup: "001",
      source: "tabpfn",
      gap: 5,
      ruleVerdict: null,
      pLate: 0.6,
      net: 100,
      item: { PurchaseOrder: "PO", PurchaseOrderItem: "10" },
      plannedDays: 2,
      nOwn: 0,
      contextLevel: "plant",
      grid: { "0.10": 5, "0.50": 10, "0.90": 20 },
      gridSource: "fake",
    },
    {
      rank: 1,
      arrived: false,
      snapshotId: null,
      asOf: "2026-10-05",
      names: { material: new Map(), supplier: new Map(), plant: new Map() },
    },
  );
  assert.equal(row.source, "fake");
  assert.equal(row.atRiskDetail?.source, "fake");
  assert.match(row.issue!, /Test-provider/);
  assert.match(row.chain!, /not measured/);
  assert.match(row.expert!, /fake/);
  assert.match(
    rangeSentence("fake", 0, { p10: 5, p50: 10, p90: 20 }),
    /Test-provider/,
  );
});

test("19 levels 0.05 … 0.95", () => {
  assert.equal(LEVELS.length, 19);
  assert.equal(LEVELS[0], 0.05);
  assert.equal(LEVELS[18], 0.95);
  assert.equal(LEVELS[9], 0.5);
});

test("window is inclusive on both ends", () => {
  assert.ok(inWindow("2026-03-02", "2026-03-02", "2026-03-16"));
  assert.ok(inWindow("2026-03-16", "2026-03-02", "2026-03-16"));
  assert.ok(!inWindow("2026-03-01", "2026-03-02", "2026-03-16"));
  assert.ok(!inWindow("2026-03-17", "2026-03-02", "2026-03-16"));
  assert.ok(!inWindow(null, "2026-03-02", "2026-03-16"));
});

test("placeholder rule and source", () => {
  assert.equal(pdtFlag(null), "not_maintained");
  assert.equal(pdtFlag(0), "not_maintained");
  assert.equal(pdtFlag(2), "default");
  for (const v of [180, 360, 999, 200]) assert.equal(pdtFlag(v), "placeholder");
  assert.equal(pdtFlag(14), null);
  assert.equal(sourceFor(14, 0), "rule");
  assert.equal(sourceFor(2, 20), "empirical");
  assert.equal(sourceFor(0, 19), "tabpfn");
  assert.equal(sourceFor(999, 50), "empirical");
});

test("ranks", () => {
  assert.equal(riskRank({ source: "rule", gap: -1, ruleVerdict: "fires" }), 0);
  assert.equal(riskRank({ source: "tabpfn", gap: -3, ruleVerdict: null }), 0);
  assert.equal(riskRank({ source: "rule", gap: 5, ruleVerdict: "fires" }), 1);
  assert.equal(riskRank({ source: "empirical", gap: 5, ruleVerdict: null }), 2);
  assert.equal(
    riskRank({ source: "rule", gap: 20, ruleVerdict: "does_not_fire" }),
    3,
  );
});

const s = (o: Partial<Scored>): Scored => ({
  PurchaseOrder: "4500000001",
  PurchaseOrderItem: "10",
  PurchasingGroup: "001",
  source: "tabpfn",
  gap: 5,
  ruleVerdict: null,
  pLate: 0.6,
  net: 100,
  ...o,
});

test("at risk: rank ≤ 1 or non-rule with P ≥ 0.5", () => {
  assert.ok(isAtRisk(s({ source: "rule", ruleVerdict: "fires", pLate: 0.1 })));
  assert.ok(
    !isAtRisk(s({ source: "rule", ruleVerdict: "does_not_fire", pLate: 0.9 })),
  );
  assert.ok(isAtRisk(s({ pLate: 0.5 })));
  assert.ok(!isAtRisk(s({ pLate: 0.49 })));
  assert.ok(isAtRisk(s({ gap: -2, pLate: 0.1 })));
});

test("sort: group, rank, net desc, P × net desc; top 20 per group", () => {
  const items = [
    s({ PurchaseOrder: "a", PurchasingGroup: "002", pLate: 0.9, net: 10 }),
    s({ PurchaseOrder: "b", PurchasingGroup: "001", pLate: 0.6, net: 50 }),
    s({
      PurchaseOrder: "c",
      PurchasingGroup: "001",
      source: "rule",
      ruleVerdict: "fires",
      pLate: 0.3,
      net: 1,
    }),
    s({
      PurchaseOrder: "d",
      PurchasingGroup: "001",
      gap: -1,
      pLate: 0.1,
      net: 1,
    }),
    s({ PurchaseOrder: "e", PurchasingGroup: "001", pLate: 0.9, net: 50 }),
    s({ PurchaseOrder: "f", PurchasingGroup: "001", pLate: 0.2, net: 5000 }),
  ];
  assert.deepEqual(
    morningList(items).map((i) => i.PurchaseOrder),
    ["d", "c", "e", "b", "a"],
  );
  const many = Array.from({ length: 30 }, (_, k) =>
    s({ PurchaseOrder: `x${k}`, net: k }),
  );
  const top = morningList([
    ...many,
    s({ PurchaseOrder: "other", PurchasingGroup: "009" }),
  ]);
  assert.equal(top.filter((t) => t.PurchasingGroup === "001").length, 20);
  assert.equal(top[0].PurchaseOrder, "x29");
  assert.equal(top.at(-1)!.PurchaseOrder, "other");
});

test("rule rate: window [T−365, T−30), no receipt = late, plant ≥ 50 rows else overall", () => {
  const asOf = "2026-06-01";
  const rows: RateRow[] = [];
  // Plant A: 50 fires rows, 10 late (receipt after requested), 5 without receipt (late).
  for (let k = 0; k < 50; k++)
    rows.push({
      Plant: "A",
      PurchaseOrderDate: "2026-01-01",
      RequestedDate: "2026-01-05",
      ReceiptDate: k < 10 ? "2026-01-10" : k < 15 ? null : "2026-01-04",
      PlannedDays: 10,
    });
  // Plant B: 10 fires rows, all late.
  for (let k = 0; k < 10; k++)
    rows.push({
      Plant: "B",
      PurchaseOrderDate: "2026-01-01",
      RequestedDate: "2026-01-05",
      ReceiptDate: null,
      PlannedDays: 10,
    });
  // Outside the window (due 20 days before as-of) and a receipt known only after as-of.
  rows.push({
    Plant: "A",
    PurchaseOrderDate: "2026-05-01",
    RequestedDate: "2026-05-12",
    ReceiptDate: null,
    PlannedDays: 30,
  });
  rows.push({
    Plant: "B",
    PurchaseOrderDate: "2026-01-01",
    RequestedDate: "2026-02-01",
    ReceiptDate: "2026-06-02",
    PlannedDays: 5,
  });
  const r = lateRates(rows, asOf);
  assert.equal(r.fires.rows, 60);
  assert.equal(r.fires.perPlant.A, 0.3);
  assert.equal(r.fires.perPlant.B, undefined);
  assert.equal(rateFor(r, "fires", "A"), 0.3);
  assert.ok(Math.abs(rateFor(r, "fires", "B")! - 25 / 60) < 1e-4);
  assert.equal(r.does_not_fire.rows, 1);
  assert.equal(r.does_not_fire.overall, 1);
});

test("empirical P: share of own lead times above the gap, clipped", () => {
  const h = Array.from({ length: 20 }, (_, k) => k + 1); // 1..20
  assert.equal(pExceedEmpirical(h, 10), 0.5);
  assert.equal(pExceedEmpirical(h, 0), 0.975);
  assert.equal(pExceedEmpirical(h, 30), 0.025);
});

test("model P: 1 − F(gap + 0.5), interpolated, tails split", () => {
  const q = LEVELS.map((l) => l * 100); // F(x) = x / 100
  assert.ok(Math.abs(pExceedFromQuantiles(q, 49.5) - 0.5) < 1e-6);
  assert.ok(Math.abs(pExceedFromQuantiles(q, 19.5) - 0.8) < 1e-6);
  assert.ok(Math.abs(pExceedFromQuantiles(q, 0) - 0.975) < 1e-9);
  assert.ok(Math.abs(pExceedFromQuantiles(q, 500) - 0.025) < 1e-9);
});

test("grids: monotone, ≥ 0, 19 levels", () => {
  const g = gridFrom([5, -1, 3, ...Array(16).fill(10)]);
  const v = LEVELS.map((l) => g[l.toFixed(2)]);
  assert.equal(v.length, 19);
  assert.ok(v.every((x, i) => x >= 0 && (i === 0 || x >= v[i - 1])));
  const e = empiricalGrid(Array.from({ length: 21 }, (_, k) => k));
  assert.equal(e["0.50"], 10);
  assert.equal(e["0.05"], 1);
});

test("single-item verdict", () => {
  assert.equal(verdictForItem({ gap: -1, plannedDays: 10 }).atRisk, true);
  const rule = verdictForItem({ gap: 5, plannedDays: 10, rate: 0.4 });
  assert.deepEqual(
    [rule.atRisk, rule.source, rule.rank, rule.pLate],
    [true, "rule", 1, 0.4],
  );
  assert.equal(verdictForItem({ gap: 12, plannedDays: 10 }).atRisk, false);
  const grid = gridFrom(LEVELS.map((l) => l * 20));
  const model = verdictForItem({ gap: 5, plannedDays: 2, grid });
  assert.deepEqual(
    [model.atRisk, model.source, model.rank],
    [true, "tabpfn", 2],
  );
  assert.ok(model.pLate! > 0.5);
  assert.equal(verdictForItem({ gap: 15, plannedDays: 0, grid }).atRisk, false);
  assert.equal(verdictForItem({ gap: 5, plannedDays: 0 }).atRisk, false);
  assert.equal(verdictForItem({ gap: null, plannedDays: 10 }).atRisk, false);
});

test("texts: buyer words on the first view, no percentages", () => {
  const t = {
    source: "rule" as const,
    gap: 5,
    plannedDays: 14,
    flag: null,
    p50: null,
  };
  assert.equal(
    issueText(t),
    "Needed in 5 days, the planned time is 14 days; expected 9 days late",
  );
  assert.match(
    chainText(t),
    /^Checked this morning: .* → Next: prepare a reminder\.$/,
  );
  assert.match(
    technicalChainText(t),
    /^morning run at 06:00 → .*\(rule\) → gap 5 days, planned 14 days; expected 9 days late → prepare a reminder$/,
  );
  const m = {
    source: "tabpfn" as const,
    gap: 5,
    plannedDays: 2,
    flag: "default" as const,
    p50: 11.4,
    arrived: true,
  };
  assert.equal(
    issueText(m),
    "Needed in 5 days, similar deliveries usually take 12 days; expected 7 days late",
  );
  assert.match(chainText(m), /^Checked as it arrived: /);
  const banned = /TabPFN|p10|p50|p80|p90|quantile|empirical|%/i;
  for (const x of [issueText(m), chainText(m), issueText(t), chainText(t)])
    assert.doesNotMatch(x, banned);
  assert.equal(
    issueText({ ...t, gap: -3 }),
    "Requested 3 days before the order date",
  );
  const none = {
    source: "empirical" as const,
    gap: 11,
    plannedDays: 0,
    flag: "not_maintained" as const,
    p50: 20,
  };
  assert.match(
    chainText(none),
    /No planned time is maintained\. Past deliveries usually take 20 days\. Expected 9 days late\./,
  );
});

test("range sentences", () => {
  assert.equal(
    rangeSentence("empirical", 24, { p10: 8, p50: 12, p90: 20 }),
    "Your last 24 deliveries took 12 days on average, mostly between 8 and 20.",
  );
  assert.match(
    rangeSentence("tabpfn", 3, { p10: 8, p50: 12, p90: 20 }),
    /^AI estimate from similar deliveries.*not a promise\.$/,
  );
});

test("range words and grid codec", () => {
  assert.equal(
    rangeWords({ p10: 8, p50: 12, p90: 20 }, 5, 14),
    "Fast 8 days · typical 12 days · slow 20 days. Requested 5 days after the order, planned 14 days.",
  );
  assert.equal(
    rangeWords({ p10: null, p50: null, p90: null }),
    "No estimate for this delivery yet.",
  );
  const g = gridFrom(LEVELS.map((l) => l * 10));
  assert.deepEqual(parseGrid(JSON.stringify(g)), g);
  assert.deepEqual(parseGrid(JSON.stringify(LEVELS.map((l) => l * 10))), g);
  assert.equal(parseGrid("{bad"), null);
  assert.equal(parseGrid(JSON.stringify([1, 2])), null);
});

test("expert JSON labels", () => {
  const base = {
    pLate: 0.61234,
    gap: 5,
    plannedDays: 2,
    flag: null,
    riskRank: 2,
    ruleVerdict: null,
    nOwn: 3,
    contextLevel: "plant",
    gridRef: "4500/10",
  };
  assert.equal(
    JSON.parse(expertJson({ ...base, source: "rule" })).label,
    "historical late rate of this verdict",
  );
  const m = JSON.parse(expertJson({ ...base, source: "tabpfn" }));
  assert.equal(m.label, "for ordering, not calibrated");
  assert.equal(m.p_late, 0.612);
});

test("plant sample: seeded, sorted by PO/item, at most N", () => {
  const all = Array.from({ length: 100 }, (_, k) => ({
    PurchaseOrder: String(4500000000 + ((k * 37) % 100)),
    PurchaseOrderItem: "10",
  }));
  const a = plantSample(all, 10);
  assert.equal(a.length, 10);
  assert.deepEqual(a, plantSample(all, 10));
  assert.deepEqual(
    a,
    [...a].sort((x, y) => x.PurchaseOrder.localeCompare(y.PurchaseOrder)),
  );
  assert.equal(plantSample(all, 1000).length, 100);
});
