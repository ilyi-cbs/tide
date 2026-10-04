import cds from "@sap/cds";
import { AppError, safeError, sanitizeErrors } from "./core/errors";
import { tabularExecutionLeaseMs } from "./core/config";
import {
  canonicalJson,
  feedRegistry,
  inputFingerprint,
  normalizeOutput,
  normalizeSpec,
  publicFeed,
  specHash,
  SpecError,
  type Feed,
  type TabularSpec,
} from "./core/feeds";
import {
  applyCallerScope,
  buildRequest,
  PREDICTION_SOURCE_ROWS,
  type TabularRequest,
} from "./core/dataset-builder";
import {
  postTabular,
  tabularRuntime,
  type TabularResult,
} from "./core/tabular-client";

const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
const LOG = cds.log("core");

const RUNS = "tide.core.PredictionRun";
const RESULTS = "tide.core.PredictionResult";
const REQUESTS = "tide.core.PredictionRequest";
const DEFAULT_TOP = 1000;
const MAX_TOP = 10_000;
const ACTIVE = ["pending", "running"];
const PREDICTION_CONTRACT_VERSION = "core-prediction-contract-v2";

/** Queued (persistent, retried, multi-instance safe) background event. */
export const EXECUTE_RUN = "executeRun";
/** Emitted in the worker's success transaction; payload { runId, feed, target, task }. */
export const RUN_SUCCEEDED = "runSucceeded";

const isUniqueViolation = (error: any) =>
  /UNIQUE/i.test(String(error?.message)) ||
  error?.code === "UNIQUE_CONSTRAINT_VIOLATION";

async function readRun(runId: string, top = DEFAULT_TOP, skip = 0) {
  const run = await SELECT.one
    .from(RUNS)
    .columns(
      "ID",
      "status",
      "feed",
      "target",
      "task",
      "errorCode",
      "errorMessage",
      "trainRows",
      "elapsedMs",
      "outputType",
      "levels",
      "fallback",
      "droppedColumns",
      "modelCalls",
      "costUnits",
      "inputFingerprint",
      "backend",
      "modelVersion",
      "effectiveFeatureCount",
      "contextCells",
      "predictedCells",
      "createdAt",
      "modifiedAt",
    )
    .where({ ID: runId });
  if (!run) return null;
  const { n } = await SELECT.one
    .from(RESULTS)
    .columns("count(1) as n")
    .where({ run_ID: runId });
  const results = await SELECT.from(RESULTS)
    .columns("rowKey", "value", "probabilities", "quantiles")
    .where({ run_ID: runId })
    .orderBy("rowKey")
    .limit(top, skip);
  return { ...run, resultCount: Number(n), results };
}

/**
 * Returns the run for this hash in the current (request) transaction,
 * creating it or resetting a failed one when a new execution is needed.
 */
