// Pure free-text logic (P-14): segments, allowed codes, statuses, Wilson
// thresholds, threshold simulator, TF-IDF similarity, routing, code list CSV.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  allowedCodes,
  atThreshold,
  BLANK_CATEGORY,
  charWbNgrams,
  codeListRows,
  contextSample,
  cosine,
  fitTfidf,
  type FreetextItem,
  inboxDay,
  proposalFrom,
  proposalWords,
  quota,
  restrictToAllowed,
  route,
  routingTable,
  sameValueText,
  seededSample,
  segmentContext,
  segmentOf,
  segmentSets,
  segmentsOf,
  SIM_GRID,
  similarItems,
  splitHoldout,
  status,
  thresholdCurve,
  thresholdWilson,
  transform,
  wilsonInterval,
  wilsonLower,
} from "../srv/cockpit/freetext/domain/logic";
import {
  calibrate,
  columnsFor,
  plan,
  propose,
  thresholdInfo,
} from "../srv/cockpit/freetext/engine";

function item(i: number, over: Partial<FreetextItem> = {}): FreetextItem {
  return {
    PurchaseRequisition: `1${String(i).padStart(7, "0")}`,
    PurchaseRequisitionItem: "00010",
    text: `item ${i}`,
    Plant: "P1",
    PurchasingOrganization: "O1",
    PurchaseOrderType: "FO",
    date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    MaterialGroup: "MG1",
    PurchasingGroup: "G1",
    Supplier: "S1",
    ...over,
  };
}

const THR = { threshold: 0.8, accuracyAtThreshold: 0.963, valid: true };

test("material and info-record suggestions remain review-only and use purchasing scope", () => {
  assert.equal(status("Material", 0.999, THR), "never_automatic");
  assert.equal(status("PurchasingInfoRecord", 0.999, THR), "never_automatic");
  const history = [
    item(1, { Material: "M1", PurchasingInfoRecord: "IR1" }),
    item(2, {
      Plant: "P2",
      PurchasingOrganization: "O2",
      Material: "M2",
      PurchasingInfoRecord: "IR2",
    }),
  ];
  assert.deepEqual([...allowedCodes(history, "Material", item(3))!], ["M1"]);
  assert.deepEqual(
    [...allowedCodes(history, "PurchasingInfoRecord", item(3))!],
    ["IR1"],
  );
});

describe("segments", () => {
  const rows = [
    ...Array.from({ length: 1000 }, (_, i) =>
      item(i, { Plant: "BIG", PurchasingOrganization: "O1" }),
    ),
    ...Array.from({ length: 600 }, (_, i) =>
      item(2000 + i, { Plant: "A", PurchasingOrganization: "O2" }),
    ),
    ...Array.from({ length: 500 }, (_, i) =>
      item(3000 + i, { Plant: "B", PurchasingOrganization: "O2" }),
    ),
    ...Array.from({ length: 999 }, (_, i) =>
      item(4000 + i, { Plant: "C", PurchasingOrganization: "O3" }),
    ),
    item(9999, { Plant: "BIG", PurchasingGroup: null }),
  ];
  const sets = segmentSets(rows, "PurchasingGroup");

  test("plant with ≥ 1,000 rows, else purchasing organisation with ≥ 1,000, else global", () => {
    assert.deepEqual([...sets.plants], ["BIG"]);
    assert.deepEqual([...sets.orgs], ["O2"]);
    assert.equal(segmentOf(sets, "BIG", "O1"), "plant:BIG");
    assert.equal(segmentOf(sets, "A", "O2"), "org:O2");
    assert.equal(segmentOf(sets, "C", "O3"), "global");
    assert.equal(segmentOf(sets, "NEW", "O2"), "org:O2");
    assert.deepEqual(segmentsOf(sets), ["plant:BIG", "org:O2", "global"]);
  });

  test("rows without the field do not count toward a segment", () => {
    const s = segmentSets(
      rows
        .slice(0, 1000)
        .map((r, i) => (i === 0 ? { ...r, MaterialGroup: "" } : r)),
      "MaterialGroup",
    );
    assert.equal(s.plants.size, 0);
  });

  test("context: seeded sample of 250 from the segment, reproducible", () => {
    const a = segmentContext(rows, sets, "org:O2", "PurchasingGroup");
    const b = segmentContext(
      [...rows].reverse(),
      sets,
      "org:O2",
      "PurchasingGroup",
    );
    assert.equal(a.nSegment, 1100);
    assert.equal(a.context.length, 250);
    assert.ok(a.context.every((r) => r.PurchasingOrganization === "O2"));
    assert.deepEqual(
      new Set(a.context.map((r) => r.PurchaseRequisition)),
      new Set(b.context.map((r) => r.PurchaseRequisition)),
    );
  });

  test("context keeps only the 160 most frequent codes", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      item(i, { MaterialGroup: `MG${i < 40 ? 0 : i}` }),
    );
    const ctx = contextSample(many, "MaterialGroup");
    assert.equal(new Set(ctx.map((r) => r.MaterialGroup)).size, 160);
    assert.ok(ctx.some((r) => r.MaterialGroup === "MG0"));
  });

  test("seeded sample returns rows in input order", () => {
    const rs = Array.from({ length: 20 }, (_, i) => item(i));
    const s = seededSample(rs, 5, (r) => r.PurchaseRequisition);
    assert.equal(s.length, 5);
    assert.deepEqual(
      s,
      [...s].sort((a, b) =>
        a.PurchaseRequisition.localeCompare(b.PurchaseRequisition),
      ),
    );
  });
});

