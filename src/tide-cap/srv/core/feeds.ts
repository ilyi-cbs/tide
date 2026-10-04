// Feed registry derived from the CDS model: every view annotated @feed is a
// data contract to tabular. Column roles come from @feed.role; no role means
// feature, except the @feed.key column.
import { createHash } from "node:crypto";

export type Role = "key" | "feature" | "target" | "outcome";

export interface FeedColumn {
  name: string;
  type: string;
  role: Role;
}

/** How tabular treats a feature column (`@feed.kind`, else from the type). */
export type ColumnKind = "numeric" | "categorical" | "text";

export type OutputType = "probas" | "point" | "quantiles";
export interface OutputSpec {
  type: OutputType;
  levels?: number[];
}

export interface Feed {
  name: string;
  entity: string;
  sqlName: string;
  description: string | null;
  key: string;
  columns: FeedColumn[];
  /** Kind per column, internal (not part of the public feed contract). */
  kinds: Map<string, ColumnKind>;
  /** 's4' when the feed reads the loaded S/4 dataset (tide.s4.DatasetInfo). */
  dataset: string | null;
}

export interface TabularSpec {
  feed: string;
  target: string;
  features: string[];
  task: "classification" | "regression";
  train: {
    filter: { col: string; op: string; value: unknown }[];
    /** Rows whose value is in an exclusion set never enter model context. */
    exclude: { col: string; values: unknown[] }[];
  };
  predict: {
    keys: string[];
    overrides?: Record<string, Record<string, string | number | boolean | null>>;
  };
  output: OutputSpec;
}

export class SpecError extends Error {}

const OPS = new Set(["=", "!=", "<", "<=", ">", ">=", "in", "isNull"]);
const TASKS = new Set(["classification", "regression"]);
const NUMERIC = /^(U?Int(8|16|32|64)|Integer(64)?|Double|Decimal(Float)?)$/;
export const MAX_PREDICT_KEYS = 10_000;
export const MAX_LEVELS = 99;

export function columnKind(type: string, annotation?: string): ColumnKind {
  if (
    annotation === "text" ||
    annotation === "categorical" ||
    annotation === "numeric"
  )
    return annotation;
  return NUMERIC.test(type) ? "numeric" : "categorical";
}

export function feedRegistry(model: {
  definitions: Record<string, any>;
}): Map<string, Feed> {
  const feeds = new Map<string, Feed>();
  for (const [entity, def] of Object.entries(model.definitions)) {
    if (!def["@feed"] || def.kind !== "entity") continue;
    const key: string | undefined = def["@feed.key"];
    if (!key || !def.elements?.[key])
      throw new Error(`Feed ${entity}: @feed.key must name a column`);
    const columns: FeedColumn[] = [];
    const kinds = new Map<string, ColumnKind>();
    for (const [name, el] of Object.entries<any>(def.elements)) {
      if (el.target || el.elements) continue;
      const role = el["@feed.role"]?.["#"] ?? el["@feed.role"];
      const type = String(el.type ?? "").replace(/^cds\./, "");
      columns.push({
        name,
        type,
        role: name === key ? "key" : (role ?? "feature"),
      });
      kinds.set(
        name,
        columnKind(type, el["@feed.kind"]?.["#"] ?? el["@feed.kind"]),
      );
    }
    const name = entity.split(".").pop()!;
    if (feeds.has(name)) throw new Error(`Duplicate feed name ${name}`);
    feeds.set(name, {
      name,
      entity,
      sqlName: entity.replace(/\./g, "_"),
      description: def.doc ?? def["@description"] ?? null,
      key,
      columns,
      kinds,
      dataset: def["@feed.dataset"] ?? null,
    });
  }
  return feeds;
}

function coerce(value: unknown, col: FeedColumn): unknown {
  if (NUMERIC.test(col.type)) {
    const n = Number(value);
    if (value === null || value === "" || Number.isNaN(n))
      throw new SpecError(
        `Filter value '${value}' is not a number for ${col.name}`,
      );
    return n;
  }
  if (col.type === "Boolean") {
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    throw new SpecError(
      `Filter value '${value}' is not a boolean for ${col.name}`,
    );
  }
  if (value === null || value === undefined)
    throw new SpecError(`Filter on ${col.name} needs a value`);
  return String(value);
}

