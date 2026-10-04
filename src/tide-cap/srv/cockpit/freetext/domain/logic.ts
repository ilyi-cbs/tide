// Free-text coding on purchase requisitions (P-14): pure logic, no CDS.
//
// Segments, context sampling, allowed codes, statuses, Wilson thresholds,
// the threshold simulator, character n-gram TF-IDF similarity, routing to
// buyers (display only) and the code-list rows of the accept action.
import { createHash } from "node:crypto";

export const TEXT = "text";
export const INPUTS = [
  "Plant",
  "PurchasingOrganization",
  "PurchaseOrderType",
  "RequestedQuantity",
  "BaseUnit",
  "CompanyCode",
  "PurchaseRequisitionPrice",
  "PurReqnPriceQuantity",
  "PurReqnItemCurrency",
  "RequestedLeadTimeDays",
  "StorageLocation",
  "itemLongText",
  "headerNote",
  "sourceMaterialGroup",
  "sourcePurchasingGroup",
  "sourceSupplier",
  "sourcePurchasingInfoRecord",
  "sourceAccountAssignmentCategory",
  "sourceItemCategory",
  "accountingContext",
] as const;
export const NUMERIC_INPUTS: ReadonlySet<string> = new Set([
  "RequestedQuantity",
  "PurchaseRequisitionPrice",
  "PurReqnPriceQuantity",
  "RequestedLeadTimeDays",
]);
export const TEXT_INPUTS: ReadonlySet<string> = new Set([
  TEXT,
  "itemLongText",
  "headerNote",
  "accountingContext",
]);
/** Standard enrichment stays on the reliably populated request-code fields. */
export const DEFAULT_FIELDS = ["MaterialGroup", "PurchasingGroup"] as const;
export const FIELDS = [
  "MaterialGroup",
  "PurchasingGroup",
  "Supplier",
  "AccountAssignmentCategory",
  "PurchasingDocumentItemCategory",
  "Material",
  "PurchasingInfoRecord",
] as const;
export type Field = (typeof FIELDS)[number];
export const PREDICTION_FIELDS = FIELDS.filter((field) => field !== "Material");
export interface FieldPolicy {
  property: string;
  state: string;
  reviewOnly: boolean;
  optional?: boolean;
}
export const FIELD_POLICIES: Record<Field, FieldPolicy> = {
  MaterialGroup: {
    property: "MaterialGroup",
    state: "materialGroupState",
    reviewOnly: false,
  },
  PurchasingGroup: {
    property: "reviewedPurchasingGroup",
    state: "purchasingGroupState",
    reviewOnly: false,
  },
  Supplier: { property: "Supplier", state: "supplierState", reviewOnly: false },
  AccountAssignmentCategory: {
    property: "reviewedAccountAssignmentCategory",
    state: "accountAssignmentCategoryState",
    reviewOnly: true,
  },
  PurchasingDocumentItemCategory: {
    property: "reviewedItemCategory",
    state: "itemCategoryState",
    reviewOnly: true,
  },
  Material: {
    property: "reviewedMaterial",
    state: "materialState",
    reviewOnly: true,
    optional: true,
  },
  PurchasingInfoRecord: {
    property: "reviewedPurchasingInfoRecord",
    state: "infoRecordState",
    reviewOnly: true,
    optional: true,
  },
};
/** One-character model label for a legitimate blank category. Null remains unknown. */
export const BLANK_CATEGORY = "-";
export const CATEGORY_FIELDS: ReadonlySet<string> = new Set([
  "AccountAssignmentCategory",
  "PurchasingDocumentItemCategory",
]);
/** Suggestions are applied only to blank fields in an editable buyer draft. */
export const NEVER_AUTOMATIC: ReadonlySet<string> = new Set(
  FIELDS.filter((field) => FIELD_POLICIES[field].reviewOnly),
);
/** Every code field requires a valid calibration before provisional draft prefill. */
export const PREFILL_FIELDS: ReadonlySet<string> = new Set(FIELDS);
export const FIELD_TARGETS: Record<string, number> = {
  PurchasingGroup: 0.95,
  MaterialGroup: 0.98,
  Supplier: 0.95,
  AccountAssignmentCategory: 0.95,
  PurchasingDocumentItemCategory: 0.95,
};
/** Codes a proposal may use: seen in this scope column before (null = unrestricted). */
export const ALLOWED_SCOPE: Record<
  string,
  "Plant" | "PurchasingOrganization" | null