async function claimRun(
  hash: string,
  spec: TabularSpec,
  request: TabularRequest,
  backend: string | null,
  backendIdentity: string,
  correlationId: string,
) {
  const fields = {
    specHash: specHash(spec, "legacy"),
    inputFingerprint: hash,
    predictionContractVersion: PREDICTION_CONTRACT_VERSION,
    spec: JSON.stringify(spec),
    inputSnapshot: canonicalJson(request),
    feed: spec.feed,
    target: spec.target,
    task: spec.task,
    outputType: spec.output.type,
    levels: spec.output.levels ? JSON.stringify(spec.output.levels) : null,
    backend,
    backendIdentity,
    correlationId,
  };
  const existing = () =>
    SELECT.one
      .from(RUNS)
      .columns("ID", "status", "errorCode")
      .where({ inputFingerprint: hash });
  let run = cds.db.kind === "sqlite" ? undefined : await existing();
  if (!run) {
    const ID = cds.utils.uuid();
    try {
      await INSERT.into(RUNS).entries({
        ID,
        ...fields,
        status: "pending",
      });
      return { ID, fresh: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      run = await existing();
      if (!run) throw error;
    }
  }
  if (run.status !== "failed") return { ID: run.ID as string, fresh: false };
  if (["TABULAR_MALFORMED", "TABULAR_OUTCOME_UNKNOWN"].includes(run.errorCode))
    return { ID: run.ID as string, fresh: false };
  await DELETE.from(RESULTS).where({ run_ID: run.ID });
  await UPDATE.entity(RUNS, run.ID).with({
    ...fields,
    status: "pending",
    errorCode: null,
    errorMessage: null,
    trainRows: null,
    elapsedMs: null,
    fallback: null,
    droppedColumns: null,
    backend: null,
    modelVersion: null,
    modelCalls: null,
    modelCells: null,
    effectiveFeatureCount: null,
    contextCells: null,
    predictedCells: null,
    costUnits: null,
    executionLease: null,
    leaseExpiresAt: null,
    dispatchStartedAt: null,
  });
  return { ID: run.ID as string, fresh: true };
}

/** Records that the current user asked for this run (row-level access). */
async function recordRequest(runId: string) {
  const owner = cds.context?.user?.id;
  const mine = await SELECT.one
    .from(REQUESTS)
    .columns("ID")
    .where({ run_ID: runId, createdBy: owner });
  if (mine) return;
  try {
    await INSERT.into(REQUESTS).entries({
      ID: cds.utils.uuid(),
      run_ID: runId,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
}

async function isRequestedByCurrentUser(runId: string) {
  const mine = await SELECT.one
    .from(REQUESTS)
    .columns("ID")
    .where({ run_ID: runId, createdBy: cds.context?.user?.id });
  return !!mine;
}

async function markFailed(runId: string, error: unknown, lease?: string) {
  await cds.tx(() =>
    UPDATE.entity(RUNS)
      .set({
        status: "failed",
        executionLease: null,
        leaseExpiresAt: null,
        ...safeError(error),
      })
      .where(
        lease
          ? { ID: runId, status: "running", executionLease: lease }
          : { ID: runId, status: { in: ACTIVE } },
      ),
  );
}

/** One value per result: probabilities as class map, quantiles as array. */
function resultRows(runId: string, result: TabularResult) {
  const classes = result.classes ?? [];
  return result.predictions.map((p) => ({
    run_ID: runId,
    rowKey: String(p.row_key),
    value: String(p.value),
    probabilities: p.probabilities
      ? JSON.stringify(
          Object.fromEntries(classes.map((c, i) => [c, p.probabilities![i]])),
        )
      : null,
    quantiles: p.quantiles ? JSON.stringify(p.quantiles) : null,
  }));
}

export default class CoreService extends cds.ApplicationService {
  #registry?: Map<string, Feed>;

  feeds() {
    return (this.#registry ??= feedRegistry(cds.model as any));
  }

  async init() {
    sanitizeErrors(this);

    this.on("listFeeds", () =>
      [...this.feeds().values()]
        .map(publicFeed)
        .sort((a, b) => a.name.localeCompare(b.name)),
    );

    this.on("describeFeed", async (req: cds.Request) => {
      const feed = this.feeds().get(req.data.feed);
      if (!feed) return req.reject(404, `Unknown feed '${req.data.feed}'`);
      const { n } = await applyCallerScope(
        SELECT.one.from(feed.entity).columns("count(1) as n"),
        feed,
      );
      return { ...publicFeed(feed), rowCount: Number(n) };
    });

    this.on("getRun", async (req: cds.Request) => {
      const { runId, top, skip } = req.data;
      if (top != null && (top < 0 || top > MAX_TOP))
        return req.reject(400, `top must be between 0 and ${MAX_TOP}`);
      if (skip != null && skip < 0)
        return req.reject(400, "skip must not be negative");
      // 404 (not 403) for other users' runs, so run IDs cannot be probed.
      if (!(await isRequestedByCurrentUser(runId)))
        return req.reject(404, `Run ${runId} not found`);
      const run = await readRun(runId, top ?? DEFAULT_TOP, skip ?? 0);
      return run ?? req.reject(404, `Run ${runId} not found`);
    });

    // Validates, claims the (shared) run and queues its execution, all in the
    // request transaction: the queue message commits iff the run row does.
    // Returns immediately; clients poll getRun while pending/running.
    this.on("predict", async (req: cds.Request) => {
      let spec: TabularSpec;
      let feed: Feed;
      try {
        const normalized = normalizeSpec(req.data.spec, this.feeds());
        spec = normalized.spec;
        feed = normalized.feed;
      } catch (error) {
        if (error instanceof SpecError) return req.reject(400, error.message);
        throw error;
      }
      // Freeze selected rows and backend identity before claiming the run.
      // The cache key must not outlive its exact source data or backend.
      const { backend, identity } = await tabularRuntime();
      let request: TabularRequest;
      try {
        request = await cds.tx(() =>
          buildRequest(
            feed!,
            spec,
            undefined,
            req.data[PREDICTION_SOURCE_ROWS],
          ),
        );
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        // Persist selection failures as inspectable runs; they have no input snapshot or queue message.
        const ID = cds.utils.uuid();
        await INSERT.into(RUNS).entries({
          ID,
          status: "failed",
          spec: JSON.stringify(spec),
          inputFingerprint: inputFingerprint(
            { spec, selectionFailure: ID },
            identity,
            PREDICTION_CONTRACT_VERSION,
          ),
          predictionContractVersion: PREDICTION_CONTRACT_VERSION,
          feed: spec.feed,
          target: spec.target,
          task: spec.task,
          outputType: spec.output.type,
          levels: spec.output.levels
            ? JSON.stringify(spec.output.levels)
            : null,
          ...safeError(error),
        });
        await recordRequest(ID);
        return readRun(ID);
      }
      const hash = inputFingerprint(
        req.data.force === true
          ? { request, nonce: cds.utils.uuid() }
          : request,
        identity,
        PREDICTION_CONTRACT_VERSION,
      );
      const correlationId = String(cds.context?.id ?? cds.utils.uuid());
      const { ID, fresh } = await claimRun(
        hash,
        spec,
        request,
        backend,
        identity,
        correlationId,
      );
      await recordRequest(ID);
      if (fresh) await cds.queued(this).send(EXECUTE_RUN, { runId: ID });
      return readRun(ID);
    });

    // Only the worker that claims pending -> running executes the immutable snapshot.
    // Keep database work in short root transactions so the connection is free while tabular runs.
    this.on(EXECUTE_RUN, async (msg: cds.Event) => {
      const { runId } = msg.data as { runId: string };
      const lease = cds.utils.uuid();
      const expires = new Date(
        Date.now() + tabularExecutionLeaseMs(),
      ).toISOString();
      const claimed = await cds.tx(
        () =>
          UPDATE.entity(RUNS).set({
            status: "running",
            executionLease: lease,
            leaseExpiresAt: expires,
          })
            .where`ID = ${runId} and (status = 'pending' or (status = 'running' and (leaseExpiresAt is null or leaseExpiresAt < ${new Date().toISOString()})))`,
      );
      if (!claimed) {
        const active = await cds.tx(() =>
          SELECT.one
            .from(RUNS)
            .columns("status", "leaseExpiresAt")
            .where({ ID: runId }),
        );
        if (active?.status === "running") {
          const after = Math.max(
            1,
            Date.parse(active.leaseExpiresAt) - Date.now() + 1,
          );
          await cds.queued(this).send({
            event: EXECUTE_RUN,
            data: { runId },
            ...{ queue: { after } },
          });
        }
        return;
      }
      const run = await cds.tx(() =>
        SELECT.one
          .from(RUNS)
          .columns(
            "ID",
            "spec",
            "inputSnapshot",
            "correlationId",
            "backend",
            "dispatchStartedAt",
            "responseSnapshot",
            "backendIdentity",
          )
          .where({ ID: runId, executionLease: lease }),
      );
      if (!run?.inputSnapshot) {
        await markFailed(
          runId,
          new AppError("INTERNAL", "missing input snapshot"),
          lease,
        );
        return;
      }

      let result: TabularResult;
      let backend: string | null = run.backend ?? null;
      let featureCount = 0;
      let dispatched = !!run.dispatchStartedAt;
      try {
        const request: TabularRequest = JSON.parse(run.inputSnapshot);
        featureCount = request.columns.length;
        if (run.responseSnapshot) {
          try {
            result = JSON.parse(run.responseSnapshot);
          } catch {
            throw new AppError("TABULAR_MALFORMED", "invalid saved response");
          }
        } else {
          if (run.dispatchStartedAt)
            throw new AppError(
              "TABULAR_OUTCOME_UNKNOWN",
              "worker lost after dispatch without a saved response",
            );
          const spec: TabularSpec = JSON.parse(run.spec);
          // Legacy runs without output settings use the task default.
          spec.output ??= normalizeOutput(undefined, spec.task);
          const feed = [...this.feeds().values()].find(
            (f) => f.sqlName === spec.feed,
          );
          if (!feed)
            throw new AppError("TABULAR_REJECTED", `feed ${spec.feed} is gone`);
          const runtime = await tabularRuntime();
          if (run.backendIdentity && runtime.identity !== run.backendIdentity)
            throw new AppError(
              "TABULAR_REJECTED",
              "model configuration changed before dispatch",
            );
          backend = runtime.backend;
          const owned = await cds.tx(() =>
            UPDATE.entity(RUNS)
              .set({ dispatchStartedAt: new Date().toISOString() })
              .where({ ID: runId, status: "running", executionLease: lease }),
          );
          if (!owned) return;
          dispatched = true;
          result = await postTabular(
            request,
            run.correlationId,
            runtime.configuration,
          );
          const stored = await cds.tx(() =>
            UPDATE.entity(RUNS)
              .set({ responseSnapshot: JSON.stringify(result) })
              .where({ ID: runId, status: "running", executionLease: lease }),
          );
          if (!stored) return;
        }
      } catch (error: any) {
        if (dispatched && !(error instanceof AppError))
          error = new AppError(
            "TABULAR_OUTCOME_UNKNOWN",
            "execution failed after dispatch without a durable response",
          );
        LOG.warn(
          `run ${runId} [${run.correlationId}] failed:`,
          error instanceof AppError ? `${error.code} ${error.detail}` : error,
        );
        // Rethrow transient failures for queue retry; the final-attempt handler marks the run failed.
        if (error instanceof AppError && error.retryable) {
          await cds.tx(() =>
            UPDATE.entity(RUNS)
              .set({
                status: "pending",
                executionLease: null,
                leaseExpiresAt: null,
                dispatchStartedAt: null,
              })
              .where({ ID: runId, status: "running", executionLease: lease }),
          );
          throw error;
        }
        await markFailed(runId, error, lease);
        return;
      }

      try {
        await cds.tx(async () => {
          const updated = await UPDATE.entity(RUNS)
            .set({
              status: "succeeded",
              errorCode: null,
              errorMessage: null,
              trainRows: result.train_rows,
              elapsedMs: result.elapsed_ms,
              fallback: result.fallback ?? null,
              droppedColumns: result.dropped_columns?.length
                ? JSON.stringify(result.dropped_columns)
                : null,
              backend: result.usage?.backend ?? backend,
              modelVersion:
                typeof result.usage?.model_version === "string"
                  ? result.usage.model_version.slice(0, 80)
                  : null,
              modelCalls: result.usage?.calls ?? null,
              modelCells: result.usage?.num_cells ?? null,
              effectiveFeatureCount:
                result.usage?.effective_feature_count ?? featureCount,
              contextCells: result.usage?.context_cells ?? null,
              predictedCells: result.usage?.predicted_cells ?? null,
              costUnits: result.usage?.cost_units ?? null,
              executionLease: null,
              leaseExpiresAt: null,
            })
            .where({ ID: runId, status: "running", executionLease: lease });
          if (!updated) return; // finished concurrently by another attempt
          await DELETE.from(RESULTS).where({ run_ID: runId });
          const rows = resultRows(runId, result);
          if (rows.length) await INSERT.into(RESULTS).entries(rows);
          const { feed, target, task } = await SELECT.one
            .from(RUNS)
            .columns("feed", "target", "task")
            .where({ ID: runId });
          // Synchronous in-process listeners run inside this transaction.
          await this.emit(RUN_SUCCEEDED, { runId, feed, target, task });
        });
      } catch (error) {
        await cds.tx(() =>
          UPDATE.entity(RUNS)
            .set({
              status: "pending",
              executionLease: null,
              leaseExpiresAt: null,
            })
            .where({ ID: runId, status: "running", executionLease: lease }),
        );
        throw error;
      }
    });

    this.on(`${EXECUTE_RUN}/#failed`, async (msg: cds.Event) => {
      const { runId } = msg.data as { runId: string };
      LOG.error(`run ${runId}: giving up after the last attempt`);
      const run = await cds.tx(() =>
        SELECT.one
          .from(RUNS)
          .columns("dispatchStartedAt", "responseSnapshot")
          .where({ ID: runId }),
      );
      await markFailed(
        runId,
        run?.dispatchStartedAt && !run.responseSnapshot
          ? new AppError(
              "TABULAR_OUTCOME_UNKNOWN",
              "worker lost after dispatch",
            )
          : new AppError("TABULAR_UNAVAILABLE", "retries exhausted"),
      );
    });

    return super.init();
  }
}
