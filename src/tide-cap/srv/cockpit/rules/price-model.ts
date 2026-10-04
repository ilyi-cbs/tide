// Price-model orchestration. Rows are materialized before Core snapshots them,
// then compatible PO items share one cutoff/currency/unit quantile run.
import cds from "@sap/cds";
import { createHash, randomUUID } from "node:crypto";
import {
  awaitRun,
  callCore,
  estimate,
  forcePrediction,
  meterRun,
  runResults,
  type Meter,
} from "../kernel/model-calls";
import {
  PRICE_LEVELS,
  PRICE_MODEL_CONTRACT,
  intervalCoverage,
  isPriceAlert,
  meanAbsoluteError,
  priceQuantiles,
  selectTailThreshold,
  tailPosition,
  unitPrice,
} from "./domain/price-model";
import { priceKey, type PriceRow } from "./domain/price";
import * as store from "./store";
import { inScope, scopeOf } from "../kernel/auth";
import { predictionSource } from "../kernel/prediction-source";
import { PREDICTION_PROFILES } from "../kernel/prediction-profiles";

const { SELECT, DELETE, INSERT, UPSERT } = cds.ql;
const NS = "tide.cockpit";
const FEATURES = [...PREDICTION_PROFILES.price.features];
const RECENT_DAYS = 30;
type Row = PriceRow & Record<string, any>;
export type AssessedPrice = { row: Row; assessment: Record<string, any> };

export type PurchasePriceInput = {
  Material: string;
  Plant: string;
  Supplier: string;
  quantity: number;
  unit: string;
  currency: string;
  asOf: string;
};

const keyOf = (row: Row) => `${row.PurchaseOrder}/${row.PurchaseOrderItem}`;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

function priceModelRows(prices: Row[]) {
  const first = prices.reduce<string | null>(
    (out, row) =>
      !out || row.PurchaseOrderDate < out ? row.PurchaseOrderDate : out,
    null,
  );
  return prices.map((row) => ({
    id: keyOf(row),
    rowKind: "source",
    PurchaseOrder: row.PurchaseOrder,
    PurchaseOrderItem: row.PurchaseOrderItem,
    PurchaseOrderDate: row.PurchaseOrderDate,
    Material: row.Material,
    MaterialGroup: row.MaterialGroup ?? null,
    MaterialType: row.MaterialType ?? null,
    Supplier: row.Supplier ?? null,
    Plant: row.Plant,
    PurchasingOrganization: row.PurchasingOrganization ?? null,
    PurchasingGroup: row.PurchasingGroup ?? null,
    OrderQuantity: Number(row.OrderQuantity) || null,
    OrderUnit: row.OrderUnit ?? "",
    Currency: row.Currency,
    DateOffsetDays: first
      ? Math.round(
          (Date.parse(row.PurchaseOrderDate) - Date.parse(first)) / 86_400_000,
        )
      : 0,
    PurchaseOrderMonth: Number(row.PurchaseOrderDate.slice(5, 7)),
    LogUnitPrice: Number(Math.log(unitPrice(row)!).toPrecision(15)),
  }));
}

export async function syncPriceModelRows() {
  const prices = (await store.priceRows()) as Row[];
  const rows = priceModelRows(prices);
  await cds.tx(async () => {
    // Never remove a transient planning row before Core has captured it.
    await DELETE.from(`${NS}.PriceModelRow`).where({ rowKind: "source" });
    for (let i = 0; i < rows.length; i += 500)
      await INSERT.into(`${NS}.PriceModelRow`).entries(rows.slice(i, i + 500));
  });
  return prices;
}