describe("allowed codes", () => {
  const rows = [
    item(1, {
      Plant: "P1",
      PurchasingGroup: "G1",
      Supplier: "S1",
      PurchasingOrganization: "O1",
    }),
    item(2, {
      Plant: "P1",
      PurchasingGroup: "G2",
      Supplier: "S2",
      PurchasingOrganization: "O1",
    }),
    item(3, {
      Plant: "P2",
      PurchasingGroup: "G3",
      Supplier: "S3",
      PurchasingOrganization: "O2",
    }),
  ];

  test("purchasing group seen in the plant, supplier in the purchasing organisation, material group unrestricted", () => {
    assert.deepEqual(
      allowedCodes(rows, "PurchasingGroup", {
        Plant: "P1",
        PurchasingOrganization: "O2",
      }),
      new Set(["G1", "G2"]),
    );
    assert.deepEqual(
      allowedCodes(rows, "Supplier", {
        Plant: "P1",
        PurchasingOrganization: "O2",
      }),
      new Set(["S3"]),
    );
    assert.equal(
      allowedCodes(rows, "MaterialGroup", {
        Plant: "P1",
        PurchasingOrganization: "O1",
      }),
      null,
    );
  });

  test("other codes are zeroed without renormalising", () => {
    const p = restrictToAllowed(
      ["G1", "G2", "G3"],
      [0.2, 0.3, 0.5],
      new Set(["G1", "G2"]),
    );
    assert.deepEqual(p, [0.2, 0.3, 0]);
    assert.equal(restrictToAllowed(["G3"], [1], new Set(["G1"])), null);
    const prop = proposalFrom(
      "PurchasingGroup",
      ["G1", "G2", "G3"],
      [0.2, 0.3, 0.5],
      new Set(["G1", "G2"]),
      THR,
      "global",
      "tabpfn",
    );
    assert.equal(prop.value, "G2");
    assert.equal(prop.confidence, 0.3);
    assert.equal(prop.status, "review");
    assert.deepEqual(
      prop.alternatives.map((a) => a.value),
      ["G2", "G1"],
    );
  });

  test("nothing allowed → no value, reason", () => {
    const prop = proposalFrom(
      "PurchasingGroup",
      ["G3"],
      [1],
      new Set(["G1"]),
      THR,
      "global",
      "tabpfn",
    );
    assert.equal(prop.value, null);
    assert.match(prop.reason!, /no candidate code/);
  });
});

