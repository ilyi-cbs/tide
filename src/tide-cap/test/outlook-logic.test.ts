// Pure delivery outlook (object page timeline and options): no CDS.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  headline,
  forecastKind,
  outlook,
  type OutlookInput,
} from "../srv/cockpit/outlook/domain/outlook";
import {
  arrivalSentence,
  chanceSentence,
  chanceWords,
} from "../srv/cockpit/atrisk/domain/texts";

const base: OutlookInput = {
  asOf: "2025-12-01",
  list: "at_risk",
  status: "open",
  nextActionKind: "reminder",
  poDate: "2025-11-01",
  requested: "2025-12-08",
  plannedDays: 30,
  grid: {
    p10: "2025-12-03",
    p50: "2025-12-12",
    p80: "2025-12-20",
    p90: "2025-12-28",
    basis: "grid",
    source: "tabpfn",
    sourceText: "AI estimate",
    ownP10: null,
    ownP50: null,
    ownP90: null,
    nOwn: 3,
    agreement: null,
  },
  impact: {
    level: "customer_order_late",
    levelText: "Customer order at risk · 18,973 EUR",
    needDate: "2025-12-11",
    shortageFrom: null,
  },
  action: null,
  confirmedDate: null,
  rootCause: null,
  siblingReceived: null,
  canSimulate: true,
};

test("headline: due in / overdue by", () => {
  assert.equal(
    headline("at_risk", "2025-12-08", "2025-12-01"),
    "Due in 7 days",
  );
  assert.equal(headline("at_risk", "2025-12-01", "2025-12-01"), "Due today");
  assert.equal(
    headline("overdue", "2025-10-01", "2025-12-01"),
    "Overdue by 61 days",
  );
});

test("markers sorted by date, needed date only when it differs from requested", () => {
  const o = outlook(base);
  assert.deepEqual(
    o.markers.map((m) => m.kind),
    ["ordered", "today", "requested", "needed"],
  );
  const same = outlook({
    ...base,
    impact: { ...base.impact!, needDate: "2025-12-08" },
  });
  assert.ok(!same.markers.some((m) => m.kind === "needed"));
});

test("confirmation replaces the forecast band and is never represented as a model promise", () => {
  const o = outlook({ ...base, confirmedDate: "2025-12-18" });
  assert.ok(
    o.markers.some((m) => m.kind === "confirmed" && m.date === "2025-12-18"),
  );
  assert.ok(!o.bands.some((b) => b.kind === "estimate"));
  assert.match(
    o.situation,
    /Supplier confirmed 18 Dec 2025, after the requested date/,
  );
  assert.equal(o.estimateSource, "Supplier confirmation");
  assert.equal(o.plannedDays, 30);
});

test("on-time probability complements a valid TabPFN late probability", () => {
  for (const chanceLate of [0, 0.27, 1]) {
    const result = outlook({ ...base, grid: { ...base.grid!, chanceLate } });
    assert.equal(
      result.onTimeProbability,
      Math.round((1 - chanceLate) * 10000) / 10000,
    );
    assert.equal(result.requestedDateMissed, false);
  }
  assert.equal(
    outlook({
      ...base,
      requested: base.asOf,
      grid: { ...base.grid!, chanceLate: 0.4 },
    }).onTimeProbability,
    0.6,
  );
});

test("overdue requests expose a missed-date flag rather than a probability", () => {
  const result = outlook({
    ...base,
    requested: "2025-11-30",
    grid: { ...base.grid!, chanceLate: 0.5 },
  });
  assert.equal(result.requestedDateMissed, true);
  assert.equal(result.onTimeProbability, null);
});

test("missing, invalid, historical, and confirmed forecasts do not expose an AI probability", () => {
  for (const chanceLate of [undefined, null, NaN, Infinity, -0.1, 1.1]) {
    assert.equal(
      outlook({ ...base, grid: { ...base.grid!, chanceLate } })
        .onTimeProbability,
      null,
    );
  }
  assert.equal(
    outlook({
      ...base,
      requested: null,
      grid: { ...base.grid!, chanceLate: 0.5 },
    }).onTimeProbability,
    null,
  );
  assert.equal(
    outlook({
      ...base,
      grid: { ...base.grid!, source: "empirical", chanceLate: 0.5 },
    }).onTimeProbability,
    null,
  );
  assert.equal(
    outlook({
      ...base,
      confirmedDate: "2025-12-03",
      grid: { ...base.grid!, chanceLate: 0.5 },
    }).onTimeProbability,
    null,
  );
});

