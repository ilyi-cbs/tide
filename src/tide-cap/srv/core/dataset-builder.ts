// Builds a tabular request from DatasetSpec: CAP selects and scopes the data; tabular runs the model.
// Training excludes prediction keys and is reproducibly bounded to the context limit.
import { createHash } from "node:crypto";
import cds from "@sap/cds";
import { AppError } from "./errors";
import type { ColumnKind, Feed, OutputSpec, TabularSpec } from "./feeds";

const { SELECT } = cds.ql;
const LOG = cds.log("dataset");

/** Rows per `key in (...)` lookup, well below SQLite/HANA parameter limits. */
const IN_CHUNK = 500;
export type DatasetRow = Record<string, unknown>;
export const PREDICTION_SOURCE_ROWS = Symbol("predictionSourceRows");

/** Generic prediction endpoints must obey authenticated scope, not user filters. */
function callerScope(feed: Feed, target?: string, predictionLookup = false) {
  const user = cds.context?.user;
  if (user?.is("admin") || user?.is("internal-user")) return null;
  if (!user) return [];
  const scope: Record<string, unknown> = {};
  const columns = new Set(feed.columns.map((column) => column.name));
  // Scope free-text predictions to the routed buyer captured in the originating draft.
  // PurchasingGroup is a model target, not ownership metadata.
  if (
    feed.name === "CockpitFreetextFeed" &&
    predictionLookup &&
    columns.has("routedBuyer")
  )
    scope.routedBuyer = user.id;
  const attributes = user.attr ?? {};
  const grants = attributes.ScopeGrants ?? [
    { Plant: attributes.Plant, PurchasingGroup: attributes.PurchasingGroup },
  ];
  if (!Array.isArray(grants)) return [];
  return grants
    .filter(
      (grant) =>
        grant &&
        typeof grant.Plant === "string" &&
        !!grant.Plant &&
        typeof grant.PurchasingGroup === "string" &&
        !!grant.PurchasingGroup,
    )
    .map((grant) => {
      const pair = { ...scope };
      for (const column of ["Plant", "PurchasingGroup"] as const) {
        if (
          feed.name === "CockpitFreetextFeed" &&
          column === "PurchasingGroup"
        ) {
          const ownerColumn = predictionLookup
            ? "routedGroup"
            : "sourcePurchasingGroup";
          if (!columns.has(ownerColumn)) return {};
          pair[ownerColumn] = grant.PurchasingGroup;
          continue;
        }
        if (column !== target && columns.has(column))
          pair[column] = grant[column];
      }
      return pair;
    })
    .filter((pair) => Object.keys(pair).length > 0);
}

export function applyCallerScope(
  query: any,
  feed: Feed,
  target?: string,
  predictionLookup = false,
) {
  const scope = callerScope(feed, target, predictionLookup);
  if (scope === null) return query;
  if (!scope.length) return query.where({ xpr: [{ val: 1 }, "=", { val: 0 }] });
  return query.where({
    xpr: scope.flatMap((pair, index) => [
      ...(index ? ["or"] : []),
      {
        xpr: Object.entries(pair).flatMap(([column, value], field) => [
          ...(field ? ["and"] : []),
          { ref: [column] },
          "=",
          { val: value },
        ]),
      },
    ]),
  });
}

function scopedRows(
  rows: readonly DatasetRow[],
  feed: Feed,
  target: string,
  predictionLookup = false,
) {
  const scope = callerScope(feed, target, predictionLookup);
  return scope === null
    ? rows
    : rows.filter((row) =>
        scope.some((pair) =>
          Object.entries(pair).every(
            ([column, value]) => row[column] === value,
          ),
        ),
      );
}

