// HTTP client for tabular's POST /v1/tabular (docs/api/tabular.v2.md) and its
// GET /health, which reports the model backend and configuration identity.
import cds from "@sap/cds";
import { AppError } from "./errors";
import { tabularTimeoutMs } from "./config";
import type { TabularRequest } from "./dataset-builder";
import type { OutputType } from "./feeds";

const DEFAULT_TIMEOUT_MS = 180_000;
/** tabular answers within X-Deadline-Ms; keep a margin for the network. */
const DEADLINE_MARGIN_MS = 5_000;
const HEALTH_TIMEOUT_MS = 5_000;

export interface TabularPrediction {
  row_key: string;
  value: string | number;
  probabilities?: number[] | null;
  quantiles?: number[] | null;
}

export interface TabularResult {
  task: "classification" | "regression";
  output_type: OutputType;
  classes?: string[] | null;
  levels?: number[] | null;
  predictions: TabularPrediction[];
  fallback?: string | null;
  dropped_columns?: string[] | null;
  placeholder?: boolean;
  usage?: {
    backend?: string;
    calls?: number;
    num_cells?: number;
    context_cells?: number;
    predicted_cells?: number;
    cost_units?: number;
    effective_feature_count?: number;
    model_version?: string | null;
  } | null;
  train_rows: number;
  elapsed_ms: number;
}

function baseUrl(): string {
  const url = (cds.env.requires as any).tabular?.credentials?.url;
  if (!url)
    throw new AppError(
      "TABULAR_UNAVAILABLE",
      "cds.requires.tabular.credentials.url is not configured",
    );
  return String(url).replace(/\/$/, "");
}

function timeoutMs(): number {
  return tabularTimeoutMs(DEFAULT_TIMEOUT_MS);
}

async function send(
  url: string,
  init: RequestInit,
  ms: number,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (error: any) {
    if (init.method === "POST")
      throw new AppError(
        "TABULAR_OUTCOME_UNKNOWN",
        "inference transport failed after dispatch; outcome unknown",
      );
    if (error.name === "TimeoutError")
      throw new AppError(
        "TABULAR_TIMEOUT",
        `no answer within ${ms / 1000} s`,
        true,
      );
    throw new AppError(
      "TABULAR_UNAVAILABLE",
      `unreachable: ${error.cause?.code || error.message}`,
      true,
    );
  }
}

export async function tabularRuntime(): Promise<{
  backend: string | null;
  identity: string;
  configuration: string | null;
}> {
  const response = await send(`${baseUrl()}/health`, {}, HEALTH_TIMEOUT_MS);
  if (!response.ok)
    throw new AppError(
      "TABULAR_UNAVAILABLE",
      `health returned HTTP ${response.status}`,
      true,
    );
  const body: any = await response.json().catch(() => null);
  const backend = typeof body?.backend === "string" ? body.backend : null;
  const configuration =
    typeof body?.identity === "string" && body.identity.length
      ? body.identity
      : null;
  return {
    backend,
    identity: `${backend ?? "unknown"}:${configuration ?? "unversioned"}`,
    configuration,
  };
}