test("missing estimate is explicit and never labelled as an AI prediction", () => {
  const o = outlook({ ...base, grid: null, plannedDays: null });
  assert.equal(o.bands.length, 0);
  assert.match(o.situation, /No reliable arrival estimate/);
  assert.equal(o.estimateSource, "No reliable estimate");
});

test("a typical-date prediction is shown even if the arrival range is incomplete", () => {
  const o = outlook({ ...base, grid: { ...base.grid!, p90: null } });
  assert.equal(o.bands.length, 0);
  assert.equal(o.mostLikelyDate, "2025-12-12");
  assert.equal(o.estimateSource, "AI forecast (TabPFN)");
  assert.match(o.situation, /Expected around 12 Dec 2025/);
});

test("TabPFN forecasts expose dated 50, 80, and 90 percent planning scenarios", () => {
  const o = outlook(base);
  assert.equal(o.hasAiPrediction, true);
  assert.equal(o.forecastKind, "tabpfn");
  assert.deepEqual(o.scenarios, [
    { level: 10, arrivalDate: "2025-12-03" },
    { level: 50, arrivalDate: "2025-12-12" },
    { level: 80, arrivalDate: "2025-12-20" },
    { level: 90, arrivalDate: "2025-12-28" },
  ]);
});

test("non-AI forecasts never expose AI prediction scenarios", () => {
  const confirmation = outlook({ ...base, confirmedDate: "2025-12-18" });
  const historical = outlook({
    ...base,
    grid: { ...base.grid!, source: "empirical", sourceText: "Past deliveries" },
  });
  const sapPlanned = outlook({ ...base, grid: null });
  assert.equal(confirmation.hasAiPrediction, false);
  assert.equal(confirmation.forecastKind, "confirmation");
  assert.equal(historical.hasAiPrediction, false);
  assert.equal(historical.forecastKind, "empirical");
  assert.equal(historical.bands[0].label, "Historical arrival window");
  assert.equal(sapPlanned.hasAiPrediction, false);
  assert.equal(sapPlanned.forecastKind, "sap_planned");
});

test("AI-only delivery outlook never replaces TabPFN with historical or planned estimates", () => {
  for (const grid of [
    null,
    { ...base.grid!, source: "empirical", basis: "survivors" },
    { ...base.grid!, source: "fallback" },
  ]) {
    const result = outlook({ ...base, aiOnly: true, grid });
    assert.equal(result.mostLikelyDate, null);
    assert.equal(result.forecastKind, "none");
    assert.equal(result.hasAiPrediction, false);
    assert.deepEqual(result.scenarios, []);
    assert.deepEqual(result.bands, []);
  }
  const result = outlook({ ...base, aiOnly: true });
  assert.equal(result.forecastKind, "tabpfn");
  assert.equal(result.estimateSource, "AI forecast (TabPFN)");
  assert.deepEqual(
    result.scenarios.map((scenario) => scenario.level),
    [10, 50, 80, 90],
  );
});

test("forecast origin comes from the structured source, never source text", () => {
  assert.equal(
    forecastKind({
      ...base,
      grid: { ...base.grid!, source: "empirical", sourceText: "AI estimate" },
    }),
    "empirical",
  );
  assert.equal(
    forecastKind({
      ...base,
      grid: { ...base.grid!, source: "tabpfn", sourceText: "Past deliveries" },
    }),
    "tabpfn",
  );
});

