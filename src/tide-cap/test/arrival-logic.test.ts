// Pure arrival of open items (kernel/arrival): no CDS.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OPEN_LEVELS,
  chanceAfter,
  modelArrival,
  openArrival,
  openGrid,
  survivorGrid,
} from "../srv/cockpit/kernel/arrival";

/** Uniform lead times 10 … 100 days over the 19 levels. */
const uniform = Object.fromEntries(
  OPEN_LEVELS.map((l) => [l.toFixed(2), Math.round((10 + 90 * l) * 100) / 100]),
);

test("age-conditioned model quantiles retain their arrival dates instead of being conditioned twice", () => {
  const grid = Object.fromEntries(OPEN_LEVELS.map((level) => [level.toFixed(2), 70 + level * 30]));
  const arrival = modelArrival("2025-09-27", grid, "2025-12-01");
  assert.equal(arrival.basis, "grid");
  assert.equal(arrival.p50, "2025-12-21");
  assert.ok(arrival.p10! > "2025-12-01");
  assert.equal(modelArrival("2025-08-01", uniform, "2025-12-01").basis, "none");
  assert.equal(modelArrival(null, grid, "2025-12-01").basis, "none");
});

test("age 0: the open grid equals the grid", () => {
  const g = openGrid(uniform, 0)!;
  assert.deepEqual(g, uniform);
});

test("conditioning on age shifts the range up and never below the age", () => {
  const g = openGrid(uniform, 55)!;
  // Half the uniform mass lies below 55 days: the conditional median is about 77.5.
  assert.ok(Math.abs(g["0.50"] - 77.5) < 1, String(g["0.50"]));
  for (const v of Object.values(g)) assert.ok(v >= 55);
  const values = OPEN_LEVELS.map((l) => g[l.toFixed(2)]);
  assert.deepEqual(
    values,
    [...values].sort((a, b) => a - b),
  );
});

test("age beyond the grid tail: no open grid", () => {
  assert.equal(openGrid(uniform, 98), null);
  assert.equal(openGrid(null, 10), null);
});

test("survivors: only lead times above the age, at least the minimum", () => {
  const hist = Array.from({ length: 40 }, (_, i) => i + 1);
  const g = survivorGrid(hist, 15, 20)!;
  assert.ok(g["0.05"] > 15);
  assert.equal(survivorGrid(hist, 30, 20), null);
});

test("openArrival: old item gets dates after today instead of collapsing to today", () => {
  const asOf = "2025-12-01";
  const a = openArrival("2025-09-27", uniform, asOf); // age 65 days
  assert.equal(a.basis, "grid");
  assert.ok(a.p10! > asOf && a.p50! > a.p10! && a.p90! >= a.p80!);
});

test("openArrival: survivors when the grid tail is passed, none without enough history", () => {
  const asOf = "2025-12-01";
  const pool = Array.from({ length: 30 }, (_, i) => 120 + i);
  assert.equal(
    openArrival("2025-08-01", uniform, asOf, pool).basis,
    "survivors",
  );
  const none = openArrival("2025-08-01", uniform, asOf, []);
  assert.equal(none.basis, "none");
  assert.equal(none.p50, null);
  assert.equal(openArrival(null, uniform, asOf).basis, "none");
});

test("chanceAfter: chance of arriving after the requested gap given the item is still open", () => {
  const open = openGrid(uniform, 0)!;
  const older = openGrid(uniform, 55)!;
  assert.ok(Math.abs(chanceAfter(open, 55, 0)! - 0.5) < 0.02);
  assert.ok(chanceAfter(open, 5, 0)! > 0.95);
  assert.equal(chanceAfter(older, 50, 55), 1);
  assert.ok(chanceAfter(open, 200, 0)! < 0.01);
  assert.ok(chanceAfter(older, 60, 55)! > chanceAfter(open, 60, 0)!);
  assert.equal(chanceAfter(null, 10, 0), null);
});
