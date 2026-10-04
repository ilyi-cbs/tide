// P-3 lead-time range of one key (material, supplier, plant): own history
// with ≥ 20 lead times answers empirically; else ONE model call with one test
// row over the narrowest context level with ≥ 5 rows (first 2,500 rows).
import cds from "@sap/cds";
import {
  FEATURES,
  FEED,
  NS,
  awaitRun,
  callCore,
  estimate,
  inTx,
  meterRun,
  runResults,
  type Meter,
  type Row,
} from "../kernel/model-calls";
import {
  CONTEXT_ROWS,
  LEVELS,
  MIN_CONTEXT,
  chooseLevel,
  modelRange,
  outOfScope,
  ownRange,
  rangeResult,
  type LadderLevel,
  type LeadTimeRangeResult,
} from "./domain/leadtimes";
import { AppError } from "../../core/errors";
import { predictionSource } from "../kernel/prediction-source";
import { daysBetween } from "../kernel/calendar";
import { fail } from "../kernel/errors";
import { sourceFeedRows } from "../kernel/source-ranges";
import { inCommandScope } from "../kernel/auth";
import { PREDICTION_SOURCE_ROWS } from "../../core/dataset-builder";
import {
  isStockTransfer,
  key,
  latestItem,
  masters,
  ownLeadTimes,
  productFacts,
} from "./data";

const { SELECT } = cds.ql;
export const RANGE_TIMEOUT_MS = 120_000;

/**
 * How reads run: "own" = short root transactions (request handlers: the model
 * run is executed by the queue worker, and SQLite has one connection, so no
 * transaction may stay open while waiting, NS-H4); "current" = the caller's
 * transaction if there is one (kernel inTx), else short ones (ingest hooks
 * must see rows the caller has just written).
 */
export type TxMode = "own" | "current";
const reader =
  (mode: TxMode) =>
  <T>(fn: () => Promise<T>): Promise<T> =>
    mode === "own" ? (cds.tx(fn) as Promise<T>) : inTx(fn);

export interface RangeKey {
  Material: string | null;
  Supplier: string | null;
  Plant: string;
  quantity?: number | null;
  unit?: string | null;
  needDate?: string | null;
}

/** Feed filter clauses of a ladder level (context known at asOf only). */
function trainFilter(
  plant: string,
  asOf: string,
  filter: Record<string, string>,
) {
  return [
    { col: "Plant", op: "=", value: plant },
    { col: "LeadTimeDays", op: ">=", value: "0" },
    { col: "AvailableDate", op: "<", value: asOf },
    { col: "PurchaseOrderDate", op: "<", value: asOf },
    ...Object.entries(filter).map(([col, value]) => ({ col, op: "=", value })),
  ];
}

/** Context rows of a level: count in ItemFact (same filter as the feed). */
async function countLevel(
  plant: string,
  asOf: string,
  filter: Record<string, string>,
): Promise<number> {
  const r = await SELECT.one
    .from(`${NS}.ItemFact`)
    .columns("count(1) as n")
    .where({ Plant: plant, ...filter })
    .and`LeadTimeDays >= 0 and AvailableDate < ${asOf} and PurchaseOrderDate < ${asOf}`;
  return Number(r?.n ?? 0);
}

/**
 * Most recent CONTEXT_ROWS keys (by order date) of a level. A level with more
 * rows is narrowed with an `in` filter on the feed key so the run sees
 * exactly those rows (the plant sample: builder's seeded sampling instead).
 */
async function levelKeys(
  plant: string,
  asOf: string,
  filter: Record<string, string>,
): Promise<string[]> {
  const rows: Row[] = await SELECT.from(`${NS}.ItemFact`)
    .columns("PurchaseOrder", "PurchaseOrderItem")
    .where({ Plant: plant, ...filter })
    .and`LeadTimeDays >= 0 and AvailableDate < ${asOf} and PurchaseOrderDate < ${asOf}`
    .orderBy("PurchaseOrderDate desc", "PurchaseOrder desc", "PurchaseOrderItem desc")
    .limit(CONTEXT_ROWS);
  return rows.map((r) => `${r.PurchaseOrder}/${r.PurchaseOrderItem}`);
}

export interface RangeSpec {
  spec: object;
  level: LadderLevel;
  rows: number;
}

