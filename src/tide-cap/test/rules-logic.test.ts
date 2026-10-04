// Pure rule logic (P-13): boundaries of each rule, working days, validation.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  addWorkingDays,
  confirmationActionRow,
  confirmationsFromRows,
  duplicateGroups,
  empiricalPriceDeviations,
  factorMatch,
  materialActivity,
  normaliseDescription,
  overdueItems,
  priceSlips,
  rareCombinations,
  validateConfirmation,
  workingDaysBetween,
  type PriceRow,
} from "../srv/cockpit/rules/domain";

const AS_OF = "2026-10-05"; // Monday

test("rare configuration review requests investigation without automatic corrections", async () => {
  const { rarePlannerAction } =
    await import("../srv/cockpit/rules/disposition-actions.js");
  const action = await rarePlannerAction(
    {
      ID: "rare:A",
      list: "rare",
      objectKey: "A|DE21",
      itemTitle: "Material A",
      issue: "Unique setting pair",
      Material: "A",
      Plant: "DE21",
      rareDetail: { firstPair: "MRPType + LotSizingProcedure" },
    },
    "app",
  );
  assert.equal(action.kind, "planner_review");
  assert.equal(action.requestType, "Configuration Review");
  assert.match(action.title, /^Configuration review:/);
  assert.ok(action.summary);
  assert.match(action.summary, /Rarity alone does not justify a change/);
  const item = action.items?.[0];
  assert.ok(item);
  assert.ok(item.data && typeof item.data === "object");
  assert.ok("automaticSettingChange" in item.data);
  assert.equal(item.data.automaticSettingChange, false);
  assert.ok("reviewOutcomes" in item.data);
  assert.deepEqual(item.data.reviewOutcomes, [
    "Keep settings with rationale",
    "Investigate missing evidence",
    "Propose specific corrections for separate approval",
  ]);
  assert.ok("Plant" in item.data);
  assert.equal(item.data.Plant, "DE21");
});

test("fuzzy duplicate search scores typos but preserves numeric and material-type boundaries", () => {
  const materials = [
    {
      Product: "A",
      ProductType: "ROH",
      ProductDescription: "Needle bearing ZZ 6278",
    },
    {
      Product: "B",
      ProductType: "ROH",
      ProductDescription: "Needle bearring ZZ 6278",
    },
    {
      Product: "C",
      ProductType: "ROH",
      ProductDescription: "Needle bearing ZZ 6279",
    },
    {
      Product: "D",
      ProductType: "ERSA",
      ProductDescription: "Needle bearing ZZ 6278",
    },
  ];
  const activity = materialActivity(
    materials.map((material) => ({
      Material: material.Product,
      Plant: "P1",
      date: "2026-09-01",
      kind: "po" as const,
    })),
    AS_OF,
  );
  const groups = duplicateGroups(materials, activity);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].members.map((member) => member.Product),
    ["A", "B"],
  );
  assert.equal(groups[0].members[0].similarityScore, 100);
  assert.ok(
    groups[0].members[1].similarityScore! >= 85 &&
      groups[0].members[1].similarityScore! < 100,
  );
});

describe("working days", () => {
  test("PO day counts, today not", () => {
    assert.equal(workingDaysBetween("2026-09-30", AS_OF), 3); // Wed Thu Fri
    assert.equal(workingDaysBetween("2026-10-01", AS_OF), 2); // Thu Fri
    assert.equal(workingDaysBetween("2026-10-03", AS_OF), 0); // Sat Sun
    assert.equal(workingDaysBetween(AS_OF, AS_OF), 0);
    assert.equal(workingDaysBetween("2026-09-28", AS_OF), 5);
  });
  test("due = PO date + 3 working days, weekend rolls forward", () => {
    assert.equal(addWorkingDays("2026-09-30", 3), "2026-10-05");
    assert.equal(addWorkingDays("2026-10-03", 3), "2026-10-08"); // Sat -> Mon + 3
    assert.equal(addWorkingDays("2026-09-28", 3), "2026-10-01");
  });
});

