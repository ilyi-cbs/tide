// Model calls of the cockpit (contract A1): every feature calls CoreService /
// tabular through these helpers, never directly. The budget guard seam
// (registerCallGuard / registerCallRecorder) is implemented by the guard
// feature; without a registration every call passes.
import cds from "@sap/cds";
import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "../../core/errors";
import {
  buildLimits,
  buildRequest,
  type DatasetRow,
} from "../../core/dataset-builder";
import { feedRegistry, normalizeSpec } from "../../core/feeds";
import { postTabular } from "../../core/tabular-client";
import { PREDICTION_PROFILES } from "./prediction-profiles";

const { SELECT } = cds.ql;
const LOG = cds.log("cockpit");
const predictionOptions = new AsyncLocalStorage<boolean>();
export const forcePrediction = () => predictionOptions.getStore() === true;
export const withPredictionOptions = <T>(
  force: boolean,
  work: () => Promise<T>,
) => predictionOptions.run(force, work);

export const NS = "tide.cockpit";
export type Row = Record<string, any>;

export interface CallUsage {
  calls: number;
  costUnits: number;
  label: string;
}
export type CallGuard = (est: CallUsage) => Promise<void>;
export type CallRecorder = (used: CallUsage) => Promise<void>;

const guards: CallGuard[] = [];
const recorders: CallRecorder[] = [];

/** Checked before every model call (callCore "predict") and on every dry-run estimate; throw (status 429) to refuse. */
export function registerCallGuard(fn: CallGuard) {
  guards.push(fn);
}
/** Informed of the calls and cost units a finished run used (meterRun) and of every started prediction (callCore). */
export function registerCallRecorder(fn: CallRecorder) {
  recorders.push(fn);
}
/** Tests only: removes all guards and recorders. */
export function resetCallSeams() {
  guards.length = 0;
  recorders.length = 0;
}

async function guard(est: CallUsage) {
  for (const g of guards) await g(est);
}
async function record(used: CallUsage) {
  for (const r of recorders) await r(used);
}

/**
 * Runs `fn` in the current transaction when there is one (request handlers),
 * else in a short root transaction of its own (detached prepareDay steps:
 * SQLite has one connection, so steps must not hold a transaction while
 * they wait for a model run).
 */
export function inTx<T>(fn: () => Promise<T>): Promise<T> {
  return (cds.context as any)?.tx ? fn() : (cds.tx(fn) as Promise<T>);
}

/**
 * Runs work that waits for a model run outside the request's transaction.
 * SQLite has one connection: a request that held its transaction while the
 * queue worker needs the database to execute the run would wait forever.
 * Reads inside `fn` then run in short root transactions (inTx); the result is
 * returned to the request as usual. User and tenant are kept.
 */
export function modelWork<T>(fn: () => Promise<T>): Promise<T> {
  if (!(cds.context as any)?.tx) return fn();
  const ctx = new (cds.EventContext as any)({
    user: cds.context?.user,
    tenant: cds.context?.tenant,
    locale: cds.context?.locale,
  });
  return (cds as any)._with(ctx, fn);
}

const MODEL_EVENTS = new Set(["predict"]);
// Mirrors tabular's cost model (predict.py CU_PER_*_CELL).
const CU_PER_CONTEXT_CELL = 1.05e-6;
const CU_PER_PREDICTED_CELL = 1.45e-4;

/** Upper-bound cost of one predict call from its spec (full context cap), checked before the call. */
export function preflightCost(spec: Row | undefined): number {
  const width = Array.isArray(spec?.features) ? spec.features.length : 0;
  const keys = Array.isArray(spec?.predict?.keys) ? spec.predict.keys.length : 0;
  if (!width || !keys) return 0;
  const rows = buildLimits().maxContextRows;
  return CU_PER_CONTEXT_CELL * rows * (width + 1) + CU_PER_PREDICTED_CELL * keys * width;
}
const labelOf = (event: string, data: Row) =>
  `${event}${data?.spec?.feed ? " " + data.spec.feed : ""}`;

export const FEED = PREDICTION_PROFILES.source.feed;
export const FEATURES = [...PREDICTION_PROFILES.source.features];

/**
 * Calls CoreService as `user` in a root transaction of its own, so the queued
 * run is committed (and executed) before we wait for it.
 */