describe("statuses", () => {
  test("TabPFN suggestions remain visible and review-only regardless of confidence or calibration", () => {
    for (const confidence of [0, 0.0000001, 0.5, 0.999999, null]) {
      assert.equal(status("PurchasingGroup", confidence, THR), "review");
      assert.equal(status("PurchasingGroup", confidence, null), "review");
      assert.equal(
        status("AccountAssignmentCategory", confidence, null),
        "never_automatic",
      );
    }
    const proposal = proposalFrom(
      "PurchasingGroup",
      ["A01", "A02"],
      [0.0000001, 0.00000001],
      null,
      THR,
      "global",
      "tabpfn",
    );
    assert.equal(proposal.value, "A01");
    assert.equal(proposal.confidence, 0.0000001);
    assert.equal(proposal.alternatives[1].probability, 0.00000001);
    assert.equal(proposal.status, "review");
  });
  test("material group and supplier remain review-only even when calibrated", () => {
    assert.equal(status("MaterialGroup", 0.99, THR), "review");
    assert.equal(status("Supplier", 0.99, THR), "review");
  });
  test("purchasing group is review-only on either side of a stored threshold", () => {
    assert.equal(status("PurchasingGroup", 0.8, THR), "review");
    assert.equal(status("PurchasingGroup", 0.79, THR), "review");
  });
  test("missing or invalid calibration does not gate suggestions", () => {
    assert.equal(status("PurchasingGroup", 0.99, null), "review");
    assert.equal(
      status("PurchasingGroup", 0.99, { ...THR, valid: false }),
      "review",
    );
    assert.equal(
      status("PurchasingGroup", 0.99, { ...THR, threshold: null }),
      "review",
    );
  });
  test("a fallback answer is never prefilled", () => {
    assert.equal(
      proposalFrom(
        "PurchasingGroup",
        ["G1"],
        [0.99],
        null,
        THR,
        "global",
        "fallback",
      ).status,
      "review",
    );
  });
  test("category suggestions are always review-only and preserve a legitimate blank label", () => {
    const category = proposalFrom(
      "AccountAssignmentCategory",
      [BLANK_CATEGORY, "K"],
      [0.99, 0.01],
      null,
      THR,
      "global",
      "tabpfn",
    );
    assert.equal(category.value, BLANK_CATEGORY);
    assert.equal(category.status, "never_automatic");
  });
  test("raw model scores are not represented as historical reliability", () => {
    const p = proposalFrom(
      "PurchasingGroup",
      ["G1", "G2"],
      [0.9, 0.1],
      null,
      THR,
      "global",
      "tabpfn",
    );
    assert.equal(p.rightOf100, null);
    assert.equal(proposalWords(p), "AI suggestion, please check");
    assert.equal(
      proposalWords({ value: "MG1", status: "prefilled" }),
      "AI is sure enough to pre-fill",
    );
    assert.equal(
      proposalWords({ value: "G1", status: "review" }),
      "AI suggestion, please check",
    );
    assert.equal(
      proposalWords({ value: null, status: "review" }),
      "no suggestion",
    );
  });
});

describe("Wilson threshold", () => {
  test("lower bound", () => {
    assert.ok(Math.abs(wilsonLower(95, 100) - 0.9008333016216962) < 1e-12);
    assert.ok(Math.abs(wilsonLower(50, 50) - 0.9486581467678504) < 1e-12);
    const [lo, hi] = wilsonInterval(90, 100);
    assert.ok(lo! < 0.9 && hi! > 0.9);
    assert.deepEqual(wilsonInterval(0, 0), [null, null]);
  });

  test("lowest confidence reaching 0.95 on the one-sided bound (same as the reference)", () => {
    const conf = Array.from({ length: 400 }, (_, i) => i / 400);
    const correct = conf.map((c, i) => (c >= 0.5 || i % 3 === 0 ? 1 : 0));
    assert.equal(thresholdWilson(conf, correct, 0.95), 0.48);
  });

  test("needs ≥ 50 accepted rows; ties are accepted together", () => {
    assert.equal(
      thresholdWilson(Array(49).fill(0.9), Array(49).fill(1), 0.9),
      null,
    );
    assert.equal(
      thresholdWilson(Array(200).fill(0.9), Array(200).fill(1), 0.95),
      0.9,
    );
    const conf = [...Array(100).fill(0.9), ...Array(100).fill(0.5)];
    const correct = [
      ...Array(100).fill(1),
      ...Array(50).fill(1),
      ...Array(50).fill(0),
    ];
    assert.equal(thresholdWilson(conf, correct, 0.95), 0.9);
  });

  test("holdout = youngest 30 %, max 1,000, min 50; train sample 250", () => {
    assert.equal(
      splitHoldout(Array.from({ length: 166 }, (_, i) => item(i))),
      null,
    );
    const rows = Array.from({ length: 1000 }, (_, i) =>
      item(i, { date: `2025-${String((i % 12) + 1).padStart(2, "0")}-01` }),
    );
    const s = splitHoldout(rows)!;
    assert.equal(s.holdout.length, 300);
    assert.equal(s.train.length, 250);
    const youngestTrain = s.train
      .map((r) => r.date)
      .sort()
      .at(-1)!;
    assert.ok(youngestTrain <= s.holdout.map((r) => r.date).sort()[0]);
    assert.equal(
      splitHoldout(Array.from({ length: 5000 }, (_, i) => item(i)))!.holdout
        .length,
      1000,
    );
  });

  test("training labels must exist before the first holdout prediction date", () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      item(i, {
        date: `2025-${String(Math.floor(i / 20) + 1).padStart(2, "0")}-01`,
        labelDate: i < 130 ? "2025-06-01" : "2026-01-01",
      }),
    );
    const split = splitHoldout(rows)!;
    const firstPrediction = split.holdout.map((row) => row.date).sort()[0];
    assert.ok(
      split.train.every((row) => (row.labelDate ?? row.date) < firstPrediction),
    );
  });

  test("simulator grid 0.30–1.00 step 0.01 with share, accuracy and two-sided interval", () => {
    assert.equal(SIM_GRID.length, 71);
    assert.equal(SIM_GRID[0], 0.3);
    assert.equal(SIM_GRID.at(-1), 1);
    const conf = [0.2, 0.5, 0.6, 0.9];
    const correct = [0, 1, 0, 1];
    assert.deepEqual(atThreshold(conf, correct, 0.5), {
      threshold: 0.5,
      prefilledShare: 0.75,
      accuracy: 0.6667,
      low: 0.2077,
      high: 0.9385,
      n: 3,
    });
    const curve = thresholdCurve(conf, correct, 0.555);
    assert.equal(curve.filter((r) => r.isStored).length, 1);
    assert.equal(curve.find((r) => r.isStored)!.threshold, 0.56);
    assert.equal(curve.at(-1)!.accuracy, null);
  });
});