function matchesFilter(
  row: DatasetRow,
  clause: TabularSpec["train"]["filter"][number],
) {
  const actual = row[clause.col] ?? null;
  const expected = clause.value;
  if (clause.op === "isNull") return actual === null;
  if (clause.op === "=") return actual === expected;
  if (actual === null || expected === null) return false;
  if (clause.op === "!=") return actual !== expected;
  if (clause.op === "in")
    return Array.isArray(expected) && expected.includes(actual);
  const comparison =
    typeof actual === "number" && typeof expected === "number"
      ? actual - expected
      : typeof actual === "string" && typeof expected === "string"
        ? actual < expected
          ? -1
          : actual > expected
            ? 1
            : 0
        : null;
  if (comparison === null) return false;
  switch (clause.op) {
    case "<":
      return comparison < 0;
    case "<=":
      return comparison <= 0;
    case ">":
      return comparison > 0;
    case ">=":
      return comparison >= 0;
    default:
      throw new AppError(
        "INTERNAL",
        `Unsupported normalized filter ${clause.op}`,
        false,
        500,
      );
  }
}

export type Cell = string | number | boolean | null;

export interface TabularRequest {
  task: TabularSpec["task"];
  mode: "predict" | "dry_run";
  columns: { name: string; kind: ColumnKind }[];
  x_train: Cell[][];
  y_train: (string | number)[];
  keys: string[];
  x_test: Cell[][];
  output: OutputSpec;
}

export interface BuildLimits {
  maxContextRows: number;
  maxClasses: number;
  seed: string;
}

export function buildLimits(): BuildLimits {
  const conf = (cds.env.requires as any).tabular ?? {};
  return {
    maxContextRows: positive(conf.maxContextRows, 10_000),
    maxClasses: positive(conf.maxClasses, 160),
    seed: String(conf.sampleSeed ?? "tide"),
  };
}