describe("overdue", () => {
  const item = (
    n: string,
    req: string | null,
    net = 100,
    rec = 0,
    open = 1,
  ) => ({
    PurchaseOrder: "45",
    PurchaseOrderItem: n,
    PurchaseOrderDate: "2026-06-01",
    RequestedDate: req,
    NetAmount: net,
    Currency: "EUR",
    ReceivedQuantity: rec,
    OpenQuantity: open,
  });
  test("visible after the due date, partial receipts remain actionable, sorted", () => {
    const out = overdueItems(
      [
        item("10", "2026-09-05"),
        item("20", "2026-09-04", 50),
        item("30", "2026-08-01", 10),
        item("40", "2026-09-04", 500),
        item("50", "2026-08-01", 999, 1),
        item("60", null),
      ],
      AS_OF,
    );
    assert.deepEqual(
      out.map((o) => o.row.PurchaseOrderItem),
      ["50", "30", "40", "20", "10"],
    );
    assert.equal(out[2].daysOverdue, 31);
    assert.equal(out[2].dueDate, "2026-09-04");
    assert.match(out[0].issue, /requested 65 days ago/);
    assert.match(out[0].issue, /Partially received/);
  });
});

describe("price", () => {
  test("factor bands ±15 % both directions", () => {
    assert.equal(factorMatch(100), 100);
    assert.equal(factorMatch(115), 100);
    assert.equal(factorMatch(85), 100);
    assert.equal(factorMatch(84.9), null);
    assert.equal(factorMatch(116), null);
    assert.equal(factorMatch(1 / 10), 10);
    assert.equal(factorMatch(1 / 1000), 1000);
    assert.equal(factorMatch(2), null);
    assert.equal(factorMatch(0), null);
  });
  const p = (
    po: string,
    date: string,
    amount: number,
    per = 1,
    material = "M1",
  ): PriceRow => ({
    PurchaseOrder: po,
    PurchaseOrderItem: "10",
    PurchaseOrderDate: date,
    Material: material,
    Plant: "1010",
    Currency: "EUR",
    NetPriceAmount: amount,
    NetPriceQuantity: per,
  });
  test("needs 3 earlier prices; window 30 days; per price unit; running median", () => {
    const rows = [
      p("1", "2026-01-01", 10),
      p("2", "2026-02-01", 20, 2),
      p("3", "2026-03-01", 12),
      p("4", "2026-09-10", 1000), // prior 10, 10, 12, 1000 (09-01) median 11 → ~91 × higher
      p("5", "2026-09-20", 0.12), // prior 10,10,12,1000,1000 median 12 → 100 × lower
      p("6", "2026-09-01", 1000), // before window (asOf - 30 = 09-05)
      p("7", AS_OF, 1000), // today not included
      p("8", "2026-09-10", 1000, 1, "M2"),
      p("9", "2026-01-01", 10, 1, "M2"), // only 1 prior
    ];
    const out = priceSlips(rows, AS_OF);
    assert.deepEqual(
      out.map((o) => o.row.PurchaseOrder),
      ["5", "4"],
    );
    const four = out[1];
    assert.equal(four.nPrior, 4); // "6" counts as an earlier price
    assert.equal(four.factor, 100);
    assert.equal(four.direction, "higher");
    assert.equal(four.issue, "Net price about 100 times higher than before");
    assert.equal(four.history.length, 4);
    assert.equal(out[0].direction, "lower");
  });
  test("exactly 3 prior prices fire; 2 do not", () => {
    const three = [
      p("1", "2026-01-01", 5),
      p("2", "2026-01-02", 5),
      p("3", "2026-01-03", 5),
      p("4", "2026-09-30", 50),
    ];
    assert.equal(priceSlips(three, AS_OF).length, 1);
    assert.equal(priceSlips(three.slice(1), AS_OF).length, 0);
  });
  test("realistic deviations require 20 comparable observations and exclude factor slips", () => {
    const history = Array.from({ length: 20 }, (_, index) =>
      p(
        String(index),
        `2026-09-${String(index + 1).padStart(2, "0")}`,
        98 + (index % 4),
      ),
    );
    const moderate = p("moderate", "2026-10-04", 160);
    const factor = p("factor", "2026-10-04", 1000, 1, "M2");
    const factorHistory = history.map((row, index) => ({
      ...row,
      PurchaseOrder: `f${index}`,
      Material: "M2",
    }));

    assert.deepEqual(
      empiricalPriceDeviations(
        [...history, moderate, ...factorHistory, factor],
        AS_OF,
      ).map((result) => result.row.PurchaseOrder),
      ["moderate"],
    );
    assert.equal(
      empiricalPriceDeviations([...history.slice(1), moderate], AS_OF).length,
      0,
    );
  });
  test("no prices → empty", () => assert.deepEqual(priceSlips([], AS_OF), []));
});