/** The one model call of a key: spec for its ladder level and predict row, or null without a predict row. */
export async function rangeSpec(
  k: RangeKey,
  asOf: string,
  predictKey: string,
  sourceRows?: Row[],
): Promise<RangeSpec> {
  const facts = k.Material ? await productFacts(k.Material) : undefined;
  const pick = await chooseLevel(
    {
      Material: k.Material,
      Supplier: k.Supplier,
      MaterialGroup: facts?.ProductGroup ?? null,
    },
    async (filter) => sourceRows
      ? sourceRows.filter((row) => eligibleSource(row, k.Plant, asOf) &&
        Object.entries(filter).every(([column, value]) => row[column] === value)).length
      : countLevel(k.Plant, asOf, filter),
  );
  const filter: object[] = trainFilter(k.Plant, asOf, pick.filter);
  if (pick.level !== "plant" && pick.rows >= CONTEXT_ROWS) {
    const keys = sourceRows ? sourceRows
      .filter((row) => eligibleSource(row, k.Plant, asOf) &&
        Object.entries(pick.filter).every(([column, value]) => row[column] === value))
      .sort((first, second) => String(second.PurchaseOrderDate).localeCompare(String(first.PurchaseOrderDate)) ||
        String(second.id).localeCompare(String(first.id)))
      .slice(0, CONTEXT_ROWS).map((row) => String(row.id))
      : await levelKeys(k.Plant, asOf, pick.filter);
    filter.push({ col: "id", op: "in", values: keys });
  }
  return {
    level: pick.level,
    rows: pick.rows,
    spec: {
      feed: FEED,
      target: "LeadTimeDays",
      features: FEATURES,
      task: "regression",
      train: { filter },
      predict: { keys: [predictKey] },
      output: { type: "quantiles", levels: LEVELS },
    },
  };
}

/**
 * The range of one key at asOf. Model estimates are primary whenever a run
 * succeeds; own history remains secondary evidence for dense sources.
 */
export async function leadTimeRange(
  k: RangeKey,
  asOf: string,
  meter: Meter,
  dryRun = false,
  mode: TxMode = "own",
  independentSetting = false,
): Promise<LeadTimeRangeResult> {
  const read = reader(mode);
  const { prepared, sourceRows } = await read(async () => {
    const sourceRows = k.needDate != null || k.quantity != null
      ? (await sourceFeedRows()).filter((row) => inCommandScope(meter.user, row)) : undefined;
    return { prepared: await prepareRange(k, asOf, sourceRows), sourceRows };
  });
  if ("result" in prepared) return prepared.result;
  const { nOwn, predictKey, spec, level, rows, own } = prepared;
  if (k.quantity != null || k.needDate != null) {
    if (k.quantity != null && (!Number.isFinite(k.quantity) || k.quantity <= 0 || !k.unit?.trim()))
      throw fail(400, "Scenario quantity must be positive and finite and have a unit");
    if (k.unit) {
      const [PurchaseOrder, PurchaseOrderItem] = predictKey.split("/");
      const item: Row | undefined = sourceRows
        ? sourceRows.find((row) => row.id === predictKey)
        : await read(async () => await SELECT.one.from(`${NS}.ItemFact`).columns("Unit").where({ PurchaseOrder, PurchaseOrderItem }));
      if (item?.Unit !== k.unit)
        throw fail(400, "Scenario unit is incompatible with the supplier reference");
    }
    const overrides = {
      ...(k.quantity != null ? { OrderQuantity: k.quantity, NetAmountEUR: null } : {}),
      ...(k.needDate != null ? { RequestedGapDays: daysBetween(asOf, k.needDate), PurchaseOrderMonth: Number(asOf.slice(5, 7)) } : {}),
    };
    (spec as any).predict.overrides = { [predictKey]: overrides };
  }
  if (independentSetting)
    (spec as any).features = FEATURES.filter(
      (field) => !["PlannedDays", "RequestedGapDays"].includes(field),
    );
  if (dryRun) {
    await estimate(
      meter,
      `range ${key(k.Material ?? "", k.Supplier ?? "", k.Plant)}`,
      spec,
    );
    return {
      ...rangeResult(k, "none", nOwn, "dry run", rows, null),
      ownLevels: own?.levels ?? null,
    } as any;
  }
  const input = { spec, ...(sourceRows ? { [PREDICTION_SOURCE_ROWS]: sourceRows } : {}) };
  const run: any = await callCore(meter.user, "predict", input);
  const done =
    run.status === "succeeded"
      ? run
      : await awaitRun(meter.user, run.ID, RANGE_TIMEOUT_MS);
  meter.runs.push(run.ID);
  if (done.status !== "succeeded") {
    meter.failed.push(`range ${predictKey}: ${done.errorCode}`);
    throw new AppError(
      "INFERENCE_FAILED",
      `range ${predictKey}: run ${run.ID} ${done.status} ${done.errorCode ?? ""}`,
    );
  }
  meterRun(meter, done, run.status === "succeeded");
  const { full, q } = await read(async () => ({
    full: (await SELECT.one
      .from("tide.core.PredictionRun")
      .columns("fallback", "trainRows", "backend")
      .where({ ID: run.ID })) as Row | undefined,
    q: (await runResults(run.ID)).get(predictKey) ?? [],
  }));
  meter.backend = full?.backend ?? meter.backend;
  const source = predictionSource(full);
  const mapped =
    source === "none"
      ? rangeResult(
          k,
          "none",
          nOwn,
          "unsupported prediction provider",
          Number(full?.trainRows ?? rows),
          null,
        )
      : modelRange(
          k,
          nOwn,
          level,
          Number(full?.trainRows ?? rows),
          q,
          full?.fallback ?? null,
        );
  return {
    ...mapped,
    source,
    ...(source === "fake"
      ? { sentence: "Test-provider estimate; not measured TabPFN evidence." }
      : {}),
    ...(source === "none"
      ? {
          sentence:
            "No forecast: the prediction provider is unavailable or unsupported.",
        }
      : {}),
    ownLevels: own?.levels ?? null,
    ownP10: own?.p10 ?? null,
    ownP50: own?.p50 ?? null,
    ownP80: own?.p80 ?? null,
    ownP90: own?.p90 ?? null,
    modelRunID: run.ID,
    modelBackend: full?.backend ?? null,
    modelFallback: full?.fallback ?? null,
  } as any;
}