> = {
  PurchasingGroup: "Plant",
  Supplier: "PurchasingOrganization",
  Material: "Plant",
  PurchasingInfoRecord: "PurchasingOrganization",
  MaterialGroup: null,
};

export const CONTEXT_ROWS = 250;
export const CONTEXT_SEED = "1";
export const MAX_CLASSES = 160;
export const MIN_SEGMENT_ROWS = 1_000;
export const MIN_CONTEXT = 5;
export const FIELD_TIMEOUT_MS = 45_000;

export const WILSON_Z_ONE_SIDED = 1.645;
export const WILSON_Z_TWO_SIDED = 1.96;
export const HOLDOUT_SHARE = 0.3;
export const HOLDOUT_MAX = 1_000;
export const MIN_ACCEPT_ROWS = 50;
export const SIM_GRID: number[] = Array.from(
  { length: 71 },
  (_, i) => Math.round((0.3 + i * 0.01) * 100) / 100,
);

export const N_SIMILAR = 5;

export type Status =
  "prefilled" | "review" | "never_automatic" | "no_threshold";

/** One free-text requisition item (open or with known codes). */
export interface FreetextItem {
  PurchaseRequisition: string;
  PurchaseRequisitionItem: string;
  text: string;
  Plant: string | null;
  PurchasingOrganization: string | null;
  PurchaseOrderType: string | null;
  /** YYYY-MM-DD, requisition creation date. */
  date: string;
  /** Date the final PO label became available; absent legacy rows use `date`. */
  labelDate?: string | null;
  MaterialGroup?: string | null;
  PurchasingGroup?: string | null;
  Supplier?: string | null;
  Material?: string | null;
  PurchasingInfoRecord?: string | null;
  AccountAssignmentCategory?: string | null;
  PurchasingDocumentItemCategory?: string | null;
}

export const itemKey = (r: {
  PurchaseRequisition: string;
  PurchaseRequisitionItem: string;
}) => `${r.PurchaseRequisition}/${r.PurchaseRequisitionItem}`;

const blank = (v: unknown) => v === null || v === undefined || v === "";

// ---------------------------------------------------------------- sampling

/** Stable pseudo-random rank of a key; same seed + key → same order. */
export function rank(seed: string, key: string): string {
  return createHash("sha256").update(`${seed}:${key}`).digest("hex");
}

/** Reproducible sample of `n` rows (hash order), returned in input order. */
export function seededSample<T>(
  rows: T[],
  n: number,
  key: (r: T) => string,
  seed = CONTEXT_SEED,
): T[] {
  if (rows.length <= n) return rows;
  const keep = new Set(
    rows
      .map((r, i) => ({ i, k: rank(seed, key(r)) }))
      .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
      .slice(0, n)
      .map((x) => x.i),
  );
  return rows.filter((_, i) => keep.has(i));
}

/** The `max` most frequent labels (ties: label order). */
export function topClasses(labels: string[], max = MAX_CLASSES): Set<string> {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return new Set(
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, max)
      .map(([l]) => l),
  );
}

// ---------------------------------------------------------------- segments

export interface SegmentSets {
  plants: Set<string>;
  orgs: Set<string>;
}

/**
 * Plants with ≥ 1,000 labelled rows form their own segment; purchasing
 * organisations (without those plants) with ≥ 1,000 rows the next level;
 * everything else pools into `global`.
 */
export function segmentSets(
  labelled: FreetextItem[],
  field: string,
  min = MIN_SEGMENT_ROWS,
): SegmentSets {
  const rows = labelled.filter((r) => !blank((r as any)[field]));
  const plantN = count(rows.map((r) => r.Plant ?? ""));
  const plants = new Set(
    [...plantN].filter(([p, n]) => p && n >= min).map(([p]) => p),
  );
  const orgN = count(
    rows
      .filter((r) => !plants.has(r.Plant ?? ""))
      .map((r) => r.PurchasingOrganization ?? ""),
  );
  const orgs = new Set(
    [...orgN].filter(([o, n]) => o && n >= min).map(([o]) => o),
  );
  return { plants, orgs };
}

