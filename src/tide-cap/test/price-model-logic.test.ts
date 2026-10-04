import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  intervalCoverage,
  isPriceAlert,
  meanAbsoluteError,
  priceQuantiles,
  selectTailThreshold,
  tailPosition,
  unitPrice,
} from "../srv/cockpit/rules/domain/price-model";
import { priceKey } from "../srv/cockpit/rules/domain/price";
import { priceAction } from "../srv/cockpit/rules/price-action";
import { predictionSource } from "../srv/cockpit/kernel/prediction-source";

test("prediction source distinguishes declared provider fake fallback and unknown", () => {
  assert.equal(predictionSource({ backend: "fake" }), "fake");
  assert.equal(predictionSource({ backend: "priorlabs" }), "tabpfn");
  assert.equal(predictionSource({ backend: "aicore" }), "tabpfn");
  assert.equal(
    predictionSource({ backend: "aicore", fallback: "context_quantiles" }),
    "fallback",
  );
  assert.equal(predictionSource({ backend: "unverified" }), "none");
  assert.equal(
    predictionSource({ backend: "aicore", placeholder: true }),
    "none",
  );
});

test("price clarification snapshots model and empirical evidence with matching price quantities", async () => {
  const action = await priceAction(
    {
      ID: "price:PO/10",
      list: "price",
      objectKey: "PO/10",
      PurchaseOrder: "PO",
      PurchaseOrderItem: "10",
      priceDetail: {
        unitPrice: 20,
        currentPrice: 200,
        priceQuantity: 10,
        currency: "EUR",
        priorMedian: 9,
        priorCount: 24,
        expectedP10: 8,
        expectedP50: 10,
        expectedP90: 12,
        assessmentSource: "tabpfn",
        assessmentRunID: "reviewed-run",
        calibrationStatus: "calibrated",
      },
    },
    "app",
  );
  const item = action.items![0];
  assert.equal(item.oldValue, "200");
  assert.equal(item.newValue, "100");
  assert.ok(item.data);
  assert.equal(item.data.source, "tabpfn");
  const modelEvidence = item.data.modelEvidence;
  assert.ok(
    typeof modelEvidence === "object" &&
      modelEvidence !== null &&
      "runID" in modelEvidence,
  );
  assert.equal(modelEvidence.runID, "reviewed-run");
  const empiricalEvidence = item.data.empiricalEvidence;
  assert.ok(
    typeof empiricalEvidence === "object" &&
      empiricalEvidence !== null &&
      "median" in empiricalEvidence,
  );
  assert.equal(empiricalEvidence.median, 9);
  assert.ok(item.text);
  assert.match(item.text, /No SAP price is changed/);
});

describe("price model domain", () => {
  test("never pools order units in comparable history", () => {
    const base = { Material: "M1", Plant: "P1", Currency: "EUR" };
    assert.notEqual(
      priceKey({ ...base, OrderUnit: "EA" }),
      priceKey({ ...base, OrderUnit: "BOX" }),
    );
  });

  test("normalizes price and flags only extreme modeled tails", () => {
    assert.equal(
      unitPrice({ NetPriceAmount: 100, NetPriceQuantity: 10 } as any),
      10,
    );
    assert.equal(tailPosition(10, 8, 10, 12), 0.5);
    assert.equal(isPriceAlert(tailPosition(20, 8, 10, 12)), true);
    assert.equal(isPriceAlert(tailPosition(10, 8, 10, 12)), false);
  });

  test("selects a calibration threshold before independent holdout metrics", () => {
    assert.equal(
      selectTailThreshold([0.5, 0.02, 0.98], [true, true, false]),
      0.01,
    );
    assert.equal(intervalCoverage([10, 15], [8, 12], [12, 14]), 0.5);
    assert.equal(meanAbsoluteError([10, 15], [11, 13]), 1.5);
  });

  test("injected tenfold error lies in an extreme model tail", () => {
    assert.equal(isPriceAlert(tailPosition(100, 8, 10, 12), 0.05), true);
  });

  test("diagnostic tail thresholds discriminate instead of flagging identical rows", () => {
    const tails = Array.from({ length: 100 }, (_, index) =>
      tailPosition(index + 1, 10, 20, 30),
    );
    const alerts = [0.01, 0.025, 0.05, 0.1].map(
      (threshold) =>
        tails.filter((tail) => isPriceAlert(tail, threshold)).length,
    );
    assert.equal(new Set(alerts).size, 4);
    assert.ok(
      alerts.every((count, index) => index === 0 || count > alerts[index - 1]),
    );
    assert.equal(tailPosition(0, 10, 20, 30), null);
    assert.equal(tailPosition(10, 30, 20, 10), null);
    assert.equal(tailPosition(Infinity, 10, 20, 30), null);
    assert.equal(tailPosition(20, 20, 20, 20), 0.5);
    assert.equal(selectTailThreshold([], []), null);
  });

  test("price-space outputs reject overflow underflow and crossed quantiles", () => {
    assert.deepEqual(
      priceQuantiles([Math.log(10), Math.log(20), Math.log(30)])?.map(
        Math.round,
      ),
      [10, 20, 30],
    );
    assert.equal(priceQuantiles([700, 800, 900]), null);
    assert.equal(priceQuantiles([-1000, -900, -800]), null);
    assert.equal(priceQuantiles([3, 2, 1]), null);
    assert.equal(
      unitPrice({ NetPriceAmount: Infinity, NetPriceQuantity: 1 } as any),
      null,
    );
  });
});
