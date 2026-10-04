// P-8 core (pure, no CDS): request form, filters, labels, plan, gate, ranking.
//   node --import tsx --test test/chat-predict-logic.test.ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  FormError,
  NEW_ORDER,
  OUTCOME_COLUMNS,
  PREDICT_FEATURES,
  REFUSAL,
  TOO_LITTLE,
  addDays,
  features,
  gate,
  knownValues,
  label,
  ownPastDeliveries,
  parseRequest,
  plan,
  rank,
  resolveFilters,
  sampleIndices,
  type Item,
} from "../srv/cockpit/predict-logic";

const AS_OF = "2026-10-05";
let seq = 0;
function item(o: Partial<Item> = {}): Item {
  seq++;
  const PurchaseOrder = o.PurchaseOrder ?? String(4500000000 + seq);
  return {
    id: `${PurchaseOrder}/10`,
    PurchaseOrder,
    PurchaseOrderItem: "10",
    Material: "M1",
    Supplier: "S1",
    Plant: "P1",
    PurchasingGroup: "001",
    MaterialType: "ROH",
    MaterialGroup: "G1",
    SupplierCountry: "DE",
    PlannedDays: 20,
    OrderQuantity: 5,
    NetAmountEUR: 100,
    PurchaseOrderDate: "2026-03-01",
    RequestedDate: "2026-03-31",
    AvailableDate: null,
    PartialFirstReceipt: false,
    IsOpen: true,
    ...o,
  };
}

const throws400 = (fn: () => unknown, re: RegExp) =>
  assert.throws(
    fn,
    (e: any) =>
      e instanceof FormError && e.status === 400 && re.test(e.message),
  );

describe("request form (strict)", () => {
  test("material-scoped late requests exclude rows without requested dates", () => {
    const req = parseRequest({
      target: "late_by_days",
      lateDays: 1,
      filters: { material: "M1", plant: "P1" },
    });
    assert.equal(req.filters.material, "M1");
    const result = plan(
      [
        item({ RequestedDate: null }),
        item({ RequestedDate: "2026-10-20" }),
        item({ Material: "M2", RequestedDate: "2026-10-20" }),
      ],
      req,
      req.filters,
      AS_OF,
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].Material, "M1");
    assert.ok(result.rows[0].RequestedDate);
  });

  test("accepts the three targets with their parameters", () => {
    assert.deepEqual(parseRequest({ target: "late_by_days", lateDays: 7 }), {
      target: "late_by_days",
      lateDays: 7,
      key: null,
      filters: {},
    });
    const lt = parseRequest({
      target: "lead_time_days",
      key: { material: "M1", supplier: "S1", plant: "P1" },
    });
    assert.deepEqual(lt.key, { material: "M1", supplier: "S1", plant: "P1" });
    assert.equal(
      parseRequest({
        target: "partial_delivery",
        filters: { supplierRegion: "eu" },
      }).filters.supplierRegion,
      "eu",
    );
  });

  test("rejects unknown targets, bad thresholds, extra fields and misplaced keys", () => {
    throws400(
      () => parseRequest({ target: "price" }),
      /target: must be one of/,
    );
    throws400(
      () => parseRequest({ target: "late_by_days" }),
      /lateDays is required/,
    );
    throws400(
      () => parseRequest({ target: "late_by_days", lateDays: 61 }),
      /1 to 60/,
    );
    throws400(
      () => parseRequest({ target: "late_by_days", lateDays: 0 }),
      /1 to 60/,
    );
    throws400(
      () => parseRequest({ target: "partial_delivery", lateDays: 3 }),
      /only allowed there/,
    );
    throws400(
      () => parseRequest({ target: "partial_delivery", horizon: 3 }),
      /extra fields/,
    );
    throws400(
      () =>
        parseRequest({
          target: "partial_delivery",
          filters: { country: "DE" },
        }),
      /filters.country: extra/,
    );
    throws400(
      () =>
        parseRequest({
          target: "partial_delivery",
          filters: { supplierRegion: "asia" },
        }),
      /supplierRegion/,
    );
    throws400(
      () =>
        parseRequest({
          target: "partial_delivery",
          filters: { poDateFrom: "03/01/2026" },
        }),
      /date/,
    );
    throws400(
      () =>
        parseRequest({
          target: "late_by_days",
          lateDays: 5,
          key: { material: "M", supplier: "S", plant: "P" },
        }),
      /only allowed for lead_time_days/,
    );
  });

  test("resolves the buyer, applies the scope only without plant or group, checks every value", () => {
    const known = knownValues(
      [item(), item({ Plant: "P2", PurchasingGroup: "002" })],
      AS_OF,
    );
    const scope = { plant: "P1", purchasingGroup: "001" };
    const r = (filters: object) =>
      parseRequest({ target: "partial_delivery", filters });
    assert.deepEqual(resolveFilters(r({}), known, scope, []), {
      plant: "P1",
      purchasingGroup: "001",
    });
    // A named plant does not get the buyer's purchasing group.
    assert.deepEqual(resolveFilters(r({ plant: "P2" }), known, scope, []), {
      plant: "P2",
    });
    assert.deepEqual(
      resolveFilters(r({ buyer: "Bob" }), known, {}, [
        {
          userId: "buyer002",
          name: "Bob",
          Plant: "P2",
          PurchasingGroup: "002",
        },
      ]),
      { plant: "P2", purchasingGroup: "002" },
    );
    throws400(
      () => resolveFilters(r({ supplier: "S9" }), known, {}, []),
      /unknown supplier S9/,
    );
    throws400(
      () => resolveFilters(r({ plant: "P9" }), known, {}, []),
      /unknown plant P9/,
    );
    throws400(
      () => resolveFilters(r({ buyer: "nobody" }), known, {}, []),
      /unknown buyer nobody/,
    );
    throws400(
      () =>
        resolveFilters(
          r({ poDateFrom: "2026-05-01", poDateTo: "2026-04-01" }),
          known,
          {},
          [],
        ),
      /after/,
    );
  });
});