type Prepared =
  | { result: LeadTimeRangeResult }
  | {
      nOwn: number;
      predictKey: string;
      spec: object;
      level: LadderLevel;
      rows: number;
      own: any | null;
    };

/** Everything before the model call (reads only): rule, own history, ladder level and spec. */
function eligibleSource(row: Row, plant: string, asOf: string): boolean {
  return row.Plant === plant && row.LeadTimeDays != null && Number.isFinite(Number(row.LeadTimeDays)) &&
    Number(row.LeadTimeDays) >= 0 && !!row.AvailableDate && String(row.AvailableDate) < asOf &&
    !!row.PurchaseOrderDate && String(row.PurchaseOrderDate) < asOf;
}

async function prepareRange(k: RangeKey, asOf: string, sourceRows?: Row[]): Promise<Prepared> {
  const latest = () => sourceRows ? sourceRows
    .filter((row) => row.Material === k.Material && row.Plant === k.Plant &&
      (!k.Supplier || row.Supplier === k.Supplier) && row.PurchaseOrderDate && String(row.PurchaseOrderDate) < asOf)
    .sort((first, second) => String(second.PurchaseOrderDate).localeCompare(String(first.PurchaseOrderDate)) ||
      String(second.id).localeCompare(String(first.id)))[0]
    : k.Material ? latestItem({ Material: k.Material, Supplier: k.Supplier, Plant: k.Plant }, asOf) : undefined;
  const master = k.Material
    ? (await masters({ Material: k.Material, Plant: k.Plant })).get(
        `${k.Material}|${k.Plant}`,
      )
    : undefined;
  if (isStockTransfer(master))
    return { result: outOfScope(k, String(master!.ProcurementSubType)) };
  let nOwn = 0;
  if (k.Material && k.Supplier) {
    const own = sourceRows ? sourceRows
      .filter((row) => row.Material === k.Material && row.Supplier === k.Supplier && eligibleSource(row, k.Plant, asOf))
      .map((row) => ({ lt: Number(row.LeadTimeDays) })) : (
        await ownLeadTimes(asOf, {
          Material: k.Material,
          Supplier: k.Supplier,
          Plant: k.Plant,
        })
      ).get(key(k.Material, k.Supplier, k.Plant)) ?? [];
    nOwn = own.length;
    const r = ownRange(
      k,
      own.map((o) => o.lt),
    );
    if (r) {
      const item = await latest();
      if (!item) return { result: r };
      const predictKey = `${item.PurchaseOrder}/${item.PurchaseOrderItem}`;
      const { spec, level, rows } = await rangeSpec(k, asOf, predictKey, sourceRows);
      // Too little context for a model call: the own history answers alone.
      if (rows < MIN_CONTEXT) return { result: r };
      return { nOwn, predictKey, spec, level, rows, own: r };
    }
  }
  const item = await latest();
  const pick = item;
  if (!pick)
    return {
      result: {
        ...rangeResult(
          k,
          "none",
          nOwn,
          "no purchase order of this key",
          0,
          null,
          "no origin-safe representative for the requested supplier; no other supplier was substituted",
        ),
        sentence:
          "No purchase order for this supplier before the forecast date; no other supplier was substituted.",
      },
    };
  const predictKey = `${pick.PurchaseOrder}/${pick.PurchaseOrderItem}`;
  const { spec, level, rows } = await rangeSpec(k, asOf, predictKey, sourceRows);
  if (rows < MIN_CONTEXT)
    return {
      result: rangeResult(
        k,
        "none",
        nOwn,
        "too little context",
        rows,
        null,
        `fewer than ${MIN_CONTEXT} completed orders in the plant before the forecast date; no model call`,
      ),
    };
  return { nOwn, predictKey, spec, level, rows, own: null };
}