describe("similar requests (TF-IDF)", () => {
  const texts = [
    "Bearing 6204 2RS",
    "bearing 6205",
    "Consulting Technik Q4/2026",
    "Rein. West wing lt. Angebot 25-204",
    "Rollcontainer weiss 5x",
    "Kreiselpumpe Lagerwechsel",
    "bearing seal kit",
  ];

  test("char_wb n-grams 3–5 like sklearn", () => {
    assert.deepEqual(charWbNgrams("ab"), [" ab", "ab ", " ab "]);
    assert.deepEqual(charWbNgrams("abc"), [
      " ab",
      "abc",
      "bc ",
      " abc",
      "abc ",
      " abc ",
    ]);
  });

  test("cosine scores equal sklearn TfidfVectorizer(char_wb, 3–5, min_df 2, sublinear)", () => {
    const m = fitTfidf(texts);
    assert.equal(m.vocab.size, 29);
    const q = transform(m, "Bearing 6206 seal");
    const got = m.vectors.map((v) => Math.round(cosine(v, q) * 1e6) / 1e6);
    assert.deepEqual(got, [0.914008, 1, 0.179725, 0.129771, 0, 0, 0.896094]);
  });

  test("top 5 and 'k of n similar items have the same value'", () => {
    const corpus = texts.map((text, i) => ({
      text,
      PurchasingGroup: i < 2 ? "G1" : "G2",
    }));
    const sims = similarItems(corpus, "Bearing 6206 seal");
    assert.equal(sims.length, 5);
    assert.deepEqual(
      sims.slice(0, 3).map((s) => s.text),
      ["bearing 6205", "Bearing 6204 2RS", "bearing seal kit"],
    );
    assert.equal(
      sameValueText(sims, "PurchasingGroup", "G1"),
      "2 of 5 similar items have the same value",
    );
    assert.deepEqual(similarItems([], "x"), []);
    assert.deepEqual(similarItems(corpus, ""), []);
  });
});