test("SAP planned delivery time supplies a dated fallback when there is no model result", () => {
  const o = outlook({ ...base, grid: null });
  assert.equal(o.mostLikelyDate, "2025-12-01");
  assert.equal(o.estimateSource, "SAP planned delivery time");
  assert.match(o.situation, /SAP's planned delivery time points to 1 Dec 2025/);
});

test("bands: estimate always, own history only when dated; survivors labelled", () => {
  assert.equal(outlook(base).bands.length, 1);
  const own = outlook({
    ...base,
    grid: {
      ...base.grid!,
      ownP10: "2025-12-02",
      ownP50: "2025-12-10",
      ownP90: "2025-12-18",
      nOwn: 25,
      agreement: "aligned",
    },
  });
  assert.deepEqual(
    own.bands.map((b) => b.kind),
    ["estimate", "own"],
  );
  assert.match(own.agreementText, /agree/);
  const surv = outlook({
    ...base,
    grid: { ...base.grid!, basis: "survivors" },
  });
  assert.equal(surv.bands[0].label, "Historical arrival window");
});

test("options: severe impact recommends an earlier delivery commitment, first and only one recommended", () => {
  const o = outlook(base).options;
  assert.equal(o[0].kind, "remind");
  assert.equal(o[0].title, "Request an earlier delivery commitment");
  assert.equal(o[0].operation, "addToApprovals");
  assert.match(o[0].effect, /for approval/);
  assert.equal(o.filter((x) => x.operation === "addToApprovals").length, 1);
  assert.equal(o.filter((x) => x.recommended).length, 1);
  assert.ok(o.some((x) => x.kind === "simulate"));
});

test("options: stock covers an at-risk item -> monitor delivery status", () => {
  const o = outlook({
    ...base,
    impact: {
      level: "covered_by_stock",
      levelText: "Stock covers it",
      needDate: null,
      shortageFrom: null,
    },
  }).options;
  assert.equal(o[0].kind, "watch");
  assert.ok(o.some((x) => x.kind === "remind" && !x.recommended));
});

test("options: overdue delivery requests confirmation and identifies a sibling receipt", () => {
  const o = outlook({
    ...base,
    list: "overdue",
    requested: "2025-10-01",
    impact: null,
    siblingReceived: "2025-10-20",
  }).options;
  assert.equal(o[0].title, "Request a confirmed delivery date");
  const check = o.find((x) => x.kind === "checkReceipt")!;
  assert.match(check.reason, /20 Oct 2025/);
  assert.equal(check.operation, "checkReceipt");
  assert.equal(check.target, null);
  assert.match(check.effect, /no action is prepared/);
});

test("options: waiting reminder records confirmation; prepared reminder opens for review; no second reminder", () => {
  const waiting = outlook({
    ...base,
    action: { ID: "a1", status: "waiting", since: "2025-11-28" },
  }).options;
  assert.equal(waiting[0].kind, "confirm");
  assert.match(waiting[0].reason, /28 Nov 2025/);
  assert.ok(!waiting.some((x) => x.kind === "remind"));
  const prepared = outlook({
    ...base,
    action: { ID: "a2", status: "needs_decision", since: null },
  }).options;
  assert.equal(prepared[0].kind, "openAction");
  assert.equal(prepared[0].target, "a2");
});

test("options: root cause link and closed findings offer no reminder", () => {
  const o = outlook({
    ...base,
    status: "closed",
    rootCause: { ID: "pdt:M|S|P", issue: "Planned time is the system default" },
  }).options;
  assert.ok(!o.some((x) => x.kind === "remind"));
  const fix = o.find((x) => x.kind === "fixPlannedTime")!;
  assert.equal(fix.target, "pdt:M|S|P");
});

test("arrival and chance texts: dates and tenths, no banned words", () => {
  const banned = /TabPFN|p10|p50|p80|p90|quantile|empirical|%/i;
  const s = arrivalSentence({
    basis: "grid",
    p10: "2025-12-03",
    p50: "2025-12-12",
    p90: "2025-12-28",
    requested: "2025-12-08",
    lateDays: 4,
  });
  assert.equal(
    s,
    "Expected around 12 Dec 2025, likely between 3 Dec 2025 and 28 Dec 2025, 4 days after the requested date.",
  );
  assert.match(
    arrivalSentence({
      basis: "none",
      p10: null,
      p50: null,
      p90: null,
      requested: null,
      lateDays: null,
    }),
    /No arrival estimate/,
  );
  assert.equal(chanceWords(0.71), "About 7 in 10");
  assert.equal(chanceWords(0.999), "About 9 in 10");
  assert.equal(chanceWords(null), "");
  for (const t of [s, chanceSentence(0.7)]) assert.doesNotMatch(t, banned);
});
