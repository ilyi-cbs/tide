// Predict on request (P-8) over MCP (predict_orders): the strict form refuses
// with 400 before any model call; the reality check gates the answer (0 calls
// with too little history, 1 on a failed check, 2 on a pass); the result has
// the reality-check sentence, the top rows without probabilities and a card.
// A fake tabular scores by supplier: SBAD -> 0.9 "yes", else 0.1; for lead
// time it returns [m-5, m, m+5], m = 20 / 40 days for order quantity 1 / 2, else
// 45 (SBAD) or 28.
import cds from "@sap/cds";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const { INSERT, SELECT } = cds.ql;
const app = cds.test(path.join(__dirname, "..")) as ReturnType<
  typeof cds.test
> & { url: string };
const NS = "tide.cockpit";
const AS_OF = "2026-10-05";
const calls: {
  keys: string[];
  train: number;
  task: string;
  columns: string[];
}[] = [];
let fake: Server;
let flat = false;

async function tool(
  name: string,
  args: object = {},
  user = "ilyesse.hettenbach@cbs-consulting.de",
) {
  const res = await fetch(app.url + "/mcp/cockpit", {
    method: "POST",
    headers: {
      authorization:
        "Basic " +
        btoa(
          `${user}:${user === "ilyesse.hettenbach@cbs-consulting.de" ? "alice" : user}`,
        ),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  const json = JSON.parse(
    text.startsWith("{") ? text : text.match(/^data: (.*)$/m)![1],
  );
  return json.result;
}

const day = (base: string, n: number) => {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let seq = 0;
function fact(o: {
  plant?: string;
  supplier: string;
  ordered: string;
  requested: string;
  available: string | null;
  country?: string;
  partial?: boolean;
}) {
  seq++;
  return {
    PurchaseOrder: String(4500000000 + seq),
    PurchaseOrderItem: "10",
    Material: "M1",
    MaterialGroup: "G1",
    MaterialType: "ROH",
    Plant: o.plant ?? "P1",
    Supplier: o.supplier,
    SupplierCountry: o.country ?? "DE",
    PurchasingGroup: "001",
    Category: "stock",
    OrderQuantity: 5,
    NetAmountEUR: 100,
    PlannedDays: 20,
    PurchaseOrderDate: o.ordered,
    PurchaseOrderMonth: Number(o.ordered.slice(5, 7)),
    RequestedDate: o.requested,
    RequestedGapDays: 30,
    AvailableDate: o.available,
    IsOpen: o.available === null,
    PartialFirstReceipt: !!o.partial,
  };
}

before(async () => {
  fake = createServer(async (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/health")
      return res.end(JSON.stringify({ status: "ok", backend: "fake" }));
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const r = JSON.parse(raw);
    calls.push({
      keys: r.keys,
      train: r.x_train.length,
      task: r.task,
      columns: r.columns.map((c: any) => c.name),
    });
    const col = r.columns.findIndex((c: any) => c.name === "Supplier");
    const classes = [...new Set<string>(r.y_train.map(String))].sort();
    const quantiles = r.output.type === "quantiles";
    res.end(
      JSON.stringify({
        task: r.task,
        output_type: r.output.type,
        classes: quantiles ? null : classes,
        levels: quantiles ? r.output.levels : null,
        predictions: r.keys.map((k: string, i: number) => {
          const bad = r.x_test[i][col] === "SBAD";
          if (quantiles) {
            const qty =
              r.x_test[i][
                r.columns.findIndex((c: any) => c.name === "OrderQuantity")
              ];
            const mid = qty === 1 ? 20 : qty === 2 ? 40 : bad ? 45 : 28;
            return {
              row_key: k,
              value: mid,
              quantiles: [mid - 5, mid, mid + 5],
            };
          }
          const yes = flat ? 0.5 : bad ? 0.9 : 0.1;
          return {
            row_key: k,
            value: yes > 0.5 ? "yes" : "no",
            probabilities: classes.map((c) => (c === "yes" ? yes : 1 - yes)),
          };
        }),
        fallback: null,
        dropped_columns: [],
        placeholder: false,
        usage: {
          backend: "fake",
          calls: 1,
          context_cells: r.x_train.length * (r.columns.length + 1),
          predicted_cells: r.x_test.length * r.columns.length,
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
  (cds.env.requires as any).tabular.maxContextRows = 3000;
  await app;
  await INSERT.into("tide.s4.DatasetInfo").entries({
    ID: "current",
    name: "t",
    asOf: AS_OF,
    containsCustomerData: false,
  });
  const facts: any[] = [];
  // Plant P1: SBAD 15 days late, SGOOD on time. History before the cutoff (2026-08-10) ...
  for (let i = 0; i < 120; i++) {
    const bad = i % 2 === 0;
    const ordered = day("2026-01-01", i);
    const requested = day(ordered, 30);
    facts.push(
      fact({
        supplier: bad ? "SBAD" : "SGOOD",
        ordered,
        requested,
        available: day(requested, bad ? 15 : -2),
        partial: i % 4 < 2,
      }),
    );
  }
  // ... and items open at the cutoff whose outcome became known after it (evaluated).
  for (let i = 0; i < 40; i++) {
    const bad = i % 2 === 0;
    const requested = day("2026-08-10", i % 45);
    facts.push(
      fact({
        supplier: bad ? "SBAD" : "SGOOD",
        ordered: day(requested, -40),
        requested,
        available: day(requested, bad ? 12 : 1),
        partial: i % 4 < 2,
      }),
    );
  }
  // Plant P3, key M3/SLT: lead times of 20 (quantity 1) or 40 days (quantity 2); 110 known
  // before the cutoff (2026-08-10), 40 ordered 2026-07-25..08-03 and received after it.
  for (let i = 0; i < 150; i++) {
    const ordered =
      i < 110 ? day("2026-01-01", i) : day("2026-07-25", (i - 110) % 10);
    const lt = i % 2 ? 40 : 20;
    const f = fact({
      plant: "P3",
      supplier: "SLT",
      ordered,
      requested: day(ordered, 30),
      available: day(ordered, lt),
    });
    facts.push({ ...f, Material: "M3", OrderQuantity: i % 2 ? 2 : 1 });
  }
  // Plant P2: little history.
  for (let i = 0; i < 6; i++)
    facts.push(
      fact({
        plant: "P2",
        supplier: "SBAD",
        ordered: day("2026-07-01", i),
        requested: day("2026-08-15", i),
        available: day("2026-08-20", i),
      }),
    );
  // Open items at the as-of date.
  facts.push(
    fact({
      supplier: "SGOOD",
      ordered: "2026-09-20",
      requested: "2026-10-20",
      available: null,
    }),
  );
  facts.push(
    fact({
      supplier: "SBAD",
      ordered: "2026-09-21",
      requested: "2026-10-12",
      available: null,
      country: "PL",
    }),
  );
  facts.push(
    fact({
      supplier: "SGOOD",
      ordered: "2026-08-01",
      requested: "2026-09-01",
      available: null,
    }),
  ); // already late
  await INSERT.into(`${NS}.ItemFact`).entries(facts);
});

after(() => new Promise<void>((r) => fake.close(() => r())));

describe("predict_orders (P-8)", () => {
  test("the strict form refuses with 400 before any model call", async () => {
    calls.length = 0;
    const cases: [object, RegExp][] = [
      [
        { target: "price" },
        /target: must be one of late_by_days, lead_time_days, partial_delivery/,
      ],
      [{ target: "late_by_days" }, /lateDays is required/],
      [{ target: "late_by_days", lateDays: 61 }, /1 to 60/],
      [{ target: "partial_delivery", lateDays: 3 }, /only allowed there/],
      [
        {
          target: "late_by_days",
          lateDays: 5,
          key: { material: "M1", supplier: "S", plant: "P1" },
        },
        /only allowed for lead_time_days/,
      ],
      [
        { target: "partial_delivery", filters: { supplierRegion: "asia" } },
        /supplierRegion/,
      ],
      [
        { target: "partial_delivery", filters: { supplier: "S9" } },
        /unknown supplier S9/,
      ],
      [
        { target: "partial_delivery", filters: { plant: "X1" } },
        /unknown plant X1/,
      ],
    ];
    for (const [args, re] of cases) {
      const r = await tool("predict_orders", args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(r.content[0].text, re);
    }
    assert.equal(calls.length, 0, "no model call");
    assert.equal(
      (await SELECT.from(`${NS}.PredictionQuestion`)).length,
      0,
      "no question stored",
    );
  });

  test("late by N: pass after 2 calls, reality check, top rows without probabilities, already late, card", async () => {
    calls.length = 0;
    const r = await tool("predict_orders", {
      target: "late_by_days",
      lateDays: 7,
      filters: { plant: "P1" },
    });
    assert.ok(
      !r.isError,
      JSON.stringify({
        content: r.content,
        questions: await SELECT.from(`${NS}.PredictionQuestion`).columns(
          "status",
          "verdict",
        ),
      }),
    );
    const p = r.structuredContent.result;
    assert.equal(p.verdict, "pass");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].task, "classification");
    assert.deepEqual(calls[0].columns.sort(), [
      "MaterialGroup",
      "MaterialType",
      "NetAmount",
      "OrderQuantity",
      "OwnPastDeliveries",
      "POMonth",
      "PlannedDays",
      "PlannedStatus",
      "Plant",
      "PurchasingGroup",
      "RequestedGapDays",
      "Supplier",
      "SupplierRegion",
    ]);
    assert.match(
      p.realityCheck,
      /^Reality check: had I asked this 8 weeks ago, 10 of my top 10 would have been late \(normally \d+ of 10\)$/,
    );
    assert.equal(p.answer, "ranking in the results card");
    assert.equal(p.alreadyLate, 1);
    assert.equal(p.openItems, 2);
    assert.deepEqual(
      p.rows.map((x: any) => [x.rank, x.Supplier]),
      [
        [1, "SBAD"],
        [2, "SGOOD"],
      ],
    );
    assert.equal(p.rows[0].SupplierRegion, "eu");
    const card = JSON.parse(p.card);
    assert.equal(card.kind, "prediction");
    assert.ok(!("canAddToWorklist" in card));
    assert.equal(card.modelCalls, 2);
    for (const row of card.rows)
      assert.ok(!("score" in row), "no probability in the card");
    for (const row of p.rows)
      assert.ok(!("score" in row), "no probability for the model");
    // What the model sees: the result without the card (the agent moves the card to the UI).
    const { card: _card, ...forModel } = p;
    assert.doesNotMatch(JSON.stringify(forModel), /score|probab|"auc"/i);
    // The feed rows of the question are removed afterwards.
    assert.equal((await SELECT.from(`${NS}.PredictRow`)).length, 0);
  });

  test("a failed check still shows predictions with a validation warning", async () => {
    calls.length = 0;
    flat = true;
    try {
      const p = (
        await tool("predict_orders", {
          target: "late_by_days",
          lateDays: 7,
          filters: { plant: "P1" },
        })
      ).structuredContent.result;
      assert.equal(p.verdict, "fail");
      assert.equal(calls.length, 2);
      assert.ok(p.rows.length > 0);
      assert.match(p.warnings.join(" "), /Prediction is unvalidated/);
    } finally {
      flat = false;
    }
  });

  test("too little history: no model call", async () => {
    calls.length = 0;
    const p = (
      await tool("predict_orders", {
        target: "partial_delivery",
        filters: { plant: "P2" },
      })
    ).structuredContent.result;
    assert.equal(p.verdict, "too little");
    assert.equal(p.realityCheck, "not enough history to check this");
    assert.equal(p.answer, "not enough history to check this");
    assert.equal(calls.length, 0);
  });

  test("lead time: ranges per row, a (new order) row for a key without open items", async () => {
    calls.length = 0;
    const p = (
      await tool("predict_orders", {
        target: "lead_time_days",
        key: { material: "M3", supplier: "SLT", plant: "P3" },
      })
    ).structuredContent.result;
    assert.equal(p.verdict, "pass", p.realityCheck);
    assert.match(
      p.realityCheck,
      /^Reality check: had I asked this 8 weeks ago, a typical miss was [\d.]+ days, against [\d.]+ days for the usual duration; \d+ of \d+ fell in the likely range$/,
    );
    assert.equal(calls[0].task, "regression");
    if (p.verdict === "pass") {
      assert.equal(p.rows.length, 1);
      assert.equal(p.rows[0].PurchaseOrder, "(new order)");
      assert.deepEqual(
        [p.rows[0].p10Days, p.rows[0].p50Days, p.rows[0].p90Days],
        [35, 40, 45],
      );
    }
  });

  test("supplier region filter restricts the scored rows", async () => {
    const p = (
      await tool("predict_orders", {
        target: "late_by_days",
        lateDays: 7,
        filters: { plant: "P1", supplierRegion: "eu" },
      })
    ).structuredContent.result;
    assert.ok(p.rows.every((r: any) => r.SupplierRegion === "eu"));
    assert.match(p.warnings.join(" "), /context widened to plant P1/);
  });
});