describe("duplicates", () => {
  test("normalise", () => {
    assert.equal(
      normaliseDescription("  Bearing-6204 / ZZ "),
      "bearing 6204 zz",
    );
    assert.equal(normaliseDescription(null), "");
  });
  test("active materials only, within type, ranked by 12-month activity", () => {
    const act = materialActivity(
      [
        { Material: "A", Plant: "1010", date: "2026-09-01", kind: "po" },
        { Material: "B", Plant: "1010", date: "2025-01-01", kind: "movement" }, // active, not recent
        { Material: "C", Plant: "1010", date: "2024-10-04", kind: "po" }, // older than 24 months → inactive
        { Material: "D", Plant: "2010", date: "2026-09-01", kind: "po" },
        { Material: "D", Plant: "2010", date: "2026-09-02", kind: "movement" },
        { Material: "E", Plant: "2010", date: "2026-09-01", kind: "po" },
        { Material: "F", Plant: "1010", date: "2026-09-01", kind: "po" },
        { Material: "X", Plant: "1010", date: AS_OF, kind: "po" }, // today not counted
      ],
      AS_OF,
    );
    assert.equal(act.get("A")!.recentPOs, 1);
    assert.equal(act.get("B")!.recentMovements, 0);
    assert.ok(!act.has("C") && !act.has("X"));
    const groups = duplicateGroups(
      [
        {
          Product: "A",
          ProductType: "ROH",
          ProductDescription: "Bearing 6204",
        },
        {
          Product: "B",
          ProductType: "ROH",
          ProductDescription: "BEARING-6204",
        },
        {
          Product: "C",
          ProductType: "ROH",
          ProductDescription: "bearing 6204",
        },
        { Product: "D", ProductType: "HAWA", ProductDescription: "Screw M8" },
        { Product: "E", ProductType: "HAWA", ProductDescription: "screw  m8" },
        {
          Product: "F",
          ProductType: "HAWA",
          ProductDescription: "Bearing 6204",
        }, // other type
      ],
      act,
    );
    assert.equal(groups.length, 2);
    assert.deepEqual(
      groups[0].members.map((m) => m.Product),
      ["D", "E"],
    );
    assert.equal(groups[0].activity, 3);
    assert.equal(groups[0].rank, 1);
    assert.equal(groups[0].mainPlant, "2010");
    assert.deepEqual(
      groups[1].members.map((m) => m.Product),
      ["A", "B"],
    );
    assert.match(groups[1].issue, /2 active materials share/);
  });
});

describe("rare combinations", () => {
  const r = (
    Product: string,
    MRPType: string,
    LotSizingProcedure: string,
    Plant = "1010",
    ProductType = "ROH",
  ) => ({
    Product,
    Plant,
    ProductType,
    ProcurementType: "F",
    ProcurementSubType: "",
    MRPType,
    LotSizingProcedure,
    MRPResponsible: "001",
  });
  test("pair occurring once within type and plant; blank counts; other plant separate", () => {
    const out = rareCombinations([
      r("A", "PD", "EX"),
      r("B", "PD", "EX"),
      r("C", "PD", "EX"),
      r("D", "VB", "EX"),
      r("E", "VB", "HB", "2010"), // single in its cell → not compared
    ]);
    assert.deepEqual(
      out.map((x) => x.Product),
      ["D"],
    );
    const d = out[0];
    assert.ok(
      d.pairs.some(
        (p) =>
          p.a === "ProcurementType" &&
          p.b === "MRPType" &&
          p.countB === 1 &&
          p.countA === 4,
      ),
    );
    assert.ok(
      d.pairs.some((p) => p.a === "ProcurementSubType" && p.valueA === ""),
    );
    assert.match(d.issue, /^Only material in this plant with /);
  });
});

