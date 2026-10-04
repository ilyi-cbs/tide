// Pure lead-time logic (P-3 … P-6): ladder, placeholder rule, proposal,
// buffer simulator split, material master weighting and mismatch.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pdtFinding,
  mmFindings,
} from "../srv/cockpit/leadtimes/lists";
import {
  SETTING_FEATURES,
  materialSettingComparison,
  supplierSettingTrigger,
} from "../srv/cockpit/leadtimes/setting-check";
import {
  LEVELS,
  bufferSentence,
  bufferSimulator,
  chooseLevel,
  currentValue,
  ladder,
  masterSignal,
  mmIssue,
  mmProposals,
  mmSources,
  modelRange,
  outOfScope,
  ownRange,
  pdtCheck,
  pdtIssue,
  pdtOrder,
  pdtProposal,
  placeholderRule,
  splitByReceipt,
} from "../srv/cockpit/leadtimes/domain/leadtimes";

const KEY = { Material: "M1", Supplier: "S1", Plant: "1010" };
test("planned-time cases require independent model triggers and retain both evidence sources", () => {
  const key = "M1|S1|1010";
  const range = {
    source: "tabpfn",
    contextRows: 30,
    p10: 10,
    p50: 15,
    p80: 18,
    p90: 20,
  };
  const own = new Map([
    [key, Array.from({ length: 30 }, () => ({ lt: 20, date: "2026-09-01" }))],
  ]);
  const nm = { material: new Map(), supplier: new Map() };
  const supplier: any = {
    asOf: "2026-10-01",
    nm,
    own,
    ir: new Map([[key, { ...KEY, MaterialPlannedDeliveryDurn: 5 }]]),
    master: new Map([["M1|1010", { PlannedDeliveryDurationInDays: 5 }]]),
    act: new Map([[key, { n: 30, value: 1000 }]]),
  };
  assert.equal(pdtFinding(key, supplier), null);
  supplier.settingRanges = new Map([[key, { ...range, source: "fallback" }]]);
  assert.equal(pdtFinding(key, supplier), null);
  supplier.settingRanges.set(key, range);
  const finding: any = pdtFinding(key, supplier);
  assert.equal(finding.source, "tabpfn");
  assert.equal(finding.pdtDetail.settingRange.p50, 15);
  assert.equal(finding.pdtDetail.rangeP50, 20);
  assert.equal(finding.pdtDetail.proposalDays, 20);
  const material: any = {
    asOf: supplier.asOf,
    nm,
    own,
    master: supplier.master,
    reps: new Map(),
    groups: new Map(),
    sources: new Map([
      [
        "1010",
        [
          {
            Material: "M1",
            Supplier: "S1",
            pos: 30,
            own: 30,
            median: 20,
            source: "empirical",
          },
        ],
      ],
    ]),
  };
  assert.deepEqual(mmFindings(material), []);
  material.settingRanges = supplier.settingRanges;
  const [master]: any[] = mmFindings(material);
  assert.equal(master.source, "tabpfn");
  assert.equal(master.mmPdtDetail.settingSources[0].range.p50, 15);
  assert.equal(master.mmPdtDetail.settingSources[0].empiricalRange.p50, 20);
});