// Validates a DatasetSpec against the registry and returns the canonical,
// order-independent form sent to tabular (feed = SQL view name).
export function normalizeSpec(
  spec: any,
  feeds: Map<string, Feed>,
): { feed: Feed; spec: TabularSpec } {
  if (!spec || typeof spec !== "object")
    throw new SpecError("spec is required");
  const feed = feeds.get(spec.feed);
  if (!feed) throw new SpecError(`Unknown feed '${spec.feed}'`);
  const columns = new Map(feed.columns.map((c) => [c.name, c]));

  if (columns.get(spec.target)?.role !== "target")
    throw new SpecError(
      `'${spec.target}' is not a target column of ${feed.name}`,
    );
  if (!TASKS.has(spec.task))
    throw new SpecError("task must be 'classification' or 'regression'");

  const features = [...new Set<string>(spec.features ?? [])].sort();
  if (!features.length) throw new SpecError("features must not be empty");
  for (const f of features)
    if (columns.get(f)?.role !== "feature")
      throw new SpecError(`'${f}' is not a feature column of ${feed.name}`);

  const filter = (spec.train?.filter ?? []).map((c: any) => {
    const col = columns.get(c?.col);
    if (!col) throw new SpecError(`Unknown filter column '${c?.col}'`);
    if (!OPS.has(c.op)) throw new SpecError(`Unsupported filter op '${c.op}'`);
    if (c.op === "isNull") return { col: col.name, op: c.op, value: null };
    if (c.op === "in") {
      if (!c.values?.length)
        throw new SpecError(`Filter 'in' on ${col.name} needs values`);
      return {
        col: col.name,
        op: c.op,
        value: c.values.map((v: unknown) => coerce(v, col)),
      };
    }
    return { col: col.name, op: c.op, value: coerce(c.value, col) };
  });
  filter.sort((a: object, b: object) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
  const exclude = (spec.train?.exclude ?? []).map((c: any) => {
    const col = columns.get(c?.col);
    if (!col) throw new SpecError(`Unknown exclusion column '${c?.col}'`);
    if (!c.values?.length)
      throw new SpecError(`Exclusion on ${col.name} needs values`);
    return {
      col: col.name,
      values: [...new Set(c.values.map((v: unknown) => coerce(v, col)))].sort(),
    };
  });
  exclude.sort(
    (a: { col: string; values: unknown[] }, b: { col: string; values: unknown[] }) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );

  const keys = [
    ...new Set<string>((spec.predict?.keys ?? []).map(String)),
  ].sort();
  if (!keys.length) throw new SpecError("predict.keys must not be empty");
  if (keys.length > MAX_PREDICT_KEYS)
    throw new SpecError(`At most ${MAX_PREDICT_KEYS} predict keys are allowed`);

  const overrides: NonNullable<TabularSpec["predict"]["overrides"]> = {};
  if (spec.predict?.overrides !== undefined) {
    if (!spec.predict.overrides || typeof spec.predict.overrides !== "object" || Array.isArray(spec.predict.overrides))
      throw new SpecError("predict.overrides must be an object keyed by prediction row");
    for (const key of Object.keys(spec.predict.overrides).sort()) {
      if (!keys.includes(key)) throw new SpecError(`Override key '${key}' is not a prediction row`);
      const values = spec.predict.overrides[key];
      if (!values || typeof values !== "object" || Array.isArray(values))
        throw new SpecError(`Overrides for '${key}' must be an object`);
      const normalized: Record<string, string | number | boolean | null> = {};
      for (const name of Object.keys(values).sort()) {
        if (!features.includes(name) || !["OrderQuantity", "NetAmountEUR", "RequestedGapDays", "PurchaseOrderMonth"].includes(name))
          throw new SpecError(`'${name}' is not an overridable prediction feature`);
        const value = values[name];
        if (value !== null && !["string", "number", "boolean"].includes(typeof value))
          throw new SpecError(`Override '${name}' must be a scalar or null`);
        const column = columns.get(name)!;
        if (value !== null && NUMERIC.test(column.type) &&
          (typeof value === "boolean" || (typeof value === "string" && !value.trim()) || !Number.isFinite(Number(value))))
          throw new SpecError(`Override '${name}' must be a finite number`);
        normalized[name] = value === null ? null : coerce(value, column) as string | number | boolean;
      }
      overrides[key] = normalized;
    }
  }

  return {
    feed,
    spec: {
      feed: feed.sqlName,
      target: spec.target,
      features,
      task: spec.task,
      train: { filter, exclude },
      predict: { keys, ...(Object.keys(overrides).length ? { overrides } : {}) },
      output: normalizeOutput(spec.output, spec.task),
    },
  };
}

/** Defaults the output to the task's natural type and validates levels. */
export function normalizeOutput(
  output: any,
  task: TabularSpec["task"],
): OutputSpec {
  const type: OutputType =
    output?.type ?? (task === "classification" ? "probas" : "point");
  if (!["probas", "point", "quantiles"].includes(type))
    throw new SpecError(`Unsupported output type '${type}'`);
  if ((type === "probas") !== (task === "classification"))
    throw new SpecError(
      `Output '${type}' does not fit task '${task}' (probas for classification, point or quantiles for regression)`,
    );
  if (type !== "quantiles") {
    if (output?.levels?.length)
      throw new SpecError("levels are only allowed for output 'quantiles'");
    return { type };
  }
  const levels = [...new Set<number>((output.levels ?? []).map(Number))].sort(
    (a, b) => a - b,
  );
  if (!levels.length) throw new SpecError("quantiles need at least one level");
  if (levels.length > MAX_LEVELS)
    throw new SpecError(`At most ${MAX_LEVELS} quantile levels are allowed`);
  if (levels.some((l) => !Number.isFinite(l) || l <= 0 || l >= 1))
    throw new SpecError("quantile levels must lie strictly between 0 and 1");
  return { type, levels };
}

export function specHash(spec: TabularSpec, dataVersion: string): string {
  return createHash("sha256")
    .update(JSON.stringify(spec))
    .update("\n")
    .update(dataVersion)
    .digest("hex");
}

/** Canonical JSON for durable cache identities and auditable input snapshots. */
export function canonicalJson(value: unknown): string {
  const canonical = (item: any): any => {
    if (Array.isArray(item)) return item.map(canonical);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  };
  return JSON.stringify(canonical(value));
}

export function inputFingerprint(input: unknown, backend: string | null, contractVersion: string): string {
  return createHash("sha256")
    .update(canonicalJson({ contractVersion, backend, input }))
    .digest("hex");
}

export function publicFeed({ name, description, key, columns }: Feed) {
  return { name, description, key, columns };
}