describe("enter confirmation validation", () => {
  const t = {
    exists: true,
    open: true,
    openQuantity: 10,
    PurchaseOrderDate: "2026-09-01",
  };
  test("valid", () =>
    assert.equal(validateConfirmation(t, "2026-09-01", 10), null));
  test("refusals", () => {
    assert.match(
      validateConfirmation({ ...t, exists: false }, "2026-09-10", 1)!,
      /does not exist/,
    );
    assert.match(
      validateConfirmation({ ...t, open: false }, "2026-09-10", 1)!,
      /no longer open/,
    );
    assert.match(validateConfirmation(t, "2026-09-10", 0)!, /greater than 0/);
    assert.match(
      validateConfirmation(t, "2026-09-10", 10.5)!,
      /more than the open quantity/,
    );
    assert.match(
      validateConfirmation(t, "2026-08-31", 1)!,
      /before the PO date/,
    );
    assert.match(validateConfirmation(t, "", 1)!, /date/);
  });
  test("action row", () =>
    assert.deepEqual(
      confirmationActionRow("45", "10", "2026-10-10", 5, AS_OF),
      {
        PurchaseOrder: "45",
        PurchaseOrderItem: "10",
        ConfirmationCategory: "AB",
        DeliveryDate: "2026-10-10",
        Quantity: 5,
        ReceivedOn: AS_OF,
      },
    ));
});

describe("SAP confirmation rows", () => {
  test("header / item / line joined; flat rows; rejected and undated skipped", async () => {
    const out = confirmationsFromRows({
      SupplierConfirmation: [
        { SupplierConfirmation: "C1", CreationDate: "2026-09-30" },
      ],
      SupplierConfirmationItem: [
        {
          SupplierConfirmation: "C1",
          SupplierConfirmationItem: "00010",
          SuplrConfRefPurchaseOrder: "45",
          SuplrConfRefPurchaseOrderItem: "00010",
        },
        {
          SupplierConfirmation: "C1",
          SupplierConfirmationItem: "00020",
          SuplrConfRefPurchaseOrder: "45",
          SuplrConfRefPurchaseOrderItem: "20",
          ItemIsRejectedBySupplier: true,
        },
      ],
      SupplierConfirmationLine: [
        {
          SupplierConfirmation: "C1",
          SupplierConfirmationItem: "10",
          SupplierConfirmationLine: "1",
          DeliveryDate: "2026-10-12",
          ConfirmedQuantity: 5,
        },
        {
          SupplierConfirmation: "C1",
          SupplierConfirmationItem: "20",
          SupplierConfirmationLine: "1",
          DeliveryDate: "2026-10-12",
          ConfirmedQuantity: 5,
        },
        {
          SupplierConfirmation: "C1",
          SupplierConfirmationItem: "10",
          SupplierConfirmationLine: "2",
          DeliveryDate: null,
        },
      ],
      Flat: [
        {
          PurchaseOrder: "46",
          PurchaseOrderItem: "10",
          date: "2026-10-01",
          quantity: "3",
        },
      ],
    });
    assert.deepEqual(out, [
      {
        PurchaseOrder: "45",
        PurchaseOrderItem: "10",
        date: "2026-10-12",
        quantity: 5,
        createdOn: "2026-09-30",
      },
      {
        PurchaseOrder: "46",
        PurchaseOrderItem: "10",
        date: "2026-10-01",
        quantity: 3,
        createdOn: null,
      },
    ]);
  });
});