function count(values: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

export function segmentOf(
  sets: SegmentSets,
  plant: string | null | undefined,
  org: string | null | undefined,
): string {
  if (plant && sets.plants.has(plant)) return `plant:${plant}`;
  if (org && sets.orgs.has(org)) return `org:${org}`;
  return "global";
}

/** Rows of a segment (a row belongs to exactly one segment). */
export function inSegment(
  sets: SegmentSets,
  segment: string,
  r: FreetextItem,
): boolean {
  return segmentOf(sets, r.Plant, r.PurchasingOrganization) === segment;
}

export function segmentsOf(sets: SegmentSets): string[] {
  return [
    ...[...sets.plants].sort().map((p) => `plant:${p}`),
    ...[...sets.orgs].sort().map((o) => `org:${o}`),
    "global",
  ];
}

/** Context of one segment and field: labelled rows, top classes, seeded sample. */
export function segmentContext(
  labelled: FreetextItem[],
  sets: SegmentSets,
  segment: string,
  field: string,
  rows = CONTEXT_ROWS,
): { context: FreetextItem[]; nSegment: number } {
  const seg = labelled.filter(
    (r) => !blank((r as any)[field]) && inSegment(sets, segment, r),
  );
  return { context: contextSample(seg, field, rows), nSegment: seg.length };
}

/** Seeded sample of `rows`, then restricted to the 160 most frequent codes. */
export function contextSample(
  seg: FreetextItem[],
  field: string,
  rows = CONTEXT_ROWS,
): FreetextItem[] {
  const sample = seededSample(seg, rows, itemKey);
  const keep = topClasses(sample.map((r) => String((r as any)[field])));
  return sample.filter((r) => keep.has(String((r as any)[field])));
}

/** Codes seen in the item's scope (null = any code allowed). */
export function allowedCodes(
  labelled: FreetextItem[],
  field: string,
  item: { Plant: string | null; PurchasingOrganization: string | null },
): Set<string> | null {
  const col = ALLOWED_SCOPE[field];
  if (!col) return null;
  const key = item[col];
  if (blank(key)) return null;
  return new Set(
    labelled
      .filter((r) => r[col] === key && !blank((r as any)[field]))
      .map((r) => String((r as any)[field])),
  );
}

/**
 * Zero the codes outside `allowed` without renormalising, so the confidence
 * stays the model's probability. Null when nothing is left.
 */
export function restrictToAllowed(
  classes: string[],
  p: number[],
  allowed: Set<string> | null,
): number[] | null {
  if (!allowed) return p;
  const q = p.map((v, j) => (allowed.has(classes[j]) ? v : 0));
  return Math.max(0, ...q) > 0 ? q : null;
}

// ---------------------------------------------------------------- statuses

export interface ThresholdInfo {
  threshold: number | null;
  /** Holdout accuracy of the rows at or above the threshold. */
  accuracyAtThreshold: number | null;
  valid: boolean;
}

export function status(
  field: string,
  confidence: number | null,
  thr: ThresholdInfo | null | undefined,
): Status {
  if (NEVER_AUTOMATIC.has(field)) return "never_automatic";
  return "review";
}

/** "right in about N of 100": holdout accuracy at the stored threshold. */
export function rightOf100(
  thr: ThresholdInfo | null | undefined,
): number | null {
  if (
    !thr?.valid ||
    thr.accuracyAtThreshold === null ||
    thr.accuracyAtThreshold === undefined
  )
    return null;
  return Math.round(thr.accuracyAtThreshold * 100);
}

export const STATUS_TEXT: Record<Status, string> = {
  prefilled: "Pre-filled",
  review: "To check",
  no_threshold: "To check",
  never_automatic: "You decide",
};

export const FIELD_TEXT: Record<string, string> = {
  MaterialGroup: "Material group",
  PurchasingGroup: "Purchasing group",
  Supplier: "Supplier",
  AccountAssignmentCategory: "Account assignment category",
  PurchasingDocumentItemCategory: "Item category",
  Material: "Material",
  PurchasingInfoRecord: "Purchasing info record",
};

/** Buyer words of one proposal (first view). */
export function proposalWords(p: {
  value: string | null;
  status: string;
  rightOf100?: number | null;
}): string {
  if (p.value === null || p.value === undefined || p.value === "")
    return "no suggestion";
  if (p.status === "never_automatic") return "AI suggestion, you decide";
  if (p.status === "prefilled") {
    if (p.rightOf100 === null || p.rightOf100 === undefined)
      return "AI is sure enough to pre-fill";
    return `AI is sure enough to pre-fill: right in about ${p.rightOf100} of 100 earlier requests in this area`;
  }
  return "AI suggestion, please check";
}

// ---------------------------------------------------------------- proposals

export interface Proposal {
  field: string;
  failed?: boolean;
  backend?: string | null;
  modelVersion?: string | null;
  value: string | null;
  confidence: number | null;
  status: Status;
  rightOf100: number | null;
  source: string;
  segment: string;
  alternatives: { value: string; probability: number }[];
  reason?: string;
}

/** Proposal of one field from the model's probabilities (classes aligned). */
export function proposalFrom(
  field: string,
  classes: string[],
  probabilities: number[] | null,
  allowed: Set<string> | null,
  thr: ThresholdInfo | null,
  segment: string,
  source: string,
): Proposal {
  const base = {
    field,
    segment,
    source,
    rightOf100: null as number | null,
    alternatives: [],
  };
  if (!probabilities)
    return {
      ...base,
      value: null,
      confidence: null,
      status: status(field, null, thr),
      reason: "no answer",
    };
  const p = restrictToAllowed(classes, probabilities, allowed);
  if (!p)
    return {
      ...base,
      value: null,
      confidence: null,
      status: status(field, null, thr),
      reason: "no candidate code was observed in this scope before",
    };
  const order = p
    .map((v, j) => ({ v, j }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v || a.j - b.j);
  const conf = order[0].v;
  const st =
    source === "fallback" && !NEVER_AUTOMATIC.has(field)
      ? "review"
      : status(field, conf, thr);
  return {
    ...base,
    value: classes[order[0].j],
    confidence: conf,
    status: st,
    rightOf100: st === "prefilled" ? rightOf100(thr) : null,
    alternatives: order
      .slice(0, 3)
      .map((x) => ({ value: classes[x.j], probability: x.v })),
  };
}

/** A proposal when the field could not be computed (timeout, no context). */
export function emptyProposal(
  field: string,
  segment: string,
  source: string,
  reason: string,
  thr: ThresholdInfo | null,
): Proposal {
  return {
    field,
    value: null,
    confidence: null,
    status: status(field, null, thr),
    rightOf100: null,
    source,
    segment,
    alternatives: [],
    reason,
  };
}

// ---------------------------------------------------------------- Wilson

export function wilsonLower(
  k: number,
  n: number,
  z = WILSON_Z_ONE_SIDED,
): number {
  if (n <= 0) return 0;
  const p = k / n;
  return (
    (p +
      (z * z) / (2 * n) -
      z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) /
    (1 + (z * z) / n)
  );
}

export function wilsonInterval(
  k: number,
  n: number,
  z = WILSON_Z_TWO_SIDED,
): [number | null, number | null] {
  if (n <= 0) return [null, null];
  const p = k / n;
  const c = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const h =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) /
    (1 + (z * z) / n);
  return [round(c - h, 4), round(c + h, 4)];
}

/**
 * Lowest confidence whose accepted rows (confidence ≥ it) reach `target` on
 * the one-sided Wilson lower bound, with at least `minAccept` rows. Cuts only
 * between distinct confidences (tied rows are accepted together).
 */
export function thresholdWilson(
  conf: number[],
  correct: number[],
  target: number,
  minAccept = MIN_ACCEPT_ROWS,
): number | null {
  const order = conf
    .map((c, i) => ({ c, ok: correct[i] }))
    .sort((a, b) => b.c - a.c);
  let k = 0;
  let best: number | null = null;
  for (let i = 0; i < order.length; i++) {
    k += order[i].ok;
    const n = i + 1;
    const boundary = i === order.length - 1 || order[i + 1].c < order[i].c;
    if (boundary && n >= minAccept && wilsonLower(k, n) >= target)
      best = order[i].c;
  }
  return best;
}

/** Youngest 30 % (max 1,000) as holdout, a 250-row sample of the rest to train. */
export function splitHoldout(
  seg: FreetextItem[],
  rows = CONTEXT_ROWS,
): { train: FreetextItem[]; holdout: FreetextItem[] } | null {
  const d = [...seg].sort(
    (a, b) => cmp(a.date, b.date) || cmp(itemKey(a), itemKey(b)),
  );
  const nHold = Math.min(HOLDOUT_MAX, Math.floor(d.length * HOLDOUT_SHARE));
  if (nHold < MIN_ACCEPT_ROWS) return null;
  const holdout = d.slice(d.length - nHold);
  const firstPredictionDate = holdout[0].date;
  const rest = d
    .slice(0, d.length - nHold)
    .filter((row) => (row.labelDate ?? row.date) < firstPredictionDate);
  if (!rest.length) return null;
  return { train: seededSample(rest, rows, itemKey), holdout };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface AtThreshold {
  threshold: number;
  prefilledShare: number | null;
  accuracy: number | null;
  low: number | null;
  high: number | null;
  n: number;
}

export function atThreshold(
  conf: number[],
  correct: number[],
  t: number,
): AtThreshold {
  let n = 0;
  let k = 0;
  conf.forEach((c, i) => {
    if (c >= t) {
      n++;
      k += correct[i];
    }
  });
  const [low, high] = wilsonInterval(k, n);
  return {
    threshold: round(t, 4),
    prefilledShare: conf.length ? round(n / conf.length, 4) : null,
    accuracy: n ? round(k / n, 4) : null,
    low,
    high,
    n,
  };
}

/** Threshold simulator rows 0.30…1.00; `isStored` on the grid step of the stored threshold. */
export function thresholdCurve(
  conf: number[],
  correct: number[],
  stored: number | null,
) {
  const storedStep =
    stored === null
      ? null
      : Math.min(1, Math.ceil(round(stored * 100, 6)) / 100);
  return SIM_GRID.map((g) => ({
    ...atThreshold(conf, correct, g),
    isStored: storedStep !== null && Math.abs(g - storedStep) < 1e-9,
  }));
}

// ---------------------------------------------------------------- TF-IDF

/** sklearn `analyzer="char_wb"`: n-grams inside space-padded words. */
export function charWbNgrams(text: string, min = 3, max = 5): string[] {
  const out: string[] = [];
  for (const word of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    const w = ` ${word} `;
    for (let n = min; n <= max; n++) {
      let offset = 0;
      out.push(w.slice(offset, offset + n));
      while (offset + n < w.length) {
        offset++;
        out.push(w.slice(offset, offset + n));
      }
      if (offset === 0) break; // a short word counts once
    }
  }
  return out;
}

export interface TfidfModel {
  vocab: Map<string, number>;
  idf: number[];
  vectors: Map<number, number>[];
}

/** TF-IDF like sklearn: min_df 2, smooth idf, sublinear tf, l2 norm. */
export function fitTfidf(texts: string[], minDf = 2): TfidfModel {
  const grams = texts.map((t) => charWbNgrams(t ?? ""));
  const df = new Map<string, number>();
  for (const g of grams)
    for (const x of new Set(g)) df.set(x, (df.get(x) ?? 0) + 1);
  const terms = [...df]
    .filter(([, n]) => n >= minDf)
    .map(([t]) => t)
    .sort();
  const vocab = new Map(terms.map((t, i) => [t, i]));
  const n = texts.length;
  const idf = terms.map((t) => Math.log((1 + n) / (1 + df.get(t)!)) + 1);
  const model: TfidfModel = { vocab, idf, vectors: [] };
  model.vectors = grams.map((g) => vectorOf(model, g));
  return model;
}

function vectorOf(model: TfidfModel, grams: string[]): Map<number, number> {
  const tf = new Map<number, number>();
  for (const g of grams) {
    const j = model.vocab.get(g);
    if (j !== undefined) tf.set(j, (tf.get(j) ?? 0) + 1);
  }
  let norm = 0;
  const v = new Map<number, number>();
  for (const [j, c] of tf) {
    const w = (1 + Math.log(c)) * model.idf[j];
    v.set(j, w);
    norm += w * w;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) for (const [j, w] of v) v.set(j, w / norm);
  return v;
}

export function transform(
  model: TfidfModel,
  text: string,
): Map<number, number> {
  return vectorOf(model, charWbNgrams(text ?? ""));
}

export function cosine(a: Map<number, number>, b: Map<number, number>): number {
  const [s, l] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [j, w] of s) dot += w * (l.get(j) ?? 0);
  return dot;
}

/** Top `n` most similar items by character n-gram TF-IDF (no model). */
export function similarItems<T extends { text: string }>(
  corpus: T[],
  text: string,
  n = N_SIMILAR,
): (T & { similarity: number })[] {
  if (!text || !corpus.length || corpus.every((c) => !c.text)) return [];
  const model = fitTfidf(corpus.map((c) => c.text ?? ""));
  if (!model.vocab.size) return [];
  const q = transform(model, text);
  return corpus
    .map((c, i) => ({ c, i, s: cosine(model.vectors[i], q) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, n)
    .map(({ c, s }) => ({ ...c, similarity: round(s, 3) }));
}

/** "k of n similar items have the same value". */
export function sameValueText(
  similar: Record<string, any>[],
  field: string,
  value: string | null,
): string | null {
  if (value === null || value === undefined || !similar.length) return null;
  const k = similar.filter(
    (s) => String(s[field] ?? "") === String(value),
  ).length;
  return `${k} of ${similar.length} similar items have the same value`;
}

// ---------------------------------------------------------------- routing

export interface RoutingBuyer {
  userId: string;
  PurchasingGroup: string | null;
  Plant?: string | null;
}

export interface RoutingUnit {
  PurchasingOrganization: string;
  Plant: string;
  userId: string;
  PurchasingGroup: string | null;
}

export const ROUTE_MIN_PER_DAY = 5;
export const ROUTE_MAX_PER_DAY = 15;

/** Uniform number in [0, 1) that depends only on the key. */
export function draw(key: string): number {
  return (
    parseInt(createHash("sha256").update(key).digest("hex").slice(0, 12), 16) /
    16 ** 12
  );
}

export function quota(group: string, day: string): number {
  return (
    ROUTE_MIN_PER_DAY +
    Math.floor(
      draw(`${group}:${day}`) * (ROUTE_MAX_PER_DAY - ROUTE_MIN_PER_DAY + 1),
    )
  );
}

/** The working day a request reaches the inbox: weekend dates move to Monday. */
export function inboxDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const wd = d.getUTCDay(); // 0 Sun … 6 Sat
  const add = wd === 6 ? 2 : wd === 0 ? 1 : 0;
  return new Date(d.getTime() + add * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Each (purchasing organisation, plant) unit goes to one buyer: units by
 * volume (largest first), each to the buyer with the least volume so far.
 * The routing never looks at the requisition's own purchasing group.
 */
export function routingTable(
  items: FreetextItem[],
  buyers: RoutingBuyer[],
): RoutingUnit[] {
  if (!buyers.length) return [];
  const units = [
    ...count(
      items.map(
        (r) => `${r.PurchasingOrganization ?? ""}\u0000${r.Plant ?? ""}`,
      ),
    ),
  ]
    .map(([k, n]) => {
      const [org, plant] = k.split("\u0000");
      return { org, plant, n };
    })
    .sort((a, b) => b.n - a.n || cmp(a.plant, b.plant));
  const ordered = [...buyers].sort((a, b) => cmp(a.userId, b.userId));
  const load = new Map(ordered.map((b) => [b.userId, 0]));
  return units.map((u) => {
    let best = ordered[0];
    for (const b of ordered)
      if (load.get(b.userId)! < load.get(best.userId)!) best = b;
    load.set(best.userId, load.get(best.userId)! + u.n);
    return {
      PurchasingOrganization: u.org,
      Plant: u.plant,
      userId: best.userId,
      PurchasingGroup: best.PurchasingGroup ?? null,
    };
  });
}

/**
 * The buyer (purchasing group) that sees each item, or null: per buyer and
 * working day a quota of 5–15 by a hash draw, the first in hash order of the
 * item key.
 */
export function route(
  items: FreetextItem[],
  table: RoutingUnit[],
): Map<string, RoutingUnit | null> {
  const byUnit = new Map(
    table.map((u) => [`${u.PurchasingOrganization}\u0000${u.Plant}`, u]),
  );
  const out = new Map<string, RoutingUnit | null>();
  const groups = new Map<string, { item: FreetextItem; r: number }[]>();
  for (const it of items) {
    const u =
      byUnit.get(`${it.PurchasingOrganization ?? ""}\u0000${it.Plant ?? ""}`) ??
      null;
    out.set(itemKey(it), null);
    if (!u) continue;
    const g = `${u.userId}\u0000${inboxDay(it.date)}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push({ item: it, r: draw(itemKey(it)) });
  }
  for (const [g, list] of groups) {
    const [userId, day] = g.split("\u0000");
    const unit = table.find((u) => u.userId === userId)!;
    const limit = quota(unit.PurchasingGroup ?? userId, day);
    list.sort((a, b) => a.r - b.r);
    list.forEach(({ item }, i) => {
      if (i < limit)
        out.set(
          itemKey(item),
          byUnit.get(
            `${item.PurchasingOrganization ?? ""}\u0000${item.Plant ?? ""}`,
          )!,
        );
    });
  }
  return out;
}

// ---------------------------------------------------------------- finding + action

export const ISSUE = "Codes missing: material group, purchasing group";
export const NEXT_STEP = "Accept confident codes";

export function freetextChain(
  trigger: "morning" | "arrived",
  proposals: Proposal[],
) {
  const n = proposals.filter((p) => p.status === "prefilled").length;
  const plainTrigger =
    trigger === "morning" ? "Checked this morning" : "Checked as it arrived";
  const source = proposals.some((p) => p.source === "tabpfn")
    ? "tabpfn"
    : (proposals[0]?.source ?? "none");
  const words = source === "tabpfn" ? "AI estimate" : "Past requests";
  return {
    chain: `${plainTrigger} → codes proposed from similar requests (${words}) → ${n} of ${proposals.length} codes pre-filled → Next: ${NEXT_STEP.toLowerCase()}`,
    technicalChain:
      `Trigger: ${trigger === "morning" ? "morning run at 06:00" : "arrived during the day"} → ` +
      `Check: codes proposed from similar items (${source}) → ` +
      `Result: ${proposals.map((p) => `${p.field} ${p.value ?? "–"} ${p.confidence ?? "–"} ${p.status}`).join("; ")} → ` +
      `Next: accept confident codes`,
  };
}

export interface CodeListRow {
  PurchaseRequisition: string;
  item: string;
  field: string;
  proposal: string;
  confidence: number | null;
  status: string;
  source: string;
}

/** The confident (prefilled) proposals of the selected items. */
export function codeListRows(
  items: {
    PurchaseRequisition: string;
    PurchaseRequisitionItem: string;
    proposals: Proposal[];
  }[],
): CodeListRow[] {
  return items.flatMap((it) =>
    it.proposals
      .filter((p) => p.status === "prefilled" && p.value !== null)
      .map((p) => ({
        PurchaseRequisition: it.PurchaseRequisition,
        item: it.PurchaseRequisitionItem,
        field: p.field,
        proposal: String(p.value),
        confidence: p.confidence,
        status: p.status,
        source: p.source,
      })),
  );
}

export function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