describe("features and labels", () => {
  test("uncomparable first receipt is not a negative partial-delivery label", () => {
    const req = { target: "partial_delivery" as const, lateDays: null };
    const received = item({
      AvailableDate: "2026-03-20",
      PartialFirstReceipt: null,
    });
    assert.equal(label(received, req, AS_OF), null);
    assert.equal(
      label({ ...received, PartialFirstReceipt: true }, req, AS_OF),
      1,
    );
    assert.equal(
      label({ ...received, PartialFirstReceipt: false }, req, AS_OF),
      0,
    );
  });

  test("13 features, none of them an outcome column", () => {
    assert.equal(PREDICT_FEATURES.length, 13);
    for (const c of OUTCOME_COLUMNS)
      assert.ok(!(PREDICT_FEATURES as readonly string[]).includes(c), c);
    const i = item({
      SupplierCountry: "PL",
      PlannedDays: 2,
      PurchaseOrderDate: "2026-03-01",
      RequestedDate: "2026-03-11",
    });
    const f = features(i, 3);
    assert.deepEqual(Object.keys(f), [...PREDICT_FEATURES]);
    assert.equal(f.SupplierRegion, "eu");
    assert.equal(f.PlannedStatus, "default");
    assert.equal(f.RequestedGapDays, 10);
    assert.equal(f.POMonth, "3");
    assert.equal(f.OwnPastDeliveries, 3);
  });

  test("own past deliveries count receipts of the key before the PO date", () => {
    const a = item({
      PurchaseOrderDate: "2026-01-01",
      AvailableDate: "2026-01-20",
    });
    const b = item({
      PurchaseOrderDate: "2026-02-01",
      AvailableDate: "2026-03-01",
    });
    const c = item({ PurchaseOrderDate: "2026-03-02" });
    const other = item({
      Supplier: "S2",
      PurchaseOrderDate: "2025-12-01",
      AvailableDate: "2025-12-10",
    });
    const past = ownPastDeliveries([a, b, c, other]);
    assert.deepEqual(
      [past.get(a.id), past.get(b.id), past.get(c.id)],
      [0, 1, 2],
    );
  });

  test("late by N is known with a receipt, or without one once N days have passed", () => {
    const req = { target: "late_by_days" as const, lateDays: 7 };
    const i = item({
      RequestedDate: "2026-09-01",
      AvailableDate: "2026-09-10",
    });
    assert.equal(label(i, req, AS_OF), 1);
    assert.equal(label(i, req, "2026-09-05"), null); // receipt not yet, 4 days late
    assert.equal(label(i, req, "2026-09-09"), 1); // no receipt yet, 8 days late
    assert.equal(
      label(
        item({ RequestedDate: "2026-09-01", AvailableDate: "2026-09-05" }),
        req,
        AS_OF,
      ),
      0,
    );
    const lt = { target: "lead_time_days" as const, lateDays: null };
    assert.equal(
      label(
        item({ PurchaseOrderDate: "2026-09-01", AvailableDate: "2026-09-21" }),
        lt,
        AS_OF,
      ),
      20,
    );
    assert.equal(label(item({ AvailableDate: null }), lt, AS_OF), null);
    const pd = { target: "partial_delivery" as const, lateDays: null };
    assert.equal(
      label(
        item({ AvailableDate: "2026-09-01", PartialFirstReceipt: true }),
        pd,
        AS_OF,
      ),
      1,
    );
  });
});