export async function callCore(
  user: cds.User,
  event: string,
  data: Row,
): Promise<Row> {
  const model = MODEL_EVENTS.has(event);
  if (model)
    await guard({
      calls: 1,
      costUnits: preflightCost(data?.spec),
      label: labelOf(event, data),
    });
  const core = await cds.connect.to("CoreService");
  const payload = model && forcePrediction() ? { ...data, force: true } : data;
  const result = await cds.tx({ user }, () => core.send(event, payload));
  if (model)
    await record({ calls: 0, costUnits: 0, label: labelOf(event, data) });
  return result;
}

/** Default wait for a model run: cds.env.tide.modelTimeoutMs, else 5 minutes. */
export function modelTimeoutMs(): number {
  const ms = Number((cds.env as any).tide?.modelTimeoutMs);
  return Number.isFinite(ms) && ms > 0 ? ms : 300_000;
}

/**
 * Polls a prediction run until it succeeded or failed. Never waits forever:
 * a run still queued/running after `timeoutMs` (default modelTimeoutMs())
 * throws AppError MODEL_TIMEOUT (status 504). Polls in root transactions of
 * callCore, so no transaction is held while waiting.
 */
export async function awaitRun(
  user: cds.User,
  runId: string,
  timeoutMs = modelTimeoutMs(),
  top = 0,
) {
  const limit =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : modelTimeoutMs();
  const until = Date.now() + limit;
  for (;;) {
    const run: Row = await callCore(user, "getRun", { runId, top });
    if (run.status === "succeeded" || run.status === "failed") return run;
    if (Date.now() >= until)
      throw new AppError(
        "MODEL_TIMEOUT",
        `run ${runId} still ${run.status} after ${limit} ms`,
        true,
        504,
      );
    await new Promise((r) =>
      setTimeout(r, Math.min(500, Math.max(0, until - Date.now()))),
    );
  }
}

/**
 * Adds the exact persisted tabular usage to the meter. A run another request
 * already executed (identical selected inputs) costs nothing now.
 */
export function meterRun(meter: Meter, run: Row, cached: boolean) {
  if (cached || run.status !== "succeeded") return;
  const calls = run.modelCalls ?? 0;
  meter.calls += calls;
  const cost = Number(run.costUnits ?? 0);
  meter.cost += cost;
  const label = `run ${run.ID ?? ""}`.trim();
  // Fire and forget: meterRun stays synchronous (frozen signature).
  record({ calls, costUnits: cost, label }).catch((e) =>
    LOG.warn("call recorder failed:", e),
  );
}

/**
 * Dry run of one planned prediction: builds the same rows as the real run and
 * asks tabular for its usage estimate (mode dry_run: no model call). Creates
 * no PredictionRun.
 */
export async function estimate(
  meter: Meter,
  label: string,
  spec: object,
  sourceRows?: readonly DatasetRow[],
) {
  try {
    const { feed, spec: normalized } = normalizeSpec(
      spec,
      feedRegistry(cds.model as any),
    );
    const request = await cds.tx({ user: meter.user }, () =>
      buildRequest(feed, normalized, undefined, sourceRows),
    );
    const result: Row = await postTabular({ ...request, mode: "dry_run" });
    await guard({
      calls: result.usage?.calls ?? 0,
      costUnits: result.usage?.cost_units ?? 0,
      label,
    });
    meter.planned.push(label);
    meter.calls += result.usage?.calls ?? 0;
    meter.cost += result.usage?.cost_units ?? 0;
    meter.backend = result.usage?.backend ?? meter.backend;
  } catch (error: unknown) {
    LOG.warn(
      `dry run ${label} failed:`,
      error instanceof AppError ? `${error.code} ${error.detail}` : error,
    );
    meter.failed.push(
      `${label}: ${error instanceof AppError ? error.code : "INTERNAL"}`,
    );
  }
}

export async function runResults(
  runId: string,
): Promise<Map<string, number[]>> {
  const rows: Row[] = await SELECT.from("tide.core.PredictionResult")
    .columns("rowKey", "quantiles", "value", "probabilities")
    .where({ run_ID: runId });
  return new Map(
    rows.map((r) => [
      r.rowKey,
      r.quantiles
        ? JSON.parse(r.quantiles)
        : r.probabilities
          ? [JSON.parse(r.probabilities).yes ?? 0]
          : [Number(r.value)],
    ]),
  );
}

export interface Meter {
  user: cds.User;
  calls: number;
  cost: number;
  runs: string[];
  /** Dry run: the predictions a real run would make. */
  planned: string[];
  backend: string | null;
  failed: string[];
}