/** Maps a non-2xx answer to an AppError; `retryable` from the body wins. */
function failure(status: number, body: any, retryAfter: string | null) {
  const error = body?.error;
  const code = typeof error?.code === "string" ? error.code : `HTTP_${status}`;
  const message = typeof error?.message === "string" ? error.message : "";
  const retryable =
    typeof error?.retryable === "boolean"
      ? error.retryable
      : [408, 429].includes(status) || status >= 500;
  const detail =
    `HTTP ${status} ${code}${message ? `: ${message}` : ""}` +
    (retryAfter ? ` (retry after ${retryAfter}s)` : "");
  if (code === "UPSTREAM_MALFORMED")
    return new AppError("TABULAR_MALFORMED", detail);
  if (
    code === "UPSTREAM_OUTCOME_UNKNOWN" ||
    ((status >= 500 || status === 429 || status === 408) &&
      typeof error?.retryable !== "boolean")
  )
    return new AppError("TABULAR_OUTCOME_UNKNOWN", detail);
  if (code === "UPSTREAM_TIMEOUT" || status === 504)
    return new AppError("TABULAR_TIMEOUT", detail, retryable);
  return new AppError(
    retryable ? "TABULAR_UNAVAILABLE" : "TABULAR_REJECTED",
    detail,
    retryable,
  );
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const count = (value: unknown) =>
  finite(value) && Number.isSafeInteger(value) && value >= 0;
const PROBABILITY_TOLERANCE = 1e-6;

/** Rejects answers that do not fit the request (never trust the wire). */
function validate(body: any, request: TabularRequest): TabularResult {
  const bad = (why: string) => new AppError("TABULAR_MALFORMED", why);
  if (!body || !Array.isArray(body.predictions))
    throw bad("predictions array missing");
  if (body.task !== request.task) throw bad("task does not match request");
  if (body.output_type !== request.output.type)
    throw bad(`output_type ${body.output_type} != ${request.output.type}`);
  const expected = new Set(request.keys);
  if (body.predictions.length !== expected.size)
    throw bad(
      `${body.predictions.length} predictions for ${expected.size} keys`,
    );
  const levels = request.output.levels ?? [];
  const classes: unknown[] = Array.isArray(body.classes) ? body.classes : [];
  if (
    request.output.type === "probas" &&
    (classes.length === 0 ||
      classes.some((label) => typeof label !== "string" || !label.length) ||
      new Set(classes).size !== classes.length)
  )
    throw bad("classes must be unique nonempty strings");
  if (
    request.output.type === "quantiles" &&
    (!Array.isArray(body.levels) ||
      body.levels.length !== levels.length ||
      body.levels.some(
        (level: unknown, index: number) => level !== levels[index],
      ))
  )
    throw bad("quantile levels do not match request");
  if (
    body.fallback != null &&
    !["context_distribution", "context_quantiles"].includes(body.fallback)
  )
    throw bad("unknown fallback");
  const placeholder = request.mode === "dry_run" && body.fallback == null;
  if (typeof body.placeholder !== "boolean" || body.placeholder !== placeholder)
    throw bad("placeholder does not match request mode");
  const names = new Set(request.columns.map((column) => column.name));
  if (
    !Array.isArray(body.dropped_columns) ||
    new Set(body.dropped_columns).size !== body.dropped_columns.length ||
    body.dropped_columns.some(
      (name: unknown) => typeof name !== "string" || !names.has(name),
    )
  )
    throw bad("invalid dropped columns");
  if (
    (request.output.type !== "probas" && body.classes != null) ||
    (request.output.type !== "quantiles" && body.levels != null)
  )
    throw bad("response contains conflicting output metadata");
  if (
    body.fallback != null &&
    body.fallback !==
      (request.output.type === "quantiles"
        ? "context_quantiles"
        : "context_distribution")
  )
    throw bad("fallback does not match task");
  if (
    !count(body.train_rows) ||
    body.train_rows !== request.x_train.length ||
    !finite(body.elapsed_ms) ||
    body.elapsed_ms < 0
  )
    throw bad("invalid training rows or elapsed time");
  for (const p of body.predictions) {
    if (typeof p?.row_key !== "string" || !expected.delete(p.row_key))
      throw bad("unexpected row_key");
    if (request.output.type === "quantiles") {
      const q = p.quantiles;
      if (!Array.isArray(q) || q.length !== levels.length || !q.every(finite))
        throw bad("quantiles do not match the requested levels");
      for (let i = 1; i < q.length; i++)
        if (q[i] < q[i - 1]) throw bad("quantiles are not sorted");
      const medianIndex = levels.indexOf(0.5);
      if (
        medianIndex >= 0 &&
        (!finite(p.value) ||
          Math.abs(p.value - q[medianIndex]) > PROBABILITY_TOLERANCE)
      )
        throw bad("value does not match median quantile");
    }
    if (request.output.type === "probas") {
      const pr = p.probabilities;
      if (
        !Array.isArray(pr) ||
        pr.length !== classes.length ||
        !pr.every(finite)
      )
        throw bad("probabilities do not match classes");
      if (
        pr.some((probability: number) => probability < 0 || probability > 1) ||
        Math.abs(
          pr.reduce(
            (sum: number, probability: number) => sum + probability,
            0,
          ) - 1,
        ) > PROBABILITY_TOLERANCE
      )
        throw bad("probabilities must be in [0,1] and sum to one");
      const predictedIndex = classes.indexOf(p.value);
      if (
        typeof p.value !== "string" ||
        predictedIndex < 0 ||
        pr[predictedIndex] !== Math.max(...pr)
      )
        throw bad("predicted class must match a maximum probability");
    }
    if (request.output.type !== "probas" && !finite(p.value))
      throw bad("value is not a finite number");
    if (
      (request.output.type !== "probas" && p.probabilities != null) ||
      (request.output.type !== "quantiles" && p.quantiles != null)
    )
      throw bad("prediction contains conflicting output fields");
  }
  const usage = body.usage;
  if (
    !usage ||
    typeof usage.backend !== "string" ||
    !usage.backend ||
    ![
      usage.calls,
      usage.context_cells,
      usage.predicted_cells,
      usage.effective_feature_count,
    ].every(count) ||
    !finite(usage.cost_units) ||
    usage.cost_units < 0 ||
    usage.effective_feature_count !==
      request.columns.length - body.dropped_columns.length ||
    (usage.model_version != null &&
      (typeof usage.model_version !== "string" || !usage.model_version)) ||
    [usage.num_cells, usage.num_predictions].some(
      (value) => value != null && !count(value),
    ) ||
    (body.fallback != null && usage.calls !== 0)
  )
    throw bad("usage is missing or invalid");
  return body;
}

export async function postTabular(
  request: TabularRequest,
  correlationId?: string,
  expectedIdentity?: string | null,
): Promise<TabularResult> {
  const ms = timeoutMs();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-deadline-ms": String(Math.max(1_000, ms - DEADLINE_MARGIN_MS)),
  };
  if (correlationId) headers["x-correlation-id"] = correlationId;
  if (expectedIdentity) headers["x-backend-identity"] = expectedIdentity;
  const token = (cds.env.requires as any).tabular?.credentials?.token;
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await send(
    `${baseUrl()}/v1/tabular`,
    { method: "POST", headers, body: JSON.stringify(request) },
    ms,
  );
  const body: any = await response.json().catch(() => null);
  if (!response.ok)
    throw failure(response.status, body, response.headers.get("retry-after"));
  return validate(body, request);
}