/** Late-by-7 history in plant P1: supplier SBAD late, SGOOD on time. */
function history(): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < 120; i++) {
    const bad = i % 2 === 0;
    const ordered = addDays("2026-01-01", i);
    out.push(
      item({
        Supplier: bad ? "SBAD" : "SGOOD",
        PurchaseOrderDate: ordered,
        RequestedDate: addDays(ordered, 30),
        AvailableDate: addDays(ordered, bad ? 45 : 28),
        IsOpen: false,
      }),
    );
  }
  // Ordered before the cutoff (2026-08-10), requested + 7 in [cutoff, as-of], received after the cutoff.
  for (let i = 0; i < 40; i++) {
    const bad = i % 2 === 0;
    const requested = addDays("2026-08-10", i % 45);
    out.push(
      item({
        Supplier: bad ? "SBAD" : "SGOOD",
        PurchaseOrderDate: addDays(requested, -40),
        RequestedDate: requested,
        AvailableDate: addDays(requested, bad ? 12 : 1),
        IsOpen: false,
      }),
    );
  }
  return out;
}

describe("plan and gate", () => {
  test("context, evaluated items, open rows, already late and the widening note", () => {
    const open = [
      item({
        Supplier: "SBAD",
        PurchaseOrderDate: "2026-09-20",
        RequestedDate: "2026-10-20",
      }),
      item({
        Supplier: "SGOOD",
        PurchaseOrderDate: "2026-09-21",
        RequestedDate: "2026-10-10",
      }),
      item({
        Supplier: "SGOOD",
        PurchaseOrderDate: "2026-08-01",
        RequestedDate: "2026-09-01",
      }), // already > 7 late
    ];
    const items = [...history(), ...open];
    const req = parseRequest({ target: "late_by_days", lateDays: 7 });
    const p = plan(items, req, { plant: "P1" }, AS_OF);
    assert.equal(p.cutoff, "2026-08-10");
    // 40 history items plus the open one that became known-late after the cutoff.
    assert.equal(p.evaluated.length, 41);
    assert.equal(p.evaluated.filter((e) => e.y === 1).length, 21);
    assert.equal(p.alreadyLate, 1);
    assert.deepEqual(
      p.rows.map((r) => r.RequestedDate),
      ["2026-10-10", "2026-10-20"],
    );
    assert.ok(p.context.length >= 100);
    assert.deepEqual(p.notes, []);
    // Organisational filters restrict only the scored rows; a small content scope widens to the plant.
    const narrow = plan(items, req, { plant: "P1", supplier: "SBAD" }, AS_OF);
    assert.match(narrow.notes[0], /context widened to plant P1/);
    assert.ok(narrow.rows.every((r) => r.Supplier === "SBAD"));
  });

  test("a key without open items gets one (new order) row from its latest PO", () => {
    const items = history();
    const req = parseRequest({
      target: "lead_time_days",
      key: { material: "M1", supplier: "SGOOD", plant: "P1" },
    });
    const p = plan(
      items,
      req,
      { plant: "P1", supplier: "SGOOD", material: "M1" },
      AS_OF,
    );
    assert.equal(p.newOrder, true);
    assert.equal(p.rows.length, 1);
    assert.equal(p.rows[0].PurchaseOrder, NEW_ORDER);
    assert.equal(p.rows[0].PurchaseOrderDate, AS_OF);
  });

  test("classification gate: pass needs top-10 hits above the base rate and AUC >= 0.60", () => {
    const req = parseRequest({ target: "late_by_days", lateDays: 7 });
    const p = plan(history(), req, { plant: "P1" }, AS_OF);
    const perfect = p.evaluated.map((e) => [
      e.item.Supplier === "SBAD" ? 0.9 : 0.1,
    ]);
    const g = gate(req, p.evaluated, p.backtestContext, perfect);
    assert.equal(g.verdict, "pass");
    assert.equal(g.topPositive, 10);
    assert.equal(
      g.summary,
      "Reality check: had I asked this 8 weeks ago, 10 of my top 10 would have been late (normally 5 of 10)",
    );
    const flat = gate(
      req,
      p.evaluated,
      p.backtestContext,
      p.evaluated.map(() => [0.5]),
    );
    assert.equal(flat.verdict, "fail");
    const little = gate(req, p.evaluated.slice(0, 20), p.backtestContext, null);
    assert.equal(little.verdict, "too little");
    assert.equal(little.summary, TOO_LITTLE);
    assert.match(REFUSAL, /^I can't predict this reliably: /);
  });

  test("lead time gate compares the typical miss with the usual duration", () => {
    const req = parseRequest({ target: "lead_time_days" });
    const ev = Array.from({ length: 30 }, (_, i) => ({
      item: item(),
      y: i % 2 ? 40 : 20,
    }));
    const ctx = ev.map((e) => ({ ...e, y: 30 }));
    const good = gate(
      req,
      ev,
      ctx,
      ev.map((e) => [e.y - 5, e.y, e.y + 5]),
    );
    assert.equal(good.verdict, "pass");
    assert.equal(good.withinRange, 30);
    assert.match(
      good.summary,
      /typical miss was 0\.0 days, against 10\.0 days for the usual duration; 30 of 30/,
    );
    assert.equal(
      gate(
        req,
        ev,
        ctx,
        ev.map(() => [0, 30, 60]),
      ).verdict,
      "fail",
    );
  });

  test("ranking keeps the top 20 in score order with ranks, lead time by the middle value", () => {
    const rows = Array.from({ length: 25 }, () => item());
    const ranked = rank(
      rows,
      rows.map((_, i) => [i / 100]),
      parseRequest({ target: "partial_delivery" }),
    );
    assert.equal(ranked.length, 20);
    assert.equal(ranked[0].item.id, rows[24].id);
    assert.equal(ranked[0].rank, 1);
    const lt = rank(
      rows.slice(0, 2),
      [
        [1, 10, 20],
        [2, 30, 40],
      ],
      parseRequest({ target: "lead_time_days" }),
    );
    assert.deepEqual(
      lt.map((r) => [r.p10Days, r.p50Days, r.p90Days, r.score]),
      [
        [2, 30, 40, null],
        [1, 10, 20, null],
      ],
    );
  });

  test("the reality-check sample is reproducible", () => {
    assert.deepEqual(sampleIndices(1000, 300), sampleIndices(1000, 300));
    assert.equal(sampleIndices(1000, 300).length, 300);
    assert.deepEqual(sampleIndices(5, 300), [0, 1, 2, 3, 4]);
  });
});