/** Persisted assessments remain evidence even when they are not alert-worthy. */
export async function assessPriceCandidates(
  user: cds.User,
  asOf: string,
  candidates: Row[],
  meter?: Meter,
  preparedRows?: Row[],
  onDemand = false,
  dryRun = false,
): Promise<AssessedPrice[]> {
  if (dryRun && !meter) throw new Error("Price dry-run requires a meter");
  const scope = scopeOf(user);
  const all = (
    preparedRows ??
    (dryRun ? await store.priceRows() : await syncPriceModelRows())
  ).filter((row) => !onDemand || inScope(scope, row));
  const lower = new Date(Date.parse(asOf) - RECENT_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const eligible = candidates.filter(
    (row) =>
      (onDemand || row.PurchaseOrderDate >= lower) &&
      row.PurchaseOrderDate < asOf &&
      unitPrice(row) !== null,
  );
  const groups = new Map<string, Row[]>();
  for (const row of eligible) {
    const group = `${row.PurchaseOrderDate}|${row.Currency}|${row.OrderUnit ?? ""}`;
    (groups.get(group) ?? groups.set(group, []).get(group)!).push(row);
  }
  const assessed: AssessedPrice[] = [];
  for (const group of groups.values()) {
    const row = group[0];
    // A PO can contain multiple comparable lines. Exclude every evaluated PO
    // from context, not merely each predicted line, to avoid document leakage.
    const excludedPurchaseOrders = [
      ...new Set(group.map((candidate) => candidate.PurchaseOrder)),
    ];
    try {
      const spec = {
        feed: "CockpitPriceFeed",
        target: "LogUnitPrice",
        features: FEATURES,
        task: "regression",
        train: {
          filter: [
            { col: "Currency", op: "=", value: row.Currency },
            { col: "OrderUnit", op: "=", value: row.OrderUnit ?? "" },
            {
              col: "PurchaseOrderDate",
              op: "<",
              value: row.PurchaseOrderDate,
            },
            ...(onDemand
              ? [
                  {
                    col: "id",
                    op: "in",
                    values: all.map(keyOf),
                  },
                ]
              : []),
            ...(onDemand && scope.PurchasingGroup
              ? [
                  {
                    col: "PurchasingGroup",
                    op: "=",
                    value: scope.PurchasingGroup,
                  },
                ]
              : []),
          ],
          exclude: [{ col: "PurchaseOrder", values: excludedPurchaseOrders }],
        },
        predict: { keys: group.map(keyOf) },
        output: { type: "quantiles", levels: PRICE_LEVELS },
      };
      if (dryRun && meter) {
        await estimate(
          meter,
          `price assessment ${row.PurchaseOrderDate} ${row.Currency}/${row.OrderUnit ?? ""}`,
          spec,
          priceModelRows(all),
        );
        continue;
      }
      const started: any = await callCore(user, "predict", { spec });
      const run: any = await awaitRun(user, started.ID);
      if (meter) meterRun(meter, run, started.status === "succeeded");
      if (run.status !== "succeeded") continue;
      const results = await runResults(run.ID);
      for (const candidate of group) {
        const quantiles = results.get(keyOf(candidate));
        if (!quantiles?.length) continue;
        const pricesAtLevels = priceQuantiles(quantiles);
        if (!pricesAtLevels) continue;
        const [p10, p50, p90] = pricesAtLevels;
        const history = all.filter(
          (other) =>
            other.PurchaseOrderDate < candidate.PurchaseOrderDate &&
            other.PurchaseOrder !== candidate.PurchaseOrder &&
            priceKey(other) === priceKey(candidate),
        );
        const prices = history
          .map(unitPrice)
          .filter((value): value is number => value !== null);
        const actual = unitPrice(candidate)!;
        const tail = tailPosition(actual, p10, p50, p90);
        const assessment = {
          PurchaseOrder: candidate.PurchaseOrder,
          PurchaseOrderItem: candidate.PurchaseOrderItem,
          expectedP10: p10,
          expectedP50: p50,
          expectedP90: p90,
          actualUnitPrice: actual,
          historicalMedian: prices.length ? median(prices) : null,
          historicalCount: prices.length,
          deviationPercent: p50 ? ((actual - p50) / p50) * 100 : null,
          tailPosition: tail,
          // Until a persisted calibration is available this means "review" only,
          // never a claim that the entered price is erroneous.
          alert: isPriceAlert(tail),
          source: predictionSource(run),
          fallbackReason: run.fallback ?? null,
          backend: run.backend ?? null,
          predictionContractVersion: PRICE_MODEL_CONTRACT,
          run_ID: run.ID,
          inputFingerprint: run.inputFingerprint ?? null,
          computedAt: new Date().toISOString(),
          asOf,
          trainingRows: run.trainRows ?? 0,
          contextScope: `currency ${candidate.Currency}; order unit ${candidate.OrderUnit ?? "blank"}`,
          rangeLevels: JSON.stringify(PRICE_LEVELS),
          validationPeriod: null,
          calibrationStatus: "uncalibrated",
        };
        assessed.push({ row: candidate, assessment });
      }
    } catch {
      // Rule evidence remains usable if model infrastructure is unavailable.
    }
  }
  const eligibleAssessments = assessed.filter(
    ({ assessment }) =>
      assessment.source === "tabpfn" &&
      Number.isFinite(assessment.tailPosition) &&
      assessment.historicalMedian !== null &&
      Number.isFinite(assessment.historicalMedian),
  );
  if (eligibleAssessments.length >= 10) {
    // Each assessment trains strictly before its own PO date. Split those
    // chronologically again: select an alert threshold on the older slice and
    // report quality only on the newer holdout slice.
    eligibleAssessments.sort((a, b) =>
      a.row.PurchaseOrderDate.localeCompare(b.row.PurchaseOrderDate),
    );
    const cutoff =
      eligibleAssessments[Math.floor(eligibleAssessments.length * 0.7)].row
        .PurchaseOrderDate;
    const calibration = eligibleAssessments.filter(
      ({ row }) => row.PurchaseOrderDate < cutoff,
    );
    const holdout = eligibleAssessments.filter(
      ({ row }) => row.PurchaseOrderDate >= cutoff,
    );
    const threshold = selectTailThreshold(
      calibration.map(({ assessment }) => Number(assessment.tailPosition)),
      calibration.map(() => true),
    );
    if (threshold !== null && holdout.length) {
      const validationID = `${PRICE_MODEL_CONTRACT}:${asOf}`;
      const actual = holdout.map(({ assessment }) =>
        Number(assessment.actualUnitPrice),
      );
      const expected = holdout.map(({ assessment }) =>
        Number(assessment.expectedP50),
      );
      const baseline = holdout.map(({ assessment }) =>
        Number(assessment.historicalMedian),
      );
      const lower = holdout.map(({ assessment }) =>
        Number(assessment.expectedP10),
      );
      const upper = holdout.map(({ assessment }) =>
        Number(assessment.expectedP90),
      );
      const ordinaryAlertRate =
        holdout.filter(({ assessment }) =>
          isPriceAlert(assessment.tailPosition, threshold),
        ).length / holdout.length;
      await cds.tx(() =>
        UPSERT.into(`${NS}.PriceModelValidation`).entries({
          ID: validationID,
          contractVersion: PRICE_MODEL_CONTRACT,
          calibrationFrom: calibration[0].row.PurchaseOrderDate,
          calibrationTo: calibration.at(-1)!.row.PurchaseOrderDate,
          holdoutFrom: holdout[0].row.PurchaseOrderDate,
          holdoutTo: holdout.at(-1)!.row.PurchaseOrderDate,
          trainingRows: calibration.reduce(
            (sum, item) => sum + Number(item.assessment.trainingRows ?? 0),
            0,
          ),
          validationRows: holdout.length,
          observedCoverage: intervalCoverage(actual, lower, upper),
          medianMae: meanAbsoluteError(actual, expected),
          baselineMae: meanAbsoluteError(actual, baseline),
          ordinaryAlertRate,
          // A transparent injected-error check: multiply the held-out observed
          // price by ten while keeping the prediction interval fixed.
          injectedErrorRecall:
            holdout.filter(({ assessment }) =>
              isPriceAlert(
                tailPosition(
                  Number(assessment.actualUnitPrice) * 10,
                  Number(assessment.expectedP10),
                  Number(assessment.expectedP50),
                  Number(assessment.expectedP90),
                ),
                threshold,
              ),
            ).length / holdout.length,
          threshold,
        }),
      );
      for (const { assessment } of eligibleAssessments) {
        assessment.validation_ID = validationID;
        assessment.calibrationStatus = "diagnostic";
        assessment.validationPeriod = `${holdout[0].row.PurchaseOrderDate} to ${holdout.at(-1)!.row.PurchaseOrderDate}`;
        assessment.alert = isPriceAlert(assessment.tailPosition, threshold);
      }
    }
  }
  if (assessed.length)
    await cds.tx(() =>
      UPSERT.into(`${NS}.PriceAssessment`).entries(
        assessed.map(({ assessment }) => assessment),
      ),
    );
  return assessed;
}

const estimateID = (input: PurchasePriceInput) =>
  `estimate:${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 40)}`;

export async function preparePurchasePrices(
  user: cds.User,
  asOf: string,
  all: Row[],
  meter?: Meter,
  scope?: PurchasePriceInput,
  dryRun = false,
) {
  if (dryRun && !meter) throw new Error("Price dry-run requires a meter");
  const latest = new Map<string, Row>();
  for (const row of all) {
    if (
      scope &&
      (row.Material !== scope.Material ||
        row.Plant !== scope.Plant ||
        row.Supplier !== scope.Supplier ||
        row.OrderUnit !== scope.unit ||
        row.Currency !== scope.currency)
    )
      continue;
    if (
      row.PurchaseOrderDate >= asOf ||
      !row.Supplier ||
      !row.Currency ||
      !row.OrderUnit ||
      !(Number(row.OrderQuantity) > 0)
    )
      continue;
    const key = JSON.stringify([row.Material, row.Plant, row.Supplier]);
    if (
      !latest.has(key) ||
      latest.get(key)!.PurchaseOrderDate < row.PurchaseOrderDate
    )
      latest.set(key, row);
  }
  const first = all.reduce(
    (date, row) =>
      row.PurchaseOrderDate < date ? row.PurchaseOrderDate : date,
    asOf,
  );
  const groups = new Map<
    string,
    Array<{
      id: string;
      row: Row;
      input: PurchasePriceInput;
      result: Record<string, any>;
    }>
  >();
  for (const row of latest.values()) {
    const input = {
      Material: row.Material,
      Plant: row.Plant,
      Supplier: String(row.Supplier),
      quantity: scope?.quantity ?? Number(row.OrderQuantity),
      unit: scope?.unit ?? String(row.OrderUnit),
      currency: scope?.currency ?? row.Currency,
      asOf,
    };
    const compatible = all.filter(
      (other) =>
        other.PurchaseOrderDate < asOf &&
        other.Material === input.Material &&
        other.Plant === input.Plant &&
        other.Currency === input.currency &&
        other.OrderUnit === input.unit,
    );
    const own = compatible.filter((other) => other.Supplier === input.Supplier);
    const prices = (own.length ? own : compatible)
      .map(unitPrice)
      .filter((value): value is number => value !== null);
    const key = JSON.stringify([input.currency, input.unit]);
    const result = {
      historicalReference: prices.length ? median(prices) : null,
      historicalCount: prices.length,
      source: "fallback",
      reason: "Prediction unavailable",
      assumedQuantity: input.quantity,
      assumedUnit: input.unit,
      assumedCurrency: input.currency,
      contextScope: `currency ${input.currency}; order unit ${input.unit}; ${own.length ? "selected supplier" : "all suppliers"}`,
    };
    (groups.get(key) ?? groups.set(key, []).get(key)!).push({
      id: estimateID(input),
      row,
      input,
      result,
    });
  }
  const estimates: Array<{ id: string; asOf: string; result: string }> = [];
  for (const group of groups.values()) {
    const staged = group.map((entry) => ({
      ...entry,
      stagingID: `estimate:${randomUUID()}`,
    }));
    const transient = staged.map(({ id, stagingID, row, input }) => ({
      id: stagingID,
      rowKind: "estimate",
      PurchaseOrder: id.slice(0, 10),
      PurchaseOrderItem: "00000",
      PurchaseOrderDate: asOf,
      Material: input.Material,
      MaterialGroup: row.MaterialGroup ?? null,
      MaterialType: row.MaterialType ?? null,
      Supplier: input.Supplier,
      Plant: input.Plant,
      PurchasingOrganization: row.PurchasingOrganization ?? null,
      PurchasingGroup: row.PurchasingGroup ?? null,
      OrderQuantity: input.quantity,
      OrderUnit: input.unit,
      Currency: input.currency,
      DateOffsetDays: Math.round(
        (Date.parse(asOf) - Date.parse(first)) / 86_400_000,
      ),
      PurchaseOrderMonth: Number(asOf.slice(5, 7)),
      LogUnitPrice: null,
    }));
    const input = group[0].input;
    const spec = {
      feed: "CockpitPriceFeed",
      target: "LogUnitPrice",
      features: FEATURES,
      task: "regression",
      train: {
        filter: [
          { col: "Currency", op: "=", value: input.currency },
          { col: "OrderUnit", op: "=", value: input.unit },
          { col: "PurchaseOrderDate", op: "<", value: asOf },
        ],
      },
      predict: { keys: staged.map(({ stagingID }) => stagingID) },
      output: { type: "quantiles", levels: PRICE_LEVELS },
    };
    if (dryRun && meter) {
      await estimate(
        meter,
        `purchase prices ${input.currency}/${input.unit}`,
        spec,
        [...priceModelRows(all), ...transient],
      );
      continue;
    }
    await cds.tx(async () => {
      for (let offset = 0; offset < transient.length; offset += 500)
        await INSERT.into(`${NS}.PriceModelRow`).entries(
          transient.slice(offset, offset + 500),
        );
    });
    try {
      const started: any = await callCore(user, "predict", { spec });
      const run: any =
        started.status === "succeeded"
          ? started
          : await awaitRun(user, started.ID);
      if (meter) meterRun(meter, run, started.status === "succeeded");
      if (run.status === "succeeded") {
        const results = await runResults(run.ID);
        for (const entry of staged) {
          const quantiles = results.get(entry.stagingID);
          if (!quantiles?.length) continue;
          const pricesAtLevels = priceQuantiles(quantiles);
          if (!pricesAtLevels) {
            entry.result.reason = "Invalid price-space quantiles";
            continue;
          }
          const [p10, p50, p90] = pricesAtLevels;
          Object.assign(entry.result, {
            p10,
            p50,
            p90,
            source: predictionSource(run),
            reason: run.fallback ?? null,
            backend: run.backend ?? null,
            runID: run.ID,
            inputFingerprint: run.inputFingerprint ?? null,
            computedAt: new Date().toISOString(),
            trainingRows: run.trainRows ?? null,
          });
        }
      } else {
        for (const entry of group)
          entry.result.reason = run.errorCode ?? "Prediction unavailable";
      }
    } catch (error: any) {
      cds
        .log("cockpit")
        .warn(
          "Prepared purchase prices use historical references",
          error?.message,
        );
    } finally {
      await cds.tx(async () => {
        for (let offset = 0; offset < transient.length; offset += 500)
          await DELETE.from(`${NS}.PriceModelRow`).where({
            rowKind: "estimate",
            id: {
              in: transient.slice(offset, offset + 500).map((row) => row.id),
            },
          });
      });
    }
    estimates.push(
      ...group.map(({ id, result }) => ({
        id,
        asOf,
        result: JSON.stringify(result),
      })),
    );
  }
  if (dryRun) return;
  await cds.tx(async () => {
    if (!scope) await DELETE.from(`${NS}.PurchasePriceEstimate`);
    for (let offset = 0; offset < estimates.length; offset += 500)
      await UPSERT.into(`${NS}.PurchasePriceEstimate`).entries(
        estimates.slice(offset, offset + 500),
      );
  });
}

export async function estimatePurchasePrice(
  input: PurchasePriceInput,
  _user: cds.User,
) {
  const Material = String(input.Material ?? "").trim();
  const Plant = String(input.Plant ?? "").trim();
  const Supplier = String(input.Supplier ?? "").trim();
  const quantity = Number(input.quantity);
  const unit = String(input.unit ?? "").trim();
  const currency = String(input.currency ?? "").trim();
  const asOf = String(input.asOf ?? "").slice(0, 10);
  if (
    !Material ||
    !Plant ||
    !Supplier ||
    !Number.isFinite(quantity) ||
    !(quantity > 0) ||
    !unit ||
    !currency ||
    !/^\d{4}-\d{2}-\d{2}$/.test(asOf)
  )
    return {
      source: "unavailable",
      reason:
        "Missing material, plant, supplier, quantity, unit, currency, or as-of date",
    };

  if (forcePrediction())
    await preparePurchasePrices(
      _user,
      asOf,
      await syncPriceModelRows(),
      undefined,
      { Material, Plant, Supplier, quantity, unit, currency, asOf },
    );
  const prepared = await SELECT.one.from(`${NS}.PurchasePriceEstimate`).where({
    id: estimateID({
      Material,
      Plant,
      Supplier,
      quantity,
      unit,
      currency,
      asOf,
    }),
    asOf,
  });
  return prepared
    ? JSON.parse(prepared.result)
    : {
        source: "unavailable",
        reason:
          "No prepared price estimate for these assumptions; run prepareDay",
        assumedQuantity: quantity,
        assumedUnit: unit,
        assumedCurrency: currency,
      };
}