describe("routing (display only)", () => {
  test("units by volume to the least-loaded buyer; 5–15 per buyer and working day", () => {
    const items = [
      ...Array.from({ length: 40 }, (_, i) =>
        item(i, { Plant: "A", date: "2026-09-07" }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        item(100 + i, { Plant: "B", date: "2026-09-07" }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        item(200 + i, { Plant: "C", date: "2026-09-07" }),
      ),
    ];
    const table = routingTable(items, [
      { userId: "buyer001", PurchasingGroup: "G1" },
      { userId: "buyer002", PurchasingGroup: "G2" },
    ]);
    assert.deepEqual(
      table.map((u) => [u.Plant, u.userId]),
      [
        ["A", "buyer001"],
        ["B", "buyer002"],
        ["C", "buyer002"],
      ],
    );
    const routed = route(items, table);
    const perBuyer = new Map<string, number>();
    for (const u of routed.values())
      if (u) perBuyer.set(u.userId, (perBuyer.get(u.userId) ?? 0) + 1);
    assert.equal(perBuyer.get("buyer001"), quota("G1", "2026-09-07"));
    assert.equal(
      perBuyer.get("buyer002"),
      Math.min(15, quota("G2", "2026-09-07")),
    );
    for (const n of perBuyer.values()) assert.ok(n >= 5 && n <= 15);
  });
  test("weekend requests count on Monday", () => {
    assert.equal(inboxDay("2026-09-05"), "2026-09-07");
    assert.equal(inboxDay("2026-09-06"), "2026-09-07");
    assert.equal(inboxDay("2026-09-08"), "2026-09-08");
  });
});

describe("code list", () => {
  test("only prefilled proposals", () => {
    const pg = proposalFrom(
      "PurchasingGroup",
      ["G1", "G2"],
      [0.9, 0.1],
      null,
      THR,
      "global",
      "tabpfn",
    );
    const mg = proposalFrom(
      "MaterialGroup",
      ["M1"],
      [0.99],
      null,
      THR,
      "global",
      "tabpfn",
    );
    const rows = codeListRows([
      {
        PurchaseRequisition: "10000047",
        PurchaseRequisitionItem: "00010",
        proposals: [
          { ...pg, status: "prefilled" },
          { ...mg, status: "prefilled" },
        ],
      },
    ]);
    assert.deepEqual(rows, [
      {
        PurchaseRequisition: "10000047",
        item: "00010",
        field: "PurchasingGroup",
        proposal: "G1",
        confidence: 0.9,
        status: "prefilled",
        source: "tabpfn",
      },
      {
        PurchaseRequisition: "10000047",
        item: "00010",
        field: "MaterialGroup",
        proposal: "M1",
        confidence: 0.99,
        status: "prefilled",
        source: "tabpfn",
      },
    ]);
  });
});

describe("engine (injected classifier)", () => {
  const labelled = Array.from({ length: 300 }, (_, i) =>
    item(i, {
      Plant: i % 2 ? "P1" : "P2",
      PurchasingGroup: i % 2 ? "G1" : "G2",
      MaterialGroup: `MG${i % 3}`,
      text: i % 2 ? "bolt m8" : "paper a4",
    }),
  );
  const open = [
    item(1001, {
      Plant: "P1",
      text: "bolt m10",
      PurchasingGroup: null,
      MaterialGroup: null,
    }),
  ];
  // Fake model: the class of the most similar text, probability 0.9.
  const classify = async (req: any) => {
    const classes = [
      ...new Set<string>(req.train.map((r: any) => String(r[req.field]))),
    ].sort();
    const probabilities = new Map<string, number[]>(
      req.test.map((t: any) => {
        const guess =
          req.field === "PurchasingGroup"
            ? t.text.startsWith("bolt")
              ? "G1"
              : "G2"
            : classes[0];
        return [
          `${t.PurchaseRequisition}/${t.PurchaseRequisitionItem}`,
          classes.map((c) => (c === guess ? 0.9 : 0.1 / (classes.length - 1))),
        ];
      }),
    );
    return { classes, probabilities, source: "tabpfn" };
  };

  test("inputs include original request context, with numeric and text kinds", () => {
    assert.deepEqual(
      columnsFor("PurchasingGroup").map((c) => `${c.name}:${c.kind}`),
      [
        "Plant:categorical",
        "PurchasingOrganization:categorical",
        "PurchaseOrderType:categorical",
        "RequestedQuantity:numeric",
        "BaseUnit:categorical",
        "CompanyCode:categorical",
        "PurchaseRequisitionPrice:numeric",
        "PurReqnPriceQuantity:numeric",
        "PurReqnItemCurrency:categorical",
        "RequestedLeadTimeDays:numeric",
        "StorageLocation:categorical",
        "itemLongText:text",
        "headerNote:text",
        "sourceMaterialGroup:categorical",
        "sourcePurchasingGroup:categorical",
        "sourceSupplier:categorical",
        "sourcePurchasingInfoRecord:categorical",
        "sourceAccountAssignmentCategory:categorical",
        "sourceItemCategory:categorical",
        "accountingContext:text",
        "text:text",
      ],
    );
  });

  test("one call per segment and field", () => {
    const calls = plan(
      labelled,
      [...open, item(1002, { Plant: "P2" })],
      ["MaterialGroup", "PurchasingGroup"],
    );
    assert.deepEqual(
      calls.map(
        (c) => `${c.field}|${c.segment}|${c.test.length}|${c.train.length}`,
      ),
      ["MaterialGroup|global|2|250", "PurchasingGroup|global|2|250"],
    );
  });

  test("stored thresholds and context size do not gate returned predictions", async () => {
    const thr = [
      {
        field: "PurchasingGroup",
        segment: "global",
        threshold: 0.85,
        accuracyAtThreshold: 0.97,
        contextRows: 250,
      },
    ];
    const out = (
      await propose(labelled, open, {
        fields: ["MaterialGroup", "PurchasingGroup"],
        thresholds: thr,
        classify,
      })
    ).get(`${open[0].PurchaseRequisition}/00010`)!;
    assert.deepEqual(
      out.map((p) => [p.field, p.status, p.rightOf100]),
      [
        ["MaterialGroup", "review", null],
        ["PurchasingGroup", "review", null],
      ],
    );
    assert.equal(thresholdInfo({ ...thr[0], contextRows: 100 })!.valid, false);
    const none = (
      await propose(labelled, open, {
        fields: ["PurchasingGroup"],
        thresholds: [],
        classify,
      })
    ).get(`${open[0].PurchaseRequisition}/00010`)!;
    assert.equal(none[0].status, "review");
  });

  test("single-class history reaches the classifier without fabricating a fallback", async () => {
    let calls = 0;
    const result = await propose(
      labelled.map((row) => ({ ...row, PurchasingGroup: "G1" })),
      open,
      {
        fields: ["PurchasingGroup"],
        thresholds: [],
        classify: async (request) => {
          calls++;
          throw new Error("Backend cannot infer from this context");
        },
      },
    );
    const proposal = result.get(`${open[0].PurchaseRequisition}/00010`)![0];
    assert.equal(calls, 1);
    assert.equal(proposal.value, null);
    assert.equal(proposal.confidence, null);
    assert.match(proposal.reason!, /Backend cannot infer/);
    assert.equal(proposal.failed, true);
    assert.equal(proposal.source, "none");
    assert.equal(proposal.backend, undefined);
  });

  test("non-TabPFN classifier results cannot become suggestions", async () => {
    const result = await propose(labelled, open, {
      fields: ["PurchasingGroup"],
      thresholds: [],
      classify: async (request) => ({
        ...(await classify(request)),
        source: "fallback",
      }),
    });
    const proposal = result.get(`${open[0].PurchaseRequisition}/00010`)![0];
    assert.equal(proposal.value, null);
    assert.equal(proposal.confidence, null);
    assert.match(proposal.reason!, /TabPFN did not return/);
    assert.equal(proposal.failed, true);
  });

  test("a field that times out gives an empty proposal, the other field still answers", async () => {
    const slow = async (req: any) =>
      req.field === "MaterialGroup"
        ? new Promise<any>(() => {})
        : classify(req);
    const out = (
      await propose(labelled, open, {
        fields: ["MaterialGroup", "PurchasingGroup"],
        thresholds: [],
        classify: slow,
        timeoutMs: 50,
      })
    ).get(`${open[0].PurchaseRequisition}/00010`)!;
    assert.equal(out[0].value, null);
    assert.match(out[0].reason!, /no answer within/);
    assert.equal(out[1].value, "G1");
  });

  test("calibration: holdout scores and the Wilson threshold per segment", async () => {
    const rows = await calibrate(labelled, classify);
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map((row) => row.field).sort(), [
      "AccountAssignmentCategory",
      "MaterialGroup",
      "PurchasingDocumentItemCategory",
      "PurchasingGroup",
      "Supplier",
    ]);
    const purchasingGroup = rows.find(
      (row) => row.field === "PurchasingGroup",
    )!;
    assert.equal(purchasingGroup.segment, "global");
    assert.equal(purchasingGroup.holdoutRows, 90);
    assert.equal(purchasingGroup.conf.length, 90);
    assert.equal(purchasingGroup.holdoutAccuracy, 1);
    assert.equal(purchasingGroup.threshold, 0.9);
    assert.equal(purchasingGroup.accuracyAtThreshold, 1);
  });
});