test("independent setting checks exclude maintained-value aliases and require full model coverage", () => {
  assert.ok(!SETTING_FEATURES.includes("PlannedDays"));
  assert.ok(!SETTING_FEATURES.includes("RequestedGapDays"));
  const range = { source: "tabpfn", contextRows: 30, p10: 8, p50: 12, p90: 16 };
  assert.equal(supplierSettingTrigger(4, range), true);
  assert.equal(supplierSettingTrigger(null, range), false);
  assert.equal(
    supplierSettingTrigger(4, { ...range, source: "fallback" }),
    false,
  );
  assert.equal(supplierSettingTrigger(4, { ...range, contextRows: 4 }), false);
  assert.equal(
    materialSettingComparison(4, [
      { orders: 3, range },
      { orders: 1, range: { ...range, p50: 20 } },
    ]).value,
    14,
  );
  assert.equal(
    materialSettingComparison(4, [
      { orders: 3, range },
      { orders: 1, range: null },
    ]).trigger,
    false,
  );
  assert.equal(
    materialSettingComparison(4, [
      { orders: 3, range },
      { orders: 1, range: { ...range, source: "fallback" } },
    ]).value,
    null,
  );
  assert.equal(
    materialSettingComparison(null, [{ orders: 3, range }]).trigger,
    false,
  );
});
const seq = <T = number>(n: number, f: (i: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => f(i));

test("ladder: material+supplier → material → supplier → material group → plant", () => {
  assert.deepEqual(
    ladder({ Material: "M", Supplier: "S", MaterialGroup: "G" }).map(
      (l) => l.level,
    ),
    ["material_supplier", "material", "supplier", "material_group", "plant"],
  );
  assert.deepEqual(
    ladder({ Supplier: "S" }).map((l) => l.level),
    ["supplier", "plant"],
  );
});

test("chooseLevel takes the first level with at least 5 rows, capped at 2,500", async () => {
  const counts: Record<string, number> = {
    "M|S": 3,
    "M|": 4,
    "|S": 9000,
    G: 50,
  };
  const pick = await chooseLevel(
    { Material: "M", Supplier: "S", MaterialGroup: "G" },
    (f) =>
      f.MaterialGroup
        ? counts.G
        : (counts[`${f.Material ?? ""}|${f.Supplier ?? ""}`] ?? 0),
  );
  assert.equal(pick.level, "supplier");
  assert.equal(pick.rows, 2500);
  const plant = await chooseLevel({ Material: "M" }, (f) =>
    f.Material ? 1 : 3,
  );
  assert.equal(plant.level, "plant");
});

test("range: own history ≥ 20 is empirical on 19 monotone levels with a buyer sentence", () => {
  assert.equal(
    ownRange(
      KEY,
      seq(19, () => 10),
    ),
    null,
  );
  const r = ownRange(
    KEY,
    seq(40, (i) => 10 + (i % 10)),
  )!;
  assert.equal(r.source, "empirical");
  const lv = JSON.parse(r.levels!);
  assert.equal(Object.keys(lv).length, 19);
  assert.deepEqual(Object.keys(lv).map(Number), LEVELS);
  assert.ok("0.10" in lv && "0.95" in lv);
  const vals = Object.values(lv) as number[];
  assert.ok(vals.every((v, i) => v >= 0 && (i === 0 || v >= vals[i - 1])));
  assert.match(
    r.sentence,
    /^Your last 40 deliveries took .* days on average, mostly between .* and .*\.$/,
  );
});

test("range: model answer is an AI estimate; a fallback is explicit and noted", () => {
  const q = LEVELS.map((l) => 20 * l);
  const r = modelRange(KEY, 3, "material", 12, q, null);
  assert.equal(r.source, "tabpfn");
  assert.equal(r.contextLevel, "material within plant");
  assert.match(
    r.sentence,
    /AI estimate from similar deliveries.*not a promise/,
  );
  const f = modelRange(
    KEY,
    3,
    "plant",
    12,
    [5, 3, ...q.slice(2)],
    "context_quantiles",
  );
  assert.equal(f.source, "fallback");
  assert.match(f.note!, /no|without/);
  assert.ok(!/AI estimate/.test(f.sentence));
  const lv = JSON.parse(f.levels!);
  assert.ok(lv["0.10"] >= lv["0.05"]);
  const o = outOfScope(KEY, "40");
  assert.equal(o.source, "rule");
  assert.equal(o.p50, null);
});

test("placeholder rule: 0/empty, 2, 180/360/999/≥ 180", () => {
  assert.equal(placeholderRule(null), "not_maintained");
  assert.equal(placeholderRule(0), "not_maintained");
  assert.equal(placeholderRule(""), "not_maintained");
  assert.equal(placeholderRule(2), "default");
  for (const v of [180, 360, 999, 200])
    assert.equal(placeholderRule(v), "placeholder");
  for (const v of [1, 3, 14, 179]) assert.equal(placeholderRule(v), null);
});

test("current value: info record if > 0, else material master; signal at ≥ 2 days", () => {
  assert.deepEqual(currentValue(7, 10), { days: 7, from: "info record" });
  assert.deepEqual(currentValue(0, 10), { days: 10, from: "material master" });
  assert.deepEqual(currentValue(null, null), {
    days: null,
    from: "material master",
  });
  assert.equal(masterSignal(7, 9), true);
  assert.equal(masterSignal(7, 8), false);
  assert.equal(masterSignal(0, 9), false);
});

test("pdt check: rule first, else outside p10…p90 of ≥ 20 own; proposal ceil(p80)", () => {
  const own = seq(20, (i) => 10 + i); // 10..29
  assert.equal(pdtCheck(2, [])!.verdict, "default");
  assert.equal(pdtCheck(2, [])!.source, "rule");
  assert.equal(
    pdtCheck(
      5,
      seq(19, () => 10),
    ),
    null,
  ); // too few to compare
  const below = pdtCheck(5, own)!;
  assert.equal(below.verdict, "below_range");
  assert.equal(below.source, "empirical");
  assert.equal(pdtCheck(40, own)!.verdict, "above_range");
  assert.equal(pdtCheck(20, own), null);
  assert.equal(pdtProposal(own), Math.ceil(10 + 0.8 * 19));
  assert.equal(pdtProposal(seq(19, () => 10)), null);
  const text = pdtIssue({
    current: 5,
    from: "info record",
    check: below,
    proposal: 26,
    nOwn: 20,
  });
  assert.equal(text, "Info record 5 days: shorter than recent deliveries");
  assert.ok(!/p10|p90|empirical/.test(text));
});

test("pdt order: 12-month value desc, then PO count desc", () => {
  const rows = [
    { id: "a", value12m: 10, pos12m: 1 },
    { id: "b", value12m: 50, pos12m: 1 },
    { id: "c", value12m: 10, pos12m: 5 },
  ];
  assert.deepEqual(
    rows.sort(pdtOrder).map((r) => r.id),
    ["b", "c", "a"],
  );
});

test("buffer simulator: older 70 % / later 30 % by receipt order", () => {
  assert.deepEqual(
    bufferSimulator(
      seq(19, () => 1),
      5,
    ),
    [],
  );
  const { older, later } = splitByReceipt(seq(20, (i) => i));
  assert.equal(older.length, 14);
  assert.deepEqual(later, [14, 15, 16, 17, 18, 19]);
  // Older part fast (10 days), later part slow (20 days): every proposal from the older part is late.
  const lts = [...seq(14, () => 10), ...seq(6, () => 20)];
  const rows = bufferSimulator(lts, 25);
  const q = rows.filter((r) => !r.isCurrent);
  assert.deepEqual(
    q.map((r) => r.quantile),
    [0.5, 0.6, 0.7, 0.8, 0.9],
  );
  assert.ok(
    q.every(
      (r) =>
        r.proposalDays === 10 &&
        r.lateShare === 1 &&
        r.meanDaysLate === 10 &&
        r.nOlder === 14 &&
        r.nLater === 6,
    ),
  );
  const cur = rows.find((r) => r.isCurrent)!;
  assert.equal(cur.proposalDays, 25);
  assert.equal(cur.lateShare, 0);
  assert.equal(cur.meanBufferDays, 5);
  assert.match(
    bufferSentence(cur),
    /If you plan with 25 days: later than planned none\. Deliveries arrive 5 days early/,
  );
  assert.match(bufferSentence(q[0]), /every delivery/);
});

test("mm_pdt: sources, share weighting, mismatch and sort", () => {
  const asOf = "2026-10-05";
  const po = (m: string, s: string, d = "2026-06-01") => ({
    Material: m,
    Supplier: s,
    PurchaseOrderDate: d,
  });
  const pos = [
    ...seq(4, () => po("A", "S1")),
    ...seq(1, () => po("A", "S2")),
    po("A", "S2", "2025-01-01"), // outside 365 days
    ...seq(6, () => po("B", "S1")),
    ...seq(4, () => po("C", "S1")), // < 5 POs
    ...seq(9, () => po("T", "S1")), // stock transfer
  ];
  const own = (m: string, s: string) =>
    m === "A" && s === "S1"
      ? seq(20, () => 10)
      : m === "A" && s === "S2"
        ? seq(3, () => 99)
        : m === "B"
          ? seq(25, () => 30)
          : [];
  const src = mmSources(pos, asOf, new Set(["T"]), own, (m, s) =>
    s === "S1" ? 12 : null,
  );
  assert.deepEqual(
    src.map((s) => `${s.Material}${s.Supplier}`),
    ["AS1", "AS2", "BS1"],
  );
  const a2 = src.find((s) => s.Supplier === "S2")!;
  assert.equal(a2.share, 0.2);
  assert.equal(a2.source, "tabpfn");
  assert.equal(a2.median, null);
  a2.median = 35; // the model's p50
  // A: (0.8 × 10 + 0.2 × 35) / 1 = 15 → proposal 15; master 15 → no mismatch.
  // B: 30; master missing → mismatch.
  const master = (m: string) => (m === "A" ? 15 : null);
  const props = mmProposals(src, master);
  assert.deepEqual(
    props.map((p) => p.Material),
    ["B", "A"],
  );
  const a = props.find((p) => p.Material === "A")!;
  assert.equal(a.proposal, 15);
  assert.equal(a.mismatch, false);
  assert.equal(props[0].mismatch, true);
  assert.equal(props[0].masterFlag, "not_maintained");
  // Tolerance max(3, 0.2 × proposal): 15 ± 3 → 19 is a mismatch, 18 is not.
  assert.equal(
    mmProposals(src, (m) => (m === "A" ? 18 : 30)).find(
      (p) => p.Material === "A",
    )!.mismatch,
    false,
  );
  assert.equal(
    mmProposals(src, (m) => (m === "A" ? 19 : 30)).find(
      (p) => p.Material === "A",
    )!.mismatch,
    true,
  );
  const big = mmProposals(src, (m) => (m === "A" ? 2 : 30)).find(
    (p) => p.Material === "A",
  )!;
  assert.equal(big.masterFlag, "default");
  assert.match(
    mmIssue(big),
    /Material master 2 days \(system default\): 13 days too short; suppliers suggest 15 days/,
  );
});
