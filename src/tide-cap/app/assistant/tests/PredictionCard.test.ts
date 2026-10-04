import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { renderCard } from "../src/PredictionCard";
import type { AssistantCard } from "../src/AssistantController";

function card(data: Record<string, any>): AssistantCard {
  return { id: "card-p1", turnId: "t", order: 0, toolCallId: "p1", kind: "prediction", data };
}

const passed = {
  kind: "prediction",
  ID: "q1",
  target: "late_by_days",
  targetText: "late by more than 7 days",
  lateDays: 7,
  filters: { plant: "1010" },
  realityCheck: "Reality check: had I asked this 8 weeks ago, 7 of my top 10 would have been late (normally 3 of 10)",
  verdict: "pass",
  answer: "ranking in the results card",
  evaluated: 120,
  notEvaluated: "4 outcome not yet known, not evaluated",
  openItems: 41,
  alreadyLate: 3,
  check: { cutoff: "2026-08-10", evaluated: 120 },
  rows: Array.from({ length: 20 }, (_, i) => ({
    rank: i + 1,
    PurchaseOrder: String(4500000001 + i),
    PurchaseOrderItem: "10",
    Material: "M1",
    Supplier: "S1",
    RequestedDate: "2026-10-12",
    link: `#/Findings('at_risk:${4500000001 + i}/10')`,
  })),
  warnings: [],
};

test("prediction card: reality check, verdict, top 20, counts, no percentages, no worklist button", () => {
  const dom = new JSDOM("");
  Object.assign(globalThis, { document: dom.window.document });
  const node = renderCard(card(passed));
  const text = node.textContent ?? "";
  assert.equal(node.querySelector("[data-testid=prediction-reality]")?.textContent, passed.realityCheck);
  assert.equal(node.querySelector("[data-testid=prediction-verdict]")?.textContent, "Reliable enough");
  assert.equal(node.querySelectorAll("[data-testid=prediction-row]").length, 20);
  assert.match(text, /top 20 of 41, ranked by the AI estimate; the order matters, it is not a promise/);
  assert.match(text, /3 open items already more than 7 days late, not predicted/);
  assert.equal(node.querySelector("a")?.getAttribute("href"), "#/Findings('at_risk:4500000001/10')");
  assert.doesNotMatch(text, /%|probabilit|TabPFN|AUC|quantile/i);
  assert.equal(node.querySelector("button"), null);
});

test("prediction card: a refusal shows the check and the refusal, no rows, no button", () => {
  const dom = new JSDOM("");
  Object.assign(globalThis, { document: dom.window.document });
  const refusal = "I can't predict this reliably: on the last 8 weeks my ranking was not clearly better than the normal rate";
  const node = renderCard(card({ ...passed, verdict: "fail", answer: refusal, rows: [], alreadyLate: 0 }));
  assert.equal(node.querySelector("[data-testid=prediction-verdict]")?.textContent, "Not reliable");
  assert.match(node.textContent ?? "", new RegExp(refusal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(node.querySelector("[data-testid=prediction-rows]"), null);
  assert.equal(node.querySelector("button"), null);
});

test("lead time rows show the likely duration in words", () => {
  const dom = new JSDOM("");
  Object.assign(globalThis, { document: dom.window.document });
  const node = renderCard(
    card({ ...passed, target: "lead_time_days", rows: [{ rank: 1, PurchaseOrder: "(new order)", PurchaseOrderItem: "", p10Days: 20, p50Days: 28, p90Days: 41 }] }),
    () => {},
  );
  assert.match(node.textContent ?? "", /about 28 days, likely 20 to 41/);
  assert.match(node.textContent ?? "", /\(new order\)/);
});
