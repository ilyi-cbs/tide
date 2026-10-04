// Free-text proposals and calibration over an injected classifier (P-14).
// Pure orchestration: the classifier is the only I/O and is passed in, so the
// CAP wiring (index.ts, calibrate.ts) stays thin and this file is testable.
import {
  allowedCodes,
  CONTEXT_ROWS,
  emptyProposal,
  FIELD_TARGETS,
  FIELD_TIMEOUT_MS,
  type FreetextItem,
  INPUTS,
  NUMERIC_INPUTS,
  TEXT_INPUTS,
  itemKey,
  NEVER_AUTOMATIC,
  type Proposal,
  proposalFrom,
  round,
  segmentContext,
  segmentOf,
  segmentSets,
  segmentsOf,
  splitHoldout,
  type SegmentSets,
  TEXT,
  thresholdWilson,
  type ThresholdInfo,
  topClasses,
} from "./domain/logic";
import { groupBy } from "../kernel/collections";

export type ColumnKind = "categorical" | "text" | "numeric";

export interface ClassifyRequest {
  field: string;
  label: string;
  columns: { name: string; kind: ColumnKind }[];
  /** Training rows (the context), labelled with `field`. */
  train: FreetextItem[];
  /** Rows to classify. */
  test: FreetextItem[];
  deadlineMs: number;
}

export interface ClassifyResult {
  classes: string[];
  backend?: string | null;
  modelVersion?: string | null;
  /** Probabilities per test row key (itemKey), aligned with `classes`. */
  probabilities: Map<string, number[]>;
  /** tabpfn, or fallback when no model call was made. */
  source: string;
}

export type Classify = (req: ClassifyRequest) => Promise<ClassifyResult>;

export interface StoredThreshold {
  field: string;
  segment: string;
  threshold: number | null;
  accuracyAtThreshold: number | null;
  contextRows: number;
}

/** Model inputs of one field: the other inputs plus the text column. */
export function columnsFor(
  field: string,
): { name: string; kind: ColumnKind }[] {
  return [
    ...INPUTS.filter((c) => c !== field).map((name) => ({
      name,
      kind: (NUMERIC_INPUTS.has(name)
        ? "numeric"
        : TEXT_INPUTS.has(name)
          ? "text"
          : "categorical") as ColumnKind,
    })),
    { name: TEXT, kind: "text" as const },
  ];
}