function positive(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** CQL condition object for one normalized filter clause (bound values only). */
function condition(clause: TabularSpec["train"]["filter"][number]) {
  const { col, op, value } = clause;
  if (op === "isNull") return { [col]: null };
  if (op === "=") return { [col]: value };
  return { [col]: { [op]: value } };
}

/** Target as sent to tabular, or undefined when the row is not usable. */
function label(value: unknown, task: TabularSpec["task"]) {
  if (value === null || value === undefined || value === "") return undefined;
  if (task === "classification") return String(value);
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function cell(value: unknown, kind: ColumnKind): Cell {
  if (value === null || value === undefined || value === "") return null;
  if (kind === "numeric") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return String(value);
}

/** Stable pseudo-random rank of a key; same seed + key → same sample. */
export function sampleRank(seed: string, key: string): string {
  return createHash("sha256").update(`${seed}:${key}`).digest("hex");
}

/** Keeps the `max` most frequent classes (ties: class name). */
export function topClasses(labels: string[], max: number): Set<string> {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return new Set(
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, max)
      .map(([l]) => l),
  );
}

/** Minimum rows reserved per class during stratified sampling. */
export const MIN_PER_CLASS = 2;

/** Stratified samples reserve MIN_PER_CLASS rows per class when the limit permits. */
export function sampleCandidates<T extends { key: string; y: string | number }>(
  rows: T[],
  max: number,
  seed: string,
  stratified: boolean,
): T[] {
  if (rows.length <= max) return rows;
  const ranked = rows
    .map((c) => ({ c, rank: sampleRank(seed, c.key) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map(({ c }) => c);
  if (!stratified) return ranked.slice(0, max);
  const reserved = new Set<T>();
  const perClass = new Map<string, number>();
  for (const c of ranked) {
    const n = perClass.get(String(c.y)) ?? 0;
    if (n < MIN_PER_CLASS && reserved.size < max) {
      reserved.add(c);
      perClass.set(String(c.y), n + 1);
    }
  }
  for (const c of ranked) {
    if (reserved.size >= max) break;
    reserved.add(c);
  }
  return ranked.filter((c) => reserved.has(c));
}

function chunks<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

async function rowsByKey(
  feed: Feed,
  columns: string[],
  keys: string[],
  target?: string,
  predictionLookup = false,
  sourceRows?: readonly DatasetRow[],
): Promise<Map<string, any>> {
  if (sourceRows) {
    const selected = new Set(keys);
    return new Map(
      scopedRows(sourceRows, feed, target ?? "", predictionLookup)
        .filter((row) => selected.has(String(row[feed.key])))
        .map((row) => [String(row[feed.key]), row]),
    );
  }
  const byKey = new Map<string, any>();
  for (const batch of chunks(keys)) {
    const rows = await applyCallerScope(
      SELECT.from(feed.entity)
        .columns(feed.key, ...columns)
        .where({ [feed.key]: { in: batch } }),
      feed,
      target,
      predictionLookup,
    );
    for (const row of rows) byKey.set(String(row[feed.key]), row);
  }
  return byKey;
}

/** Builds model context without modifying source data. */
export async function buildRequest(
  feed: Feed,
  spec: TabularSpec,
  limits: BuildLimits = buildLimits(),
  sourceRows?: readonly DatasetRow[],
): Promise<TabularRequest> {
  const { target, features, task } = spec;
  const predictKeys = new Set(spec.predict.keys);

  const excludeColumns = [
    ...new Set(spec.train.exclude.map((clause) => clause.col)),
  ];
  let query = SELECT.from(feed.entity)
    .columns(feed.key, target, ...excludeColumns)
    .where({ [target]: { "!=": null } });
  for (const clause of spec.train.filter)
    query = query.where(condition(clause));
  query = applyCallerScope(query, feed, target);
  let candidates: { key: string; y: string | number }[] = [];
  const selected = sourceRows
    ? scopedRows(sourceRows, feed, target).filter((row) =>
        spec.train.filter.every((clause) => matchesFilter(row, clause)),
      )
    : await query;
  for (const row of selected) {
    const key = String(row[feed.key]);
    const y = label(row[target], task);
    const excluded = spec.train.exclude.some((clause) =>
      clause.values.includes(
        cell(row[clause.col], feed.kinds.get(clause.col) ?? "categorical"),
      ),
    );
    if (y !== undefined && !predictKeys.has(key) && !excluded)
      candidates.push({ key, y });
  }

  if (task === "classification") {
    const keep = topClasses(
      candidates.map((c) => String(c.y)),
      limits.maxClasses,
    );
    const dropped = candidates.filter((c) => !keep.has(String(c.y))).length;
    if (dropped)
      LOG.warn(
        `${feed.name}: ${dropped} training rows of rare classes dropped`,
        {
          target,
          maxClasses: limits.maxClasses,
        },
      );
    candidates = candidates.filter((c) => keep.has(String(c.y)));
  }

  if (candidates.length > limits.maxContextRows)
    candidates = sampleCandidates(
      candidates,
      limits.maxContextRows,
      limits.seed,
      task === "classification",
    );
  candidates.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (!candidates.length)
    throw new AppError(
      "NO_TRAINING_DATA",
      `${feed.name}: no training rows with a usable ${target}`,
      false,
      409,
    );

  const kinds = features.map((f) => feed.kinds.get(f) ?? "categorical");
  const toRow = (row: any) => features.map((f, i) => cell(row[f], kinds[i]));
  const train = await rowsByKey(
    feed,
    features,
    candidates.map((c) => c.key),
    target,
    false,
    sourceRows,
  );
  const test = await rowsByKey(
    feed,
    features,
    spec.predict.keys,
    target,
    true,
    sourceRows,
  );
  const missing = spec.predict.keys.filter((k) => !test.has(k));
  if (missing.length)
    throw new AppError(
      "UNKNOWN_KEYS",
      `${feed.name}: ${missing.length} predict keys not found (first: ${missing[0]})`,
      false,
      409,
    );

  const present = candidates.filter((c) => train.has(c.key));
  return {
    task,
    mode: "predict",
    columns: features.map((name, i) => ({ name, kind: kinds[i] })),
    x_train: present.map((c) => toRow(train.get(c.key))),
    y_train: present.map((c) => c.y),
    keys: spec.predict.keys,
    x_test: spec.predict.keys.map((key) =>
      toRow({
        ...test.get(key),
        ...spec.predict.overrides?.[key],
      }),
    ),
    output: spec.output,
  };
}
