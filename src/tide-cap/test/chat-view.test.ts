// What the chat model sees of a cockpit tool result (P-9, NS-J2): pure, no CDS.
//   node --import tsx --test test/chat-view.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_MODEL_ROWS, modelView } from "../srv/cockpit/chat-view";

test("rows keep fixed keys, at most ten, uncalibrated and expert values removed", () => {
  const rows = Array.from({ length: 14 }, (_, i) => ({
    ID: `at_risk:${i}`,
    issue: "May arrive after the requested date",
    source: "tabpfn",
    p_late: 0.83,
    probability: 0.8,
    expectedValueAtRisk: 1234.5,
    expert: '{"x":1}',
    issueTechnical: "p80 > requested",
    whatever: 1,
  }));
  const out = modelView({ total: 14, rows, contextRows: 3000, auc: 0.7 }) as any;
  assert.equal(out.rows.length, MAX_MODEL_ROWS);
  assert.equal(out.rowsShown, "first 10 of 14");
  assert.deepEqual(out.rows[0], { ID: "at_risk:0", issue: "May arrive after the requested date", source: "tabpfn" });
  assert.ok(!("contextRows" in out) && !("auc" in out));
});

test("rule rows keep their values; proposals keep value, status and source", () => {
  assert.deepEqual(modelView([{ ID: "a", source: "rule", p_late: 1 }]), [{ ID: "a", source: "rule", p_late: 1 }]);
  const out = modelView({
    fields: [{ field: "MaterialGroup", value: "M01", text: "Bolts", confidence: 0.91, status: "prefilled", rightOf100: 93, source: "tabpfn" }],
  }) as any;
  assert.deepEqual(out.fields, [{ field: "MaterialGroup", value: "M01", text: "Bolts", status: "prefilled", source: "tabpfn" }]);
});

test("nested objects keep row keys; the card stays a string for the agent", () => {
  const out = modelView({
    row: { ID: "x", expert: "{}", issue: "i" },
    impact: { level: "customer_order_late", revenueAtRisk: 5, customers: ["Acme"], scenarios: "[]" },
    card: { kind: "prediction" },
  }) as any;
  assert.deepEqual(out.row, { ID: "x", issue: "i" });
  assert.deepEqual(out.impact, { level: "customer_order_late", revenueAtRisk: 5, customers: ["Acme"] });
  assert.equal(out.card, '{"kind":"prediction"}');
});