/** Stored threshold → status input; a table for another context size is invalid. */
export function thresholdInfo(
  t: StoredThreshold | undefined,
  contextRows = CONTEXT_ROWS,
): ThresholdInfo | null {
  if (!t) return null;
  return {
    threshold: t.threshold,
    accuracyAtThreshold: t.accuracyAtThreshold,
    valid: t.contextRows === contextRows,
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`no answer within ${Math.round(ms / 1000)} s`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ProposeOptions {
  fields: readonly string[];
  thresholds: StoredThreshold[];
  classify: Classify;
  timeoutMs?: number;
  /** Segment sets per field (computed from `labelled` when absent). */
  sets?: Map<string, SegmentSets>;
}

export interface PlannedCall {
  field: string;
  segment: string;
  train: FreetextItem[];
  test: FreetextItem[];
}

/** One call per segment and field: all open items of a segment share its context. */
export function plan(
  labelled: FreetextItem[],
  open: FreetextItem[],
  fields: readonly string[],
  sets = setsFor(labelled, fields),
): PlannedCall[] {
  const out: PlannedCall[] = [];
  for (const field of fields) {
    const s = sets.get(field)!;
    const bySegment = groupBy(open, (it) =>
      segmentOf(s, it.Plant, it.PurchasingOrganization),
    );
    for (const [segment, test] of [...bySegment].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      const { context } = segmentContext(labelled, s, segment, field);
      out.push({ field, segment, train: context, test });
    }
  }
  return out;
}

export function setsFor(
  labelled: FreetextItem[],
  fields: readonly string[],
): Map<string, SegmentSets> {
  return new Map(fields.map((f) => [f, segmentSets(labelled, f)]));
}

/**
 * Proposals for `open` items: fields in parallel, each call (field and
 * segment) within the timeout; a call that fails or times out gives empty
 * proposals for its items.
 */
export async function propose(
  labelled: FreetextItem[],
  open: FreetextItem[],
  opt: ProposeOptions,
): Promise<Map<string, Proposal[]>> {
  const sets = opt.sets ?? setsFor(labelled, opt.fields);
  const calls = plan(labelled, open, opt.fields, sets);
  const timeout = opt.timeoutMs ?? FIELD_TIMEOUT_MS;
  const byField = new Map<string, Map<string, Proposal>>();
  const thr = new Map(
    opt.thresholds.map((t) => [`${t.field}|${t.segment}`, t]),
  );

  await Promise.all(
    opt.fields.map(async (field) => {
      const out = new Map<string, Proposal>();
      byField.set(field, out);
      for (const c of calls.filter((x) => x.field === field)) {
        const info = thresholdInfo(thr.get(`${field}|${c.segment}`));
        const fail = (reason: string, source = "none") => {
          for (const it of c.test)
            out.set(
              itemKey(it),
              {
                ...emptyProposal(field, c.segment, source, reason, info),
                failed: true,
              },
            );
        };
        const left = timeout;
        let res: ClassifyResult;
        try {
          res = await withTimeout(
            opt.classify({
              field,
              label: `freetext ${field} ${c.segment}`,
              columns: columnsFor(field),
              train: c.train,
              test: c.test,
              deadlineMs: left,
            }),
            left,
          );
        } catch (e: any) {
          fail(String(e?.message ?? e));
          continue;
        }
        if (res.source !== "tabpfn") {
          fail("TabPFN did not return a model prediction", "none");
          continue;
        }
        for (const it of c.test) {
          const allowed = allowedCodes(labelled, field, it);
          out.set(itemKey(it), {
            ...proposalFrom(
              field,
              res.classes,
              res.probabilities.get(itemKey(it)) ?? null,
              allowed,
              info,
              c.segment,
              res.source,
            ),
            backend: res.backend ?? null,
            modelVersion: res.modelVersion ?? null,
          });
        }
      }
    }),
  );
  return new Map(
    open.map((it) => [
      itemKey(it),
      opt.fields.map((f) => byField.get(f)!.get(itemKey(it))!),
    ]),
  );
}

// ---------------------------------------------------------------- calibration

export interface CalibrationRow extends StoredThreshold {
  target: number;
  holdoutRows: number;
  trainRows: number;
  holdoutAccuracy: number | null;
  coverage: number | null;
  /** JSON-able holdout scores for the simulator. */
  conf: number[];
  correct: number[];
  reason?: string;
}

/** Fields that get a threshold (those that may be prefilled). */
export const CALIBRATED_FIELDS = [
  "MaterialGroup",
  "PurchasingGroup",
  "Supplier",
  "AccountAssignmentCategory",
  "PurchasingDocumentItemCategory",
] as const;

export function calibrationJobs(
  labelled: FreetextItem[],
  fields: readonly string[] = CALIBRATED_FIELDS,
) {
  const sets = setsFor(labelled, fields);
  return fields.flatMap((field) =>
    segmentsOf(sets.get(field)!).map((segment) => ({
      field,
      segment,
      sets: sets.get(field)!,
    })),
  );
}

/** One model call per field and segment: holdout scores and the Wilson threshold. */
export async function calibrate(
  labelled: FreetextItem[],
  classify: Classify,
  fields: readonly string[] = CALIBRATED_FIELDS,
  timeoutMs = 10 * FIELD_TIMEOUT_MS,
): Promise<CalibrationRow[]> {
  const out: CalibrationRow[] = [];
  for (const { field, segment, sets } of calibrationJobs(labelled, fields)) {
    const target = FIELD_TARGETS[field] ?? 0.95;
    const base = {
      field,
      segment,
      target,
      contextRows: CONTEXT_ROWS,
      threshold: null,
      accuracyAtThreshold: null,
      conf: [],
      correct: [],
    };
    const seg = labelled.filter(
      (r) =>
        (r as any)[field] &&
        segmentOf(sets, r.Plant, r.PurchasingOrganization) === segment,
    );
    const split = splitHoldout(seg);
    if (!split) {
      out.push({
        ...base,
        holdoutRows: 0,
        trainRows: 0,
        holdoutAccuracy: null,
        coverage: null,
        reason: "holdout too small",
      });
      continue;
    }
    const keep = topClasses(split.train.map((r) => String((r as any)[field])));
    const train = split.train.filter((r) =>
      keep.has(String((r as any)[field])),
    );
    if (keep.size < 2) {
      out.push({
        ...base,
        holdoutRows: split.holdout.length,
        trainRows: train.length,
        holdoutAccuracy: null,
        coverage: null,
        reason: "one class in the training context",
      });
      continue;
    }
    const res = await withTimeout(
      classify({
        field,
        label: `calibrate ${field} ${segment}`,
        columns: columnsFor(field),
        train,
        test: split.holdout,
        deadlineMs: timeoutMs,
      }),
      timeoutMs,
    );
    const conf: number[] = [];
    const correct: number[] = [];
    for (const it of split.holdout) {
      const p = res.probabilities.get(itemKey(it)) ?? [];
      let j = 0;
      for (let i = 1; i < p.length; i++) if (p[i] > p[j]) j = i;
      conf.push(round(p[j] ?? 0, 6));
      correct.push(res.classes[j] === String((it as any)[field]) ? 1 : 0);
    }
    const threshold = thresholdWilson(conf, correct, target);
    const accepted =
      threshold === null
        ? []
        : conf
            .map((c, i) => (c >= threshold ? correct[i] : -1))
            .filter((x) => x >= 0);
    out.push({
      ...base,
      threshold: threshold === null ? null : round(threshold, 4),
      accuracyAtThreshold: accepted.length
        ? round(accepted.reduce((a, b) => a + b, 0) / accepted.length, 4)
        : null,
      holdoutRows: split.holdout.length,
      trainRows: train.length,
      holdoutAccuracy: round(
        correct.reduce((a, b) => a + b, 0) / correct.length,
        4,
      ),
      coverage:
        threshold === null ? 0 : round(accepted.length / conf.length, 4),
      conf,
      correct,
    });
  }
  return out;
}
